/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for the PPB retriever service (IF-5 → IF-6, spec §15/§16/§24). */

import assert from 'assert';
import type { EmbeddingClient } from '../../ppb/embeddings/embedder.js';
import type { GraphRepository, GraphNode } from '../../ppb/graph/graphRepo.js';
import type { RetrievalRequest } from '../../orchestration/retrievalRequest.js';
import { PpbRetriever } from '../../ppb/retrieval/retriever.js';

function row(id: string, category: string, content: string): Record<string, unknown> {
	return { id, project_id: 'projectA', category, content, confidence: 0.9, importance: 0.8, source_ref: `projectA:${id}`, author: 'user', extracted_at: '2026-01-10T00:00:00.000Z', status: 'active', access_count: 0 };
}

class FakeReadClient {
	constructor(private readonly _memories: Map<string, Record<string, unknown>>, private readonly _vectorMatches: Array<Record<string, unknown>>) { }
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		if (text.includes('<=>')) {
			return { rows: this._vectorMatches };
		}
		if (text.includes('FROM memories WHERE project_id = $1 AND id = $2')) {
			const record = this._memories.get(String(params[1]));
			return { rows: record ? [record] : [] };
		}
		return { rows: [] };
	}
}

const embedding: EmbeddingClient = {
	model: 'test', dimension: 2,
	embed: async () => [[1, 0]]
};

function graph(neighbours: Array<{ id: string }>): GraphRepository {
	return { expandFromSeeds: async () => neighbours as unknown as GraphNode[] } as unknown as GraphRepository;
}

function request(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
	return { projectId: 'projectA', query: 'postgres store', intent: 'architecture', openFiles: [], recentTurns: [], maxResults: 5, maxTokenBudget: 2000, ...overrides };
}

suite('PPB retriever service (IF-5 → IF-6, spec §15/§16/§24)', () => {

	test('returns ranked RetrievedFact records with the mapped category and projectId (IF-6)', async () => {
		const read = new FakeReadClient(
			new Map([['m1', row('m1', 'architecture_patterns', 'The API follows a layered pattern')]]),
			[{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.95 }]
		);
		const retriever = new PpbRetriever({ read, graph: graph([]), embedding });
		const facts = await retriever.retrieve(request());
		assert.strictEqual(facts.length, 1);
		assert.strictEqual(facts[0].id, 'm1');
		assert.strictEqual(facts[0].category, 'pattern', 'architecture_patterns maps to pattern');
		assert.strictEqual(facts[0].projectId, 'projectA');
		assert.ok(facts[0].score >= 0 && facts[0].score <= 1);
		assert.strictEqual(facts[0].sourceRef, 'projectA:m1');
	});

	test('returns an empty list without a project id, never throwing (§24)', async () => {
		const retriever = new PpbRetriever({ read: new FakeReadClient(new Map(), []), graph: graph([]), embedding });
		assert.deepStrictEqual(await retriever.retrieve(request({ projectId: '' })), []);
		assert.deepStrictEqual(await retriever.retrieve({} as RetrievalRequest), []);
	});

	test('an embedding failure degrades to an empty result rather than throwing (§14.8/§24)', async () => {
		const failing: EmbeddingClient = { model: 'x', dimension: 2, embed: async () => { throw new Error('down'); } };
		const retriever = new PpbRetriever({ read: new FakeReadClient(new Map(), []), graph: graph([]), embedding: failing });
		assert.deepStrictEqual(await retriever.retrieve(request()), []);
	});

	test('a repository failure degrades to an empty result rather than throwing (§24)', async () => {
		const brokenGraph = { expandFromSeeds: async () => { throw new Error('neo4j down'); } } as unknown as GraphRepository;
		const read = new FakeReadClient(new Map([['m1', row('m1', 'technology_stack', 'PostgreSQL')]]), [{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.9 }]);
		const retriever = new PpbRetriever({ read, graph: brokenGraph, embedding });
		// The vector path succeeds; graph expansion fails inside hybridRetrieve → caught → [].
		assert.deepStrictEqual(await retriever.retrieve(request()), []);
	});

	test('category projection covers all six knowledge categories', async () => {
		const { CATEGORY_TO_RETRIEVED } = await import('../../ppb/retrieval/retriever.js');
		for (const category of ['technology_stack', 'architecture_patterns', 'business_rules', 'engineering_standards', 'constraints', 'developer_preferences'] as const) {
			assert.ok(['decision', 'pattern', 'fact', 'convention'].includes(CATEGORY_TO_RETRIEVED[category]), category);
		}
	});
});