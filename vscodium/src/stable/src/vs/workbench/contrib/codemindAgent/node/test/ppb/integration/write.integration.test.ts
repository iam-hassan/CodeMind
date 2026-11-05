/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live write-path integration test (P1-T04/T05 persist, spec §9.1/§24).
 * Requires `PPB_TEST_INFRA=1` (live Route A stack) and a clean schema — the test resets it.
 */

import assert from 'assert';
import type { ExtractedFact } from '../../../ppb/extraction/types.js';
import { loadPpbConfig } from '../../../ppb/config.js';
import { GraphRepository } from '../../../ppb/graph/graphRepo.js';
import { projectOutbox } from '../../../ppb/graph/projector.js';
import { createNeo4jDriver } from '../../../ppb/storage/neo4j.js';
import { createPgClient } from '../../../ppb/storage/pg.js';
import { applyPpbMigrations } from '../../../ppb/storage/pg.js';
import { persistFacts } from '../../../ppb/storage/write.js';

const enabled = process.env.PPB_TEST_INFRA === '1';

function fact(category: ExtractedFact['category'], content: string): ExtractedFact {
	return {
		id: 'fact-1',
		category,
		content,
		confidence: 0.9,
		importance: 0.8,
		sourceRef: 'projectA:turn-1',
		author: 'user',
		extractedAt: '2026-01-01T00:00:00.000Z'
	};
}

suite('PPB write path (live)', function () {
	this.timeout(30_000);
	setup(function () {
		if (!enabled) { this.skip(); }
	});

	async function freshSchema() {
		const config = loadPpbConfig();
		const client = createPgClient(config.pgUrl);
		await client.connect();
		try {
			await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
			await applyPpbMigrations(config);
		} finally {
			await client.end();
		}
	}

	test('persisted facts are queryable through IF-11 (§9.1/§24)', async () => {
		await freshSchema();
		const config = loadPpbConfig();
		const client = createPgClient(config.pgUrl);
		await client.connect();
		try {
			await client.query("INSERT INTO projects (id, name) VALUES ('projectA', 'A') ON CONFLICT DO NOTHING");
			const result = await persistFacts(client, 'projectA', [
				fact('technology_stack', 'PostgreSQL is the persistence store'),
				fact('developer_preferences', 'No flashy UI')
			]);
			assert.strictEqual(result.results.length, 2);
			assert.ok(result.results.every(row => row.status === 'inserted'));

			const memories = await client.query(
				"SELECT category, content, status FROM memories WHERE project_id = 'projectA' ORDER BY content"
			);
			assert.strictEqual(memories.rows.length, 2);
			assert.strictEqual(memories.rows[0].content, 'No flashy UI');
			assert.strictEqual(memories.rows[1].content, 'PostgreSQL is the persistence store');

			const versions = await client.query('SELECT COUNT(*) AS n FROM memory_versions');
			assert.strictEqual(Number(versions.rows[0].n), 2, 'one version row per fact');

			const outbox = await client.query("SELECT COUNT(*) AS n FROM neo4j_outbox WHERE processed_at IS NULL");
			assert.strictEqual(Number(outbox.rows[0].n), 2, 'the graph projection is queued, not applied');
		} finally {
			await client.end();
		}
	});

	test('re-persisting the same fact is idempotent (no duplicate memories, §9.1)', async () => {
		await freshSchema();
		const config = loadPpbConfig();
		const client = createPgClient(config.pgUrl);
		await client.connect();
		try {
			await client.query("INSERT INTO projects (id, name) VALUES ('projectA', 'A') ON CONFLICT DO NOTHING");
			await persistFacts(client, 'projectA', [fact('technology_stack', 'PostgreSQL is the persistence store')]);
			await persistFacts(client, 'projectA', [fact('technology_stack', 'PostgreSQL is the persistence store')]);
			const memories = await client.query("SELECT COUNT(*) AS n FROM memories WHERE project_id = 'projectA'");
			assert.strictEqual(Number(memories.rows[0].n), 1);
			const versions = await client.query('SELECT COUNT(*) AS n FROM memory_versions');
			assert.strictEqual(Number(versions.rows[0].n), 2, 'a new version row is appended');
		} finally {
			await client.end();
		}
	});

	test('the outbox is projected to Neo4j and re-projection is idempotent (§24/§9.3)', async () => {
		await freshSchema();
		const config = loadPpbConfig();
		const client = createPgClient(config.pgUrl);
		await client.connect();
		const driver = createNeo4jDriver(config);
		const repo = new GraphRepository(driver);
		try {
			await client.query("INSERT INTO projects (id, name) VALUES ('projectA', 'A') ON CONFLICT DO NOTHING");
			const written = await persistFacts(client, 'projectA', [fact('technology_stack', 'PostgreSQL is the persistence store')]);
			const factId = written.results[0].factId;

			const first = await projectOutbox(client, repo);
			assert.strictEqual(first.projected, 1);
			assert.strictEqual(first.remaining, 0);
			assert.ok(await repo.getNode('projectA', 'Technology', factId), 'the fact is projected as a graph node');

			// Re-queue and project again: the merge is idempotent (no duplicate node).
			await client.query('UPDATE neo4j_outbox SET processed_at = NULL');
			const second = await projectOutbox(client, repo);
			assert.strictEqual(second.projected, 1);
			const nodes = (await repo.findNodes('projectA', 'Technology')).filter(node => node.id === factId);
			assert.strictEqual(nodes.length, 1, 'projection does not duplicate the node');
		} finally {
			const session = driver.session();
			try {
				await session.run('MATCH (n {projectId: $projectId}) DETACH DELETE n', { projectId: 'projectA' });
			} finally {
				await session.close();
				await driver.close();
			}
			await client.end();
		}
	});
});