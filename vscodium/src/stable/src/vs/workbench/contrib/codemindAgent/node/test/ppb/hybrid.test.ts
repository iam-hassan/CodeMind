/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for hybrid retrieval fusion (P1-T08, spec §15). */

import assert from 'assert';
import type { GraphRepository, GraphNode } from '../../ppb/graph/graphRepo.js';
import { hybridRetrieve } from '../../ppb/retrieval/hybrid.js';

function row(id: string, content: string): Record<string, unknown> {
	return { id, project_id: 'projectA', category: 'technology_stack', content, confidence: 0.9, importance: 0.8, source_ref: `projectA:${id}`, author: 'user', extracted_at: '2026-01-01T00:00:00.000Z', status: 'active', access_count: 0 };
}

class FakeReadClient {
	readonly calls: Array<{ text: string; params: readonly unknown[] }> = [];
	constructor(
		private readonly _memories: Map<string, Record<string, unknown>>,
		private readonly _vectorMatches: Array<Record<string, unknown>>
	) { }
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, params });
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

function fakeGraph(neighbours: Array<{ id: string }>): GraphRepository {
	return { expandFromSeeds: async () => neighbours as unknown as GraphNode[] } as unknown as GraphRepository;
}

suite('PPB hybrid retrieval (spec §15)', () => {

	test('vector matches become candidates carrying their similarity (§15.2)', async () => {
		const read = new FakeReadClient(new Map([['m1', row('m1', 'PostgreSQL is the store')]]), [{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.93 }]);
		const candidates = await hybridRetrieve({ read, graph: fakeGraph([]) }, 'projectA', [1, 0]);
		assert.strictEqual(candidates.length, 1);
		assert.strictEqual(candidates[0].fact.id, 'm1');
		assert.strictEqual(candidates[0].similarity, 0.93);
		assert.deepStrictEqual([...candidates[0].sources], ['vector']);
	});

	test('graph expansion adds neighbours and collapses the same memory to one candidate (§15.5/§15.7)', async () => {
		const memories = new Map([['m1', row('m1', 'PostgreSQL is the store')], ['m2', row('m2', 'Module auth-service')]]);
		const read = new FakeReadClient(memories, [{ owner_id: 'm1', owner_kind: 'fact', similarity: 0.9 }]);
		const candidates = await hybridRetrieve({ read, graph: fakeGraph([{ id: 'm1' }, { id: 'm2' }]) }, 'projectA', [1, 0]);
		assert.strictEqual(candidates.length, 2, 'no duplicate for the shared memory');
		const m1 = candidates.find(c => c.fact.id === 'm1')!;
		assert.deepStrictEqual([...m1.sources].sort(), ['graph', 'vector'], 'reached by both paths');
		const m2 = candidates.find(c => c.fact.id === 'm2')!;
		assert.deepStrictEqual([...m2.sources], ['graph']);
	});

	test('without an embedding there are no seeds and the result is empty (§24 graceful)', async () => {
		const read = new FakeReadClient(new Map([['m1', row('m1', 'x')]]), []);
		const candidates = await hybridRetrieve({ read, graph: fakeGraph([{ id: 'm1' }]) }, 'projectA', undefined);
		assert.deepStrictEqual(candidates, []);
	});

	test('rejects a bad maxResults', async () => {
		const read = new FakeReadClient(new Map(), []);
		await assert.rejects(() => hybridRetrieve({ read, graph: fakeGraph([]) }, 'projectA', [1], { maxResults: 0 }));
		assert.strictEqual(read.calls.length, 0);
	});
});