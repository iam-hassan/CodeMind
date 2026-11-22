/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for the PPB retriever service (IF-5 → IF-6, spec §15/§16/§24). */

import assert from 'assert';
import type { EmbeddingClient } from '../../ppb/embeddings/embedder.js';
import type { GraphRepository, GraphNode } from '../../ppb/graph/graphRepo.js';
import type { RetrievalRequest, RetrievedFact } from '../../orchestration/retrievalRequest.js';
import { PpbRetriever, applyTokenBudget, estimateFactTokens } from '../../ppb/retrieval/retriever.js';
import type { RetrievalCache } from '../../ppb/storage/redis.js';

function row(id: string, category: string, content: string): Record<string, unknown> {
	return { id, project_id: 'projectA', category, content, confidence: 0.9, importance: 0.8, source_ref: `projectA:${id}`, author: 'user', extracted_at: '2026-01-10T00:00:00.000Z', status: 'active', access_count: 0 };
}

class FakeReadClient {
	constructor(private readonly _memories: Map<string, Record<string, unknown>>, private readonly _vectorMatches: Array<Record<string, unknown>>) { }
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		// D55: per-candidate similarity lookup (batched).
		if (text.includes('owner_id = ANY(')) {
			const ids = new Set((params[2] ?? []).map(String));
			return { rows: this._vectorMatches.filter(match => ids.has(String(match.owner_id))) };
		}
		// D54: batched memory load (`getFacts`).
		if (text.includes('id = ANY(')) {
			const ids = (params[1] ?? []).map(String);
			return { rows: ids.map(id => this._memories.get(id)).filter((record): record is Record<string, unknown> => record !== undefined) };
		}
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

	test('enforces maxTokenBudget on the ranked list (§8)', async () => {
		const long = 'x'.repeat(400); // estimate = ceil((400 + 40) / 4) = 110 tokens
		const read = new FakeReadClient(
			new Map([
				['m1', row('m1', 'technology_stack', long)],
				['m2', row('m2', 'technology_stack', long)],
				['m3', row('m3', 'technology_stack', long)]
			]),
			[
				{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.95 },
				{ owner_id: 'm2', owner_kind: 'fact', similarity: 0.94 },
				{ owner_id: 'm3', owner_kind: 'fact', similarity: 0.93 }
			]
		);
		const retriever = new PpbRetriever({ read, graph: graph([]), embedding });

		const facts = await retriever.retrieve(request({ maxTokenBudget: 250 }));

		assert.strictEqual(facts.length, 2, 'two 110-token facts fit in a 250-token budget');
		const used = facts.reduce((total, fact) => total + estimateFactTokens(fact), 0);
		assert.ok(used <= 250, `budget respected (${used}/250)`);
	});

	test('a budget smaller than one fact yields an empty list rather than overrunning', async () => {
		const read = new FakeReadClient(
			new Map([['m1', row('m1', 'technology_stack', 'x'.repeat(400))]]),
			[{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.9 }]
		);
		const retriever = new PpbRetriever({ read, graph: graph([]), embedding });
		assert.deepStrictEqual(await retriever.retrieve(request({ maxTokenBudget: 20 })), []);
	});

	test('applyTokenBudget rejects a non-positive/absent budget as "no budget"', () => {
		const facts: RetrievedFact[] = [
			{ id: 'a', content: 'a'.repeat(400), score: 0.9, category: 'fact', projectId: 'projectA' },
			{ id: 'b', content: 'b'.repeat(400), score: 0.8, category: 'fact', projectId: 'projectA' }
		];
		assert.strictEqual(applyTokenBudget(facts, 0).length, 2);
		assert.strictEqual(applyTokenBudget(facts, undefined).length, 2);
		assert.strictEqual(applyTokenBudget(facts, 'nope').length, 2);
	});

	test('serves a repeated request from the IF-12 cache without re-querying storage', async () => {
		const cache = new FakeCache();
		const base = new FakeReadClient(
			new Map([['m1', row('m1', 'technology_stack', 'PostgreSQL is the store')]]),
			[{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.9 }]
		);
		let queries = 0;
		const read = { query: (text: string, params?: readonly unknown[]) => { queries++; return base.query(text, params); } };
		const retriever = new PpbRetriever({ read, graph: graph([]), embedding, cache });

		const first = await retriever.retrieve(request());
		const queriesAfterMiss = queries;
		const second = await retriever.retrieve(request());

		assert.deepStrictEqual(second, first);
		assert.strictEqual(queries, queriesAfterMiss, 'cache hit must not hit PostgreSQL/vector');
		assert.strictEqual(cache.sets, 1);
		assert.strictEqual(cache.gets, 2);
	});

	test('a cache hit for another project is ignored and the direct query runs (§2)', async () => {
		const cache = new FakeCache();
		cache.poison = [{ id: 'evil', content: 'project B secret', score: 0.99, category: 'fact', projectId: 'projectB' }];
		const read = new FakeReadClient(
			new Map([['m1', row('m1', 'technology_stack', 'PostgreSQL is the store')]]),
			[{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.9 }]
		);
		const retriever = new PpbRetriever({ read, graph: graph([]), embedding, cache });

		const facts = await retriever.retrieve(request());
		assert.deepStrictEqual(facts.map(fact => fact.id), ['m1']);
	});

	test('cache read/write failures never break retrieval (§24)', async () => {
		const cache = new FakeCache();
		cache.throwOnGet = true;
		cache.throwOnSet = true;
		const read = new FakeReadClient(
			new Map([['m1', row('m1', 'technology_stack', 'PostgreSQL is the store')]]),
			[{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.9 }]
		);
		const retriever = new PpbRetriever({ read, graph: graph([]), embedding, cache });

		assert.deepStrictEqual((await retriever.retrieve(request())).map(fact => fact.id), ['m1']);
	});

	test('redacts credential-shaped stored content before it can be injected (§8)', async () => {
		const read = new FakeReadClient(
			new Map([['m1', row('m1', 'technology_stack', 'prod key: sk-abcdefghijklmnopqrstuvwxyz012345')]]),
			[{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.9 }]
		);
		const retriever = new PpbRetriever({ read, graph: graph([]), embedding });
		const facts = await retriever.retrieve(request());
		assert.strictEqual(facts.length, 1);
		assert.ok(!facts[0].content.includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
	});
});

class FakeCache implements RetrievalCache {
	readonly enabled = true;
	readonly store = new Map<string, RetrievedFact[]>();
	gets = 0;
	sets = 0;
	invalidations = 0;
	poison: RetrievedFact[] | undefined;
	throwOnGet = false;
	throwOnSet = false;

	private _key(projectId: string, signature: string): string {
		return `${projectId}:${signature}`;
	}

	async get(projectId: string, signature: string): Promise<RetrievedFact[] | undefined> {
		this.gets++;
		if (this.throwOnGet) {
			throw new Error('cache down');
		}
		return this.poison ?? this.store.get(this._key(projectId, signature));
	}

	async set(projectId: string, signature: string, facts: readonly RetrievedFact[]): Promise<void> {
		this.sets++;
		if (this.throwOnSet) {
			throw new Error('cache down');
		}
		this.store.set(this._key(projectId, signature), [...facts]);
	}

	async invalidate(projectId: string): Promise<void> {
		this.invalidations++;
		for (const key of [...this.store.keys()]) {
			if (key.startsWith(`${projectId}:`)) {
				this.store.delete(key);
			}
		}
	}

	async close(): Promise<void> { /* no-op */ }
}