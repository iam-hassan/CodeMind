/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live end-to-end Part 1 pipeline test (spec §23.2) — gated by `PPB_TEST_INFRA=1` **and**
 * `PPB_TEST_LLM=1` with a configured `PPB_EXTRACT_MODEL`. Exercises the real provider and the
 * real stack:
 *
 *   segment (IF-1) → extraction (IF-2) → storage/embedding → graph projection
 *   → retrieval request (IF-5) → ranked memories (IF-6)
 *   → reasoning query (IF-8) → grounded answer (IF-9)
 */

import assert from 'assert';
import { loadPpbConfig } from '../../../ppb/config.js';
import { createDecision, recordEvent } from '../../../ppb/decisions/decisionMemory.js';
import { createEmbeddingClient } from '../../../ppb/embeddings/embedder.js';
import { GraphRepository } from '../../../ppb/graph/graphRepo.js';
import { projectOutbox } from '../../../ppb/graph/projector.js';
import { reason } from '../../../ppb/reasoning/reasoner.js';
import { PpbRetriever } from '../../../ppb/retrieval/retriever.js';
import { PpbSegmentSink } from '../../../ppb/sink.js';
import { createNeo4jDriver } from '../../../ppb/storage/neo4j.js';
import { applyPpbMigrations, createPgClient } from '../../../ppb/storage/pg.js';
import { findFacts } from '../../../ppb/storage/read.js';
import type { ConversationSegment } from '../../../orchestration/segmentQueue.js';

const infra = process.env.PPB_TEST_INFRA === '1';
const llm = process.env.PPB_TEST_LLM === '1';
const projectId = 'ppb-live-e2e';

function segment(text: string): ConversationSegment {
	return {
		projectId,
		turnId: `turn-${Date.now()}`,
		role: 'user',
		text,
		intent: 'architecture',
		timestamp: Date.now(),
		editorState: { cwd: 'C:\\proj', openFiles: [], workspaceName: 'proj' }
	};
}

suite('PPB live end-to-end (real provider + stack)', function () {
	setup(function () {
		if (!infra || !llm || (process.env.PPB_EXTRACT_MODEL ?? '').length === 0) {
			this.skip();
		}
	});
	this.timeout(300_000);

	test('segment → facts → ranked memories → grounded historical answer', async () => {
		const config = loadPpbConfig();
		const client = createPgClient(config.pgUrl);
		await client.connect();
		const driver = createNeo4jDriver(config);
		const repo = new GraphRepository(driver);
		try {
			await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
			await applyPpbMigrations(config);
			await client.query("INSERT INTO projects (id, name) VALUES ($1, 'Live E2E')", [projectId]);

			const embedding = createEmbeddingClient(config);

			// 1. IF-1 → IF-2: extract + persist + embed the segment.
			const { PpbExtractor } = await import('../../../ppb/extraction/validate.js');
			const { createExtractionClient } = await import('../../../ppb/llm/client.js');
			const extractor = new PpbExtractor({
				client: createExtractionClient(config.extractBaseUrl, config.extractModel, config.extractApiKey, config.extractTimeoutMs)
			});
			const sink = new PpbSegmentSink({ extractor, write: client, projector: repo, embedder: embedding });
			await sink.ingest([segment('We use PostgreSQL for persistence and we chose Clerk for authentication. We rejected Auth.js because it lacked the features we needed.')]);

			const facts = await findFacts(client, projectId, {});
			assert.ok(facts.length >= 1, 'the live model extracted at least one fact');

			// 2. Decisions/events for the reasoning layer.
			await createDecision(client, {
				projectId, decision: 'Use Clerk for authentication', reason: 'Best developer experience and prebuilt components',
				alternatives: 'Auth.js', rejectedAlternatives: ['Auth.js'], author: 'developer', decidedAt: '2026-01-01T00:00:00.000Z'
			});
			await recordEvent(client, { projectId, eventType: 'changed', description: 'Deployment moved to AWS', occurredAt: '2026-01-31T00:00:00.000Z' });
			const projection = await projectOutbox(client, repo);
			assert.strictEqual(projection.remaining, 0, 'outbox fully projected');

			// 3. IF-5 → IF-6: hybrid retrieval + ranking over the stored facts.
			const retriever = new PpbRetriever({ read: client, graph: repo, embedding });
			const ranked = await retriever.retrieve({ projectId, query: 'PostgreSQL', intent: 'architecture', openFiles: [], recentTurns: [], maxResults: 5, maxTokenBudget: 2000 } as never);
			assert.ok(ranked.length >= 1, 'retrieval returned at least one ranked memory');
			assert.ok(ranked.some(fact => /postgres/i.test(fact.content)), 'the PostgreSQL fact is ranked');

			// 4. IF-8 → IF-9: grounded historical answer with citations.
			const answer = await reason({ read: client, graph: repo }, { projectId, question: 'Why did we choose Clerk for authentication?' });
			assert.strictEqual(answer.status, 'answered');
			assert.ok(answer.citations.some(citation => citation.sourceType === 'decision'), 'the Clerk decision is cited');
			assert.ok(answer.answer.includes('developer experience'));
		} finally {
			const session = driver.session();
			try {
				await session.run('MATCH (n {projectId: $projectId}) DETACH DELETE n', { projectId });
			} finally {
				await session.close();
				await driver.close();
			}
			await client.end();
		}
	});
});