/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { PPB_EMBEDDING_DIM, PPB_EMBEDDING_MODEL } from '../../ppb/config.js';
import { PPB_MIGRATIONS } from '../../ppb/storage/migrations/index.js';
import { rollbackMigrations, runMigrations, type MigrationQueryable } from '../../ppb/storage/migrate.js';

class FakeDb implements MigrationQueryable {

	readonly queries: string[] = [];
	readonly applied: string[] = [];
	private readonly _failOn: string | undefined;

	constructor(applied: string[] = [], failOn?: string) {
		this.applied = [...applied];
		this._failOn = failOn;
	}

	async query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.queries.push(text);
		if (this._failOn && text.includes(this._failOn)) {
			throw new Error('simulated failure');
		}
		if (text.startsWith('SELECT version FROM schema_migrations')) {
			return { rows: this.applied.map(version => ({ version })) };
		}
		if (text.startsWith('INSERT INTO schema_migrations')) {
			this.applied.push(String(params?.[0]));
		}
		if (text.startsWith('DELETE FROM schema_migrations')) {
			const index = this.applied.indexOf(String(params?.[0]));
			if (index >= 0) {
				this.applied.splice(index, 1);
			}
		}
		return { rows: [] };
	}
}

suite('PPB migrations (spec §9)', () => {

	test('registry is ordered, versioned, and every migration has up + down SQL (§9.1/T02)', () => {
		assert.ok(PPB_MIGRATIONS.length >= 1);
		const versions = PPB_MIGRATIONS.map(migration => migration.version);
		assert.deepStrictEqual(versions, [...versions].sort());
		for (const migration of PPB_MIGRATIONS) {
			assert.ok(migration.version.length > 0);
			assert.ok(
				migration.sql.includes('CREATE TABLE') || migration.sql.includes('CREATE EXTENSION') || migration.sql.includes('CREATE INDEX'),
				`up SQL missing for ${migration.version}`
			);
			assert.ok(migration.down.includes('DROP TABLE') || migration.down.includes('DROP INDEX'), `down SQL missing for ${migration.version}`);
		}
	});

	test('core schema, projects, pgvector and seed data are declared (§7/§9/§10/§11/§12/§13/§27)', () => {
		const core = PPB_MIGRATIONS.find(migration => migration.version === '001_init');
		assert.ok(core);
		for (const table of ['projects', 'memories', 'decisions', 'events', 'conflict_reports', 'memory_versions', 'ppb_telemetry']) {
			assert.ok(core.sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `missing table ${table}`);
		}
		assert.ok(core.sql.includes('REFERENCES projects(id)'), 'facts/decisions/events must reference the owning project (§9.1)');
		assert.ok(core.sql.includes("CHECK (status IN ('accepted','rejected','superseded'))"), '§10.2 decision status vocabulary');

		const embeddings = PPB_MIGRATIONS.find(migration => migration.version === '002_embeddings');
		assert.ok(embeddings);
		assert.ok(embeddings.sql.includes('CREATE EXTENSION IF NOT EXISTS vector'));
		assert.ok(embeddings.sql.includes('CREATE TABLE IF NOT EXISTS embeddings'));

		const seed = PPB_MIGRATIONS.find(migration => migration.version === '003_seed_meta');
		assert.ok(seed);
		assert.ok(seed.sql.includes('INSERT INTO ppb_meta'), 'seed data (§9.1)');
		assert.ok(seed.sql.includes('ON CONFLICT (key) DO NOTHING'), 'seed must be idempotent');
	});

	test('runner applies pending migrations and records versions', async () => {
		const db = new FakeDb();
		const result = await runMigrations(db, PPB_MIGRATIONS);
		assert.deepStrictEqual([...result.applied], PPB_MIGRATIONS.map(migration => migration.version));
		assert.deepStrictEqual([...result.skipped], []);
		assert.ok(db.queries.includes('BEGIN'));
		assert.ok(db.queries.includes('COMMIT'));
		assert.deepStrictEqual(db.applied, PPB_MIGRATIONS.map(migration => migration.version));
	});

	test('runner skips already-applied migrations', async () => {
		const db = new FakeDb([PPB_MIGRATIONS[0].version]);
		const result = await runMigrations(db, PPB_MIGRATIONS);
		assert.deepStrictEqual([...result.skipped], [PPB_MIGRATIONS[0].version]);
		assert.deepStrictEqual([...result.applied], PPB_MIGRATIONS.slice(1).map(migration => migration.version));
	});

	test('runner rolls back a failing migration and rethrows', async () => {
		const db = new FakeDb([], 'CREATE EXTENSION');
		await assert.rejects(() => runMigrations(db, PPB_MIGRATIONS));
		assert.strictEqual(db.queries[db.queries.length - 1], 'ROLLBACK');
		assert.strictEqual(db.queries.filter(query => query === 'COMMIT').length, 1);
		assert.ok(!db.applied.includes('002_embeddings'));
	});

	test('rollback reverts every applied migration in reverse order', async () => {
		const all = PPB_MIGRATIONS.map(migration => migration.version);
		const db = new FakeDb(all);
		const result = await rollbackMigrations(db);
		assert.deepStrictEqual([...result.reverted], [...all].reverse());
		assert.deepStrictEqual(db.applied, []);
		assert.ok(db.queries.some(query => query.includes('DROP TABLE')));
	});

	test('rollback to a version keeps that version and everything before it', async () => {
		const all = PPB_MIGRATIONS.map(migration => migration.version);
		const db = new FakeDb(all);
		const result = await rollbackMigrations(db, { toVersion: PPB_MIGRATIONS[0].version });
		assert.deepStrictEqual([...result.reverted], [...all].reverse().slice(0, all.length - 1));
		assert.deepStrictEqual(db.applied, [PPB_MIGRATIONS[0].version]);
	});

	test('rollback failure is transactional and rethrown', async () => {
		const all = PPB_MIGRATIONS.map(migration => migration.version);
		const db = new FakeDb(all, 'DROP TABLE IF EXISTS embeddings');
		await assert.rejects(() => rollbackMigrations(db));
		assert.ok(db.queries.includes('ROLLBACK'));
		assert.ok(db.applied.includes('002_embeddings'), 'a failed revert does not remove its own version');
		assert.ok(!db.applied.includes('003_seed_meta'), 'a version reverted successfully stays reverted');
	});

	test('rollback refuses an unknown target instead of reverting everything (review M9)', async () => {
		const all = PPB_MIGRATIONS.map(migration => migration.version);
		const db = new FakeDb(all);
		await assert.rejects(() => rollbackMigrations(db, { toVersion: '999_nope' }));
		assert.deepStrictEqual(db.applied, all, 'nothing is reverted');
		assert.ok(!db.queries.some(query => query.includes('DROP TABLE')), 'no down SQL runs');
	});

	test('embedding dimension/model come from the config single source (review M11)', () => {
		const embeddings = PPB_MIGRATIONS.find(migration => migration.version === '002_embeddings');
		assert.ok(embeddings?.sql.includes(`vector(${PPB_EMBEDDING_DIM})`), '002 must use PPB_EMBEDDING_DIM');
		const seed = PPB_MIGRATIONS.find(migration => migration.version === '003_seed_meta');
		assert.ok(seed?.sql.includes(`('embedding_model', '${PPB_EMBEDDING_MODEL}')`), 'seed model comes from config');
		assert.ok(seed?.sql.includes(`('embedding_dim', '${PPB_EMBEDDING_DIM}')`), 'seed dim comes from config');
	});

	test('audit-table statuses are CHECK-constrained (review A1)', () => {
		const core = PPB_MIGRATIONS.find(migration => migration.version === '001_init');
		assert.ok(core?.sql.includes("from_status TEXT CHECK (from_status IS NULL OR from_status IN ('active','archived','superseded'))"));
		assert.ok(core?.sql.includes("to_status TEXT NOT NULL CHECK (to_status IN ('active','archived','superseded'))"));
	});
});
