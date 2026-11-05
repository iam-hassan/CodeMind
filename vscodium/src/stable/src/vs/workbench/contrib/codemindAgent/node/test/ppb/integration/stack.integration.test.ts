/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live-stack integration tests (M3) — gated by `PPB_TEST_INFRA=1`.
 *
 * Exercises the real PostgreSQL+pgvector, Neo4j and Redis services brought up by
 * `infra/ppb/docker-compose.yml` (Route A). Skipped silently in normal test runs.
 */

import assert from 'assert';
import { Redis } from 'ioredis';
import { PPB_EMBEDDING_MODEL, loadPpbConfig } from '../../../ppb/config.js';
import { applyPpbMigrations, withPgClient } from '../../../ppb/storage/pg.js';
import { applyGraphConstraints, createNeo4jDriver } from '../../../ppb/storage/neo4j.js';
import { PPB_MIGRATIONS } from '../../../ppb/storage/migrations/index.js';
import { rollbackMigrations } from '../../../ppb/storage/migrate.js';

const enabled = process.env.PPB_TEST_INFRA === '1';
const projectId = `ppb-stack-itest-${Date.now()}`;

suite('PPB stack integration (live services)', function () {

	this.timeout(30_000);

	setup(function () {
		if (!enabled) {
			this.skip();
		}
	});

	teardown(async () => {
		if (!enabled) {
			return;
		}
		const config = loadPpbConfig();
		await withPgClient(config.pgUrl, async client => {
			await client.query('DELETE FROM memories WHERE project_id = $1', [projectId]);
			await client.query('DELETE FROM decisions WHERE project_id = $1', [projectId]);
			await client.query('DELETE FROM events WHERE project_id = $1', [projectId]);
			await client.query('DELETE FROM conflict_reports WHERE project_id = $1', [projectId]);
			await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
		});
	});

	test('migrations apply to the live database and are idempotent (§9, IF-11)', async () => {
		const config = loadPpbConfig();
		const first = await applyPpbMigrations(config);
		assert.strictEqual(first.applied.length + first.skipped.length, PPB_MIGRATIONS.length);
		const versions = [...first.applied, ...first.skipped];
		for (const migration of PPB_MIGRATIONS) {
			assert.ok(versions.includes(migration.version), `missing ${migration.version}`);
		}

		const second = await applyPpbMigrations(config);
		assert.deepStrictEqual([...second.applied], []);
		assert.strictEqual(second.skipped.length, PPB_MIGRATIONS.length);
	});

	test('core schema, projects, pgvector, seed data and decision vocabulary (§7/§9/§10/§11/§12/§13/§27)', async () => {
		const config = loadPpbConfig();
		await applyPpbMigrations(config);
		await withPgClient(config.pgUrl, async client => {
			const tables = (await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
			)).rows.map(row => String(row.table_name));
			for (const expected of ['projects', 'memories', 'decisions', 'events', 'embeddings', 'conflict_reports', 'memory_versions', 'ppb_telemetry', 'ppb_meta', 'schema_migrations']) {
				assert.ok(tables.includes(expected), `missing table ${expected}`);
			}

			const extension = await client.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
			assert.strictEqual(extension.rows.length, 1, 'pgvector extension not installed');

			const column = await client.query(
				`SELECT udt_name FROM information_schema.columns WHERE table_name = 'embeddings' AND column_name = 'embedding'`
			);
			assert.strictEqual(String(column.rows[0].udt_name), 'vector');

			const seed = await client.query(`SELECT value FROM ppb_meta WHERE key = 'embedding_model'`);
			assert.strictEqual(String(seed.rows[0]?.value), PPB_EMBEDDING_MODEL, 'seed data reflects the configured model (§9.1)');
		});
	});

	test('relational integrity: memories must reference an existing project (§9.1)', async () => {
		const config = loadPpbConfig();
		await applyPpbMigrations(config);
		await withPgClient(config.pgUrl, async client => {
			await assert.rejects(() => client.query(
				`INSERT INTO memories (id, project_id, category, content) VALUES (gen_random_uuid(), $1, 'constraints', 'x')`,
				[projectId]
			), 'a unknown project must be rejected by the foreign key');

			await client.query('INSERT INTO projects (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [projectId, 'PPB stack itest']);
			const inserted = await client.query(
				`INSERT INTO memories (id, project_id, category, content) VALUES (gen_random_uuid(), $1, 'constraints', 'x') RETURNING id`,
				[projectId]
			);
			assert.strictEqual(inserted.rows.length, 1);
		});
	});

	test('decision status vocabulary is enforced exactly (§10.2)', async () => {
		const config = loadPpbConfig();
		await applyPpbMigrations(config);
		await withPgClient(config.pgUrl, async client => {
			await client.query('INSERT INTO projects (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [projectId, 'PPB stack itest']);
			const accepted = await client.query(
				`INSERT INTO decisions (id, project_id, decision, status) VALUES (gen_random_uuid(), $1, 'Use Clerk for authentication', 'accepted') RETURNING id`,
				[projectId]
			);
			assert.strictEqual(accepted.rows.length, 1);
			await assert.rejects(() => client.query(
				`INSERT INTO decisions (id, project_id, decision, status) VALUES (gen_random_uuid(), $1, 'Use Clerk', 'active')`,
				[projectId]
			), 'the §13 lifecycle vocabulary is not valid for a decision record');
		});
	});

	test('rollback path reverts cleanly and re-applying restores the schema (§9.1/T02)', async () => {
		const config = loadPpbConfig();
		await applyPpbMigrations(config);
		await withPgClient(config.pgUrl, async client => {
			const rolled = await rollbackMigrations(client, { toVersion: PPB_MIGRATIONS[0].version });
			assert.strictEqual(rolled.reverted.length, PPB_MIGRATIONS.length - 1, 'everything after the core schema is reverted');

			const after = (await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
			)).rows.map(row => String(row.table_name));
			assert.ok(!after.includes('embeddings'), 'embeddings table reverted');
			assert.ok(!after.includes('ppb_meta'), 'seed table reverted');
			assert.ok(after.includes('memories'), 'core schema retained');

			const reapplied = await applyPpbMigrations(config);
			assert.deepStrictEqual([...reapplied.applied].sort(), PPB_MIGRATIONS.slice(1).map(migration => migration.version).sort());

			const restored = (await client.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
			)).rows.map(row => String(row.table_name));
			assert.ok(restored.includes('embeddings') && restored.includes('ppb_meta'), 're-apply restores the schema');
		});
	});

	test('graph constraints apply and enforce uniqueness (§6.5)', async () => {
		const config = loadPpbConfig();
		const driver = createNeo4jDriver(config);
		const marker = `ppb-itest-${Date.now()}`;
		try {
			const statements = await applyGraphConstraints(driver);
			assert.ok(statements.length >= 8, 'expected baseline constraints');

			const session = driver.session();
			try {
				await session.run('CREATE (n:Project {id: $id, projectId: $id})', { id: marker });
				let rejected = false;
				try {
					await session.run('CREATE (n:Project {id: $id, projectId: $id})', { id: marker });
				} catch {
					rejected = true;
				}
				assert.ok(rejected, 'duplicate Project projectId was not rejected by the constraint');
			} finally {
				await session.run('MATCH (n:Project {id: $id}) DETACH DELETE n', { id: marker });
				await session.close();
			}
		} finally {
			await driver.close();
		}
	});

	test('redis is reachable (IF-12 substrate)', async () => {
		const config = loadPpbConfig();
		const client = new Redis(config.redisUrl, {
			lazyConnect: true,
			connectTimeout: 5_000,
			maxRetriesPerRequest: 1
		});
		try {
			await client.connect();
			const pong = await client.ping();
			assert.strictEqual(pong, 'PONG');
		} finally {
			client.disconnect();
		}
	});
});
