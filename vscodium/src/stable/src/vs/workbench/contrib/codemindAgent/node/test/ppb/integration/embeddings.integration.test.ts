/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live pgvector integration test (P1-T07) — gated by `PPB_TEST_INFRA=1`.
 *
 * Uses synthetic vectors (no embedding model required): proves the embeddings table,
 * the HNSW cosine index, and project-scoped similarity search work against the real database.
 */

import assert from 'assert';
import { PPB_EMBEDDING_DIM, loadPpbConfig } from '../../../ppb/config.js';
import { searchFactsByVector, upsertEmbedding } from '../../../ppb/embeddings/vectorStore.js';
import { createPgClient } from '../../../ppb/storage/pg.js';
import { applyPpbMigrations } from '../../../ppb/storage/pg.js';

const enabled = process.env.PPB_TEST_INFRA === '1';

function unit(seed: number): number[] {
	const out = new Array<number>(PPB_EMBEDDING_DIM).fill(0);
	out[seed] = 1;
	return out;
}

suite('PPB embeddings (live pgvector)', function () {
	this.timeout(30_000);
	setup(function () {
		if (!enabled) { this.skip(); }
	});

	test('stores embeddings, exposes the HNSW cosine index, and ranks project-scoped facts', async () => {
		const config = loadPpbConfig();
		const client = createPgClient(config.pgUrl);
		await client.connect();
		try {
			await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
			await applyPpbMigrations(config);
			await client.query("INSERT INTO projects (id, name) VALUES ('projectA', 'A'), ('projectB', 'B')");

			for (const projectId of ['projectA', 'projectB']) {
				const ownerId = projectId === 'projectA' ? '11111111-1111-1111-1111-111111111111' : '22222222-2222-2222-2222-222222222222';
				await client.query(
					`INSERT INTO memories (id, project_id, category, content) VALUES ($1, $2, 'technology_stack', $3)`,
					[ownerId, projectId, `${projectId} memory`]
				);
			}
			const factA = '11111111-1111-1111-1111-111111111111';
			const factB = '22222222-2222-2222-2222-222222222222';
			await upsertEmbedding(client, { ownerKind: 'fact', ownerId: factA, embedding: unit(0), embeddedText: 'A' });
			await upsertEmbedding(client, { ownerKind: 'fact', ownerId: factB, embedding: unit(1), embeddedText: 'B' });

			const index = await client.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'embeddings_embedding_hnsw_idx'`);
			if (PPB_EMBEDDING_DIM <= 2000) {
				assert.strictEqual(index.rows.length, 1, 'the HNSW cosine index exists (OD-1)');
			} else {
				assert.strictEqual(index.rows.length, 0, 'DEV-18: pgvector cannot index >2000 dims, exact search is used');
			}

			const matches = await searchFactsByVector(client, 'projectA', unit(0), 10);
			assert.ok(matches.length >= 1);
			assert.strictEqual(matches[0].ownerId, factA, 'project A ranks its own fact first');
			assert.ok(Math.abs(matches[0].similarity - 1) < 1e-6, 'identical vector scores ~1');
			assert.ok(matches.every(match => match.ownerId !== factB), 'project B facts never leak into A');

			// Re-upserting the same owner is an update, not a duplicate row.
			await upsertEmbedding(client, { ownerKind: 'fact', ownerId: factA, embedding: unit(0), embeddedText: 'A2' });
			const count = await client.query('SELECT COUNT(*) AS n FROM embeddings');
			assert.strictEqual(Number(count.rows[0].n), 2);
		} finally {
			await client.end();
		}
	});
});