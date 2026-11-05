/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live long-term reasoning integration test (P1-T13) — gated by `PPB_TEST_INFRA=1`.
 * Builds the Clerk/Auth.js/Better Auth/AWS fixture in PostgreSQL, projects it to Neo4j, then
 * answers the §17.2 anchor question classes with citations (§17.6/§17.7) and checks isolation.
 */

import assert from 'assert';
import { loadPpbConfig } from '../../../ppb/config.js';
import { createDecision, recordEvent, supersedeDecision } from '../../../ppb/decisions/decisionMemory.js';
import type { ExtractedFact } from '../../../ppb/extraction/types.js';
import { GraphRepository } from '../../../ppb/graph/graphRepo.js';
import { projectOutbox } from '../../../ppb/graph/projector.js';
import { REASONING_INSUFFICIENT_MESSAGE, reason } from '../../../ppb/reasoning/reasoner.js';
import { createNeo4jDriver } from '../../../ppb/storage/neo4j.js';
import { applyPpbMigrations, createPgClient } from '../../../ppb/storage/pg.js';
import { persistFacts } from '../../../ppb/storage/write.js';

const enabled = process.env.PPB_TEST_INFRA === '1';

function fact(content: string): ExtractedFact {
	return {
		id: '00000000-0000-0000-0000-000000000001',
		category: 'technology_stack',
		content,
		confidence: 0.9,
		importance: 0.8,
		sourceRef: 'integration:reasoning',
		author: 'dev',
		extractedAt: '2026-01-15T00:00:00.000Z'
	};
}

suite('PPB long-term reasoning (live)', function () {
	this.timeout(30_000);
	setup(function () {
		if (!enabled) { this.skip(); }
	});

	test('answers the anchor question classes with citations and isolates projects (§17)', async () => {
		const config = loadPpbConfig();
		const client = createPgClient(config.pgUrl);
		await client.connect();
		const driver = createNeo4jDriver(config);
		const repo = new GraphRepository(driver);
		try {
			await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
			await applyPpbMigrations(config);
			await client.query("INSERT INTO projects (id, name) VALUES ('projectA', 'A'), ('projectB', 'B')");

			const clerk = await createDecision(client, {
				projectId: 'projectA', decision: 'Use Clerk for authentication',
				reason: 'Best developer experience and prebuilt components',
				alternatives: 'Auth.js', rejectedAlternatives: ['Auth.js'], author: 'alice', decidedAt: '2026-01-01T00:00:00.000Z'
			});
			await supersedeDecision(client, 'projectA', clerk.id, {
				decision: 'Migrate to Better Auth', reason: 'Lower cost and self-hosting', author: 'bob', decidedAt: '2026-01-24T00:00:00.000Z'
			});
			await createDecision(client, {
				projectId: 'projectA', decision: 'Reject JWT for session management',
				reason: 'Prefer server-side sessions', alternatives: 'JWT', author: 'carol', decidedAt: '2026-01-05T00:00:00.000Z'
			});
			await recordEvent(client, { projectId: 'projectA', eventType: 'migrated', description: 'Migrated database from MongoDB to PostgreSQL', occurredAt: '2026-02-05T00:00:00.000Z' });
			await recordEvent(client, { projectId: 'projectA', eventType: 'changed', description: 'Deployment moved to AWS', occurredAt: '2026-01-31T00:00:00.000Z' });
			await persistFacts(client, 'projectA', [fact('The project uses PostgreSQL as its primary database')]);

			// Project B decoy.
			await createDecision(client, { projectId: 'projectB', decision: 'Use Clerk for authentication', alternatives: 'Auth.js' });
			await recordEvent(client, { projectId: 'projectB', eventType: 'changed', description: 'Deployment moved to GCP' });

			const projection = await projectOutbox(client, repo);
			assert.strictEqual(projection.remaining, 0, 'everything projected');

			const deps = { read: client, graph: repo };

			const current = await reason(deps, { projectId: 'projectA', question: 'What database are we currently using?' });
			assert.strictEqual(current.status, 'answered');
			assert.ok(current.citations.some(citation => citation.content.includes('PostgreSQL')));

			const causal = await reason(deps, { projectId: 'projectA', question: 'Why did we choose Clerk for authentication?' });
			assert.ok(causal.citations.some(citation => citation.id === clerk.id), 'the Clerk decision is cited');
			assert.ok(causal.answer.includes('developer experience'));

			const rejected = await reason(deps, { projectId: 'projectA', question: 'What authentication libraries were evaluated but not selected?' });
			assert.ok(rejected.answer.includes('Auth.js'), 'rejected alternative recovered from the graph');

			const listing = await reason(deps, { projectId: 'projectA', question: 'Show all deployment decisions made since the project started.' });
			assert.ok(listing.citations.some(citation => citation.content.includes('AWS')));

			const insufficient = await reason(deps, { projectId: 'projectA', question: 'Why did we choose Stripe for payments?' });
			assert.strictEqual(insufficient.status, 'insufficient-evidence');
			assert.strictEqual(insufficient.answer, REASONING_INSUFFICIENT_MESSAGE);

			// §17.8/§24 — project scoping.
			const forB = await reason(deps, { projectId: 'projectB', question: 'Show all deployment decisions made since the project started.' });
			assert.ok(forB.citations.every(citation => citation.id !== clerk.id), 'Project A records never leak into Project B');
			assert.ok(forB.citations.some(citation => citation.content.includes('GCP')));
		} finally {
			const session = driver.session();
			try {
				await session.run('MATCH (n) WHERE n.projectId IN [\'projectA\', \'projectB\'] DETACH DELETE n');
			} finally {
				await session.close();
				await driver.close();
			}
			await client.end();
		}
	});
});