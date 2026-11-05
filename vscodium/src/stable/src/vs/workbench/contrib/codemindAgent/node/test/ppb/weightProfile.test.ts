/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for the published ranking weight profile (P1-T14, spec §16.4/§16.7). */

import assert from 'assert';
import type { EmbeddingClient } from '../../ppb/embeddings/embedder.js';
import type { GraphRepository } from '../../ppb/graph/graphRepo.js';
import type { RetrievalRequest } from '../../orchestration/retrievalRequest.js';
import { PpbRetriever } from '../../ppb/retrieval/retriever.js';
import {
	DEFAULT_TOP_K,
	WEIGHT_PROFILE_VERSION,
	WeightProfileError,
	defaultWeightProfile,
	mergeWeightProfile,
	tuneWeights,
	validateWeights
} from '../../ppb/retrieval/weightProfile.js';

function memoryRow(id: string, content: string, importance: number, extractedAt: string): Record<string, unknown> {
	return { id, project_id: 'projectA', category: 'technology_stack', content, confidence: 0.9, importance, source_ref: `projectA:${id}`, author: 'dev', extracted_at: extractedAt, status: 'active', access_count: 0 };
}

class FakeReadClient {
	constructor(private readonly _rows: Map<string, Record<string, unknown>>) { }
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		if (text.includes('<=>')) {
			return { rows: [...this._rows.values()].map((row, index) => ({ owner_id: row.id, owner_kind: 'fact', similarity: 0.9 - index * 0.1 })) };
		}
		if (text.includes('FROM memories WHERE project_id = $1 AND id = $2')) {
			const row = this._rows.get(String(params[1]));
			return { rows: row ? [row] : [] };
		}
		return { rows: [] };
	}
}

const embedding: EmbeddingClient = { model: 'test', dimension: 2, embed: async () => [[1, 0]] };
const graph = { expandFromSeeds: async () => [] } as unknown as GraphRepository;

suite('PPB ranking weight profile (P1-T14, spec §16.7)', () => {

	test('the default profile exposes all seven weights and a version', () => {
		const profile = defaultWeightProfile();
		assert.strictEqual(profile.version, WEIGHT_PROFILE_VERSION);
		assert.strictEqual(profile.topK, DEFAULT_TOP_K);
		for (const signal of ['recency', 'importance', 'frequency', 'currentTask', 'currentFile', 'developerIntent', 'projectModule']) {
			assert.ok(typeof (profile.weights as unknown as Record<string, number>)[signal] === 'number', signal);
		}
	});

	test('mergeWeightProfile applies overrides without mutating the base (§16.4)', () => {
		const base = defaultWeightProfile();
		const tuned = mergeWeightProfile(base, { recency: 0, importance: 5, topK: 3 });
		assert.strictEqual(tuned.weights.recency, 0);
		assert.strictEqual(tuned.weights.importance, 5);
		assert.strictEqual(tuned.topK, 3);
		assert.strictEqual(base.weights.importance, 1, 'base is unchanged');
	});

	test('invalid weights, unknown signals and bad top-k are rejected (§16.4)', () => {
		assert.throws(() => validateWeights({ recency: -1 }), (error: unknown) => error instanceof WeightProfileError);
		assert.throws(() => validateWeights({ recency: Number.NaN }), (error: unknown) => error instanceof WeightProfileError);
		assert.throws(() => validateWeights({ bogus: 1 } as never), (error: unknown) => error instanceof WeightProfileError);
		assert.throws(() => mergeWeightProfile(defaultWeightProfile(), { topK: 0 }), (error: unknown) => error instanceof WeightProfileError);
	});

	test('tuneWeights starts from the defaults', () => {
		const tuned = tuneWeights({ developerIntent: 2 });
		assert.strictEqual(tuned.weights.developerIntent, 2);
		assert.strictEqual(tuned.weights.recency, 1);
	});

	test('a retriever accepts a profile and configureWeights changes the published weights (§16.7)', () => {
		const rows = new Map([
			['m1', memoryRow('m1', 'PostgreSQL is the store', 1, '2026-01-01T00:00:00.000Z')],
			['m2', memoryRow('m2', 'Redis is the cache', 0.1, '2026-01-02T00:00:00.000Z')]
		]);
		const retriever = new PpbRetriever({ read: new FakeReadClient(rows), graph, embedding });
		assert.strictEqual(retriever.weightProfile.version, WEIGHT_PROFILE_VERSION);
		const updated = retriever.configureWeights({ recency: 0, importance: 1, frequency: 0, currentTask: 0, currentFile: 0, developerIntent: 0, projectModule: 0 });
		assert.strictEqual(updated.weights.importance, 1);
		assert.strictEqual(updated.weights.recency, 0);
	});

	test('adjusting the weight profile measurably changes retrieval ordering (§16.7 acceptance)', async () => {
		const rows = new Map([
			['important', memoryRow('important', 'PostgreSQL is the store', 1, '2026-01-01T00:00:00.000Z')],
			['recent', memoryRow('recent', 'Redis is the cache', 0.1, '2026-10-01T00:00:00.000Z')]
		]);
		const retriever = new PpbRetriever({ read: new FakeReadClient(rows), graph, embedding });
		const request: RetrievalRequest = { projectId: 'projectA', query: 'store', intent: 'architecture', openFiles: [], recentTurns: [], maxResults: 5, maxTokenBudget: 2000 };

		retriever.configureWeights({ recency: 0, importance: 1, frequency: 0, currentTask: 0, currentFile: 0, developerIntent: 0, projectModule: 0 });
		const byImportance = await retriever.retrieve(request);
		assert.strictEqual(byImportance[0].id, 'important');

		retriever.configureWeights({ recency: 1, importance: 0, frequency: 0, currentTask: 0, currentFile: 0, developerIntent: 0, projectModule: 0 });
		const byRecency = await retriever.retrieve(request);
		assert.strictEqual(byRecency[0].id, 'recent', 'the tunable profile changes which memory ranks first');
	});
});