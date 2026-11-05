/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for the seven-signal ranking engine (P1-T09, spec §16). */

import assert from 'assert';
import type { RetrievalCandidate } from '../../ppb/retrieval/hybrid.js';
import { DEFAULT_RANKING_WEIGHTS, computeSignals, rank } from '../../ppb/retrieval/ranker.js';
import type { MemoryRecord } from '../../ppb/storage/read.js';
import type { MemoryCategory } from '../../ppb/ontology.js';

function record(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
	return {
		id: overrides.id,
		projectId: overrides.projectId ?? 'projectA',
		category: (overrides.category ?? 'technology_stack') as MemoryCategory,
		content: overrides.content ?? 'PostgreSQL is the persistence store',
		confidence: overrides.confidence ?? 0.9,
		importance: overrides.importance ?? 0.5,
		sourceRef: overrides.sourceRef,
		author: overrides.author,
		extractedAt: overrides.extractedAt ?? '2026-01-01T00:00:00.000Z',
		status: overrides.status ?? 'active',
		accessCount: overrides.accessCount ?? 0
	};
}

function candidate(overrides: Partial<MemoryRecord> & { id: string }): RetrievalCandidate {
	return { fact: record(overrides), sources: ['vector'] };
}

const NOW = () => new Date('2026-01-11T00:00:00.000Z'); // 10 days after the fixtures

suite('PPB memory ranking (spec §16)', () => {

	test('all seven signals are produced and normalized to [0,1] (§16.2/§16.3)', () => {
		const signals = computeSignals(candidate({ id: 'm1' }), { intent: 'architecture', currentTask: 'postgres', openFiles: ['store.ts'], projectModule: 'persistence' }, NOW());
		for (const key of Object.keys(DEFAULT_RANKING_WEIGHTS) as Array<keyof typeof DEFAULT_RANKING_WEIGHTS>) {
			assert.ok(signals[key] >= 0 && signals[key] <= 1, `${key} in range`);
		}
		assert.ok(signals.recency > 0, 'fresh-ish memory has recency');
		assert.strictEqual(signals.developerIntent, 1, 'architecture intent matches technology_stack');
		assert.ok(signals.currentTask > 0, 'query token overlap');
	});

	test('a more recent memory outranks an older one, all else equal (§16.2 recency)', () => {
		const recent = candidate({ id: 'recent', extractedAt: '2026-01-10T00:00:00.000Z' });
		const old = candidate({ id: 'old', extractedAt: '2025-01-01T00:00:00.000Z' });
		const ranked = rank([old, recent], { now: NOW });
		assert.strictEqual(ranked[0].fact.id, 'recent');
	});

	test('importance and frequency influence ordering, and weights change the outcome (§16.4)', () => {
		const important = candidate({ id: 'imp', importance: 1 });
		const frequent = candidate({ id: 'freq', importance: 0.1, accessCount: 10 });
		const byImportance = rank([frequent, important], { now: NOW }, { weights: { recency: 0, importance: 10, frequency: 0 } });
		assert.strictEqual(byImportance[0].fact.id, 'imp');
		const byFrequency = rank([frequent, important], { now: NOW }, { weights: { recency: 0, importance: 0, frequency: 10 } });
		assert.strictEqual(byFrequency[0].fact.id, 'freq', 'the configurable weight profile changes ordering');
	});

	test('top-k selection returns the correct count in score order (§16.6)', () => {
		const ranked = rank([candidate({ id: 'a', importance: 0.1 }), candidate({ id: 'b', importance: 0.9 }), candidate({ id: 'c', importance: 0.5 })], { now: NOW }, { topK: 2 });
		assert.strictEqual(ranked.length, 2);
		assert.strictEqual(ranked[0].fact.id, 'b');
		assert.ok(ranked[0].score >= ranked[1].score);
	});

	test('missing context signals degrade gracefully rather than throwing (§16.5)', () => {
		const ranked = rank([candidate({ id: 'a' })], {}, {});
		assert.strictEqual(ranked.length, 1);
		assert.strictEqual(ranked[0].signals.currentTask, 0);
		assert.strictEqual(ranked[0].signals.currentFile, 0);
		assert.strictEqual(ranked[0].signals.developerIntent, 0);
	});

	test('ties break on recency then id, deterministically (§16.5)', () => {
		const a = candidate({ id: 'aaa', extractedAt: '2026-01-10T00:00:00.000Z', importance: 0.5 });
		const b = candidate({ id: 'bbb', extractedAt: '2026-01-10T00:00:00.000Z', importance: 0.5 });
		const ranked = rank([b, a], { now: NOW });
		assert.strictEqual(ranked[0].fact.id, 'aaa');
	});

	test('the score stays within [0,1] (§16.4)', () => {
		const ranked = rank([candidate({ id: 'a', importance: 1, accessCount: 10 })], { intent: 'architecture' }, {});
		assert.ok(ranked[0].score >= 0 && ranked[0].score <= 1);
	});
});