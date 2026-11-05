/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for deduplication (P1-T06, spec §8). The five §12.3 conflict examples are preserved
 * here as fixed cases (they become T10's regression suite).
 */

import assert from 'assert';
import {
	DEFAULT_SIMILARITY_THRESHOLD,
	classifyFact,
	findDedupCandidates,
	normaliseContent
} from '../../ppb/extraction/dedup.js';
import type { MemoryRecord } from '../../ppb/storage/read.js';
import type { MemoryCategory } from '../../ppb/ontology.js';

function memory(id: string, category: MemoryCategory, content: string): MemoryRecord {
	return {
		id,
		projectId: 'projectA',
		category,
		content,
		confidence: 0.9,
		importance: 0.8,
		sourceRef: 'projectA:t1',
		author: 'user',
		extractedAt: '2026-01-01T00:00:00.000Z',
		status: 'active',
		accessCount: 0
	};
}

class FakeReadClient {
	readonly calls: Array<{ text: string; params?: readonly unknown[] }> = [];
	constructor(private readonly _rows: MemoryRecord[]) { }
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, params });
		return {
			rows: this._rows.map(record => ({
				id: record.id, project_id: record.projectId, category: record.category, content: record.content,
				confidence: record.confidence, importance: record.importance, source_ref: record.sourceRef,
				author: record.author, extracted_at: record.extractedAt, status: record.status, access_count: record.accessCount
			}))
		};
	}
}

suite('PPB deduplication (spec §8)', () => {

	test('normalisation is case- and whitespace-insensitive (§8.3)', () => {
		assert.strictEqual(normaliseContent('  We  USE   PostgreSQL '), 'we use postgresql');
	});

	test('identical content is a duplicate, regardless of case/whitespace (§8.3)', () => {
		const decision = classifyFact('WE USE POSTGRESQL', 'technology_stack', [memory('m1', 'technology_stack', 'we use postgresql')]);
		assert.strictEqual(decision.outcome, 'duplicate');
		assert.strictEqual(decision.existingId, 'm1');
	});

	test('a differently-worded but semantically identical fact is a duplicate (§8.4)', () => {
		const decision = classifyFact('Postgres is our primary datastore', 'technology_stack',
			[memory('m1', 'technology_stack', 'We use PostgreSQL for persistence')],
			{ similarity: id => (id === 'm1' ? 0.95 : undefined) });
		assert.strictEqual(decision.outcome, 'duplicate');
		assert.strictEqual(decision.similarity, 0.95);
	});

	test('similarity below the configurable threshold is not a duplicate (§8.4 boundary)', () => {
		const low = classifyFact('Redis handles caching', 'technology_stack',
			[memory('m1', 'technology_stack', 'We use PostgreSQL for persistence')],
			{ similarity: () => DEFAULT_SIMILARITY_THRESHOLD - 0.01 });
		assert.strictEqual(low.outcome, 'new');
	});

	test('an added endpoint is NOT a conflict — it is a non-contradictory update (§12.3 preserved)', () => {
		const decision = classifyFact('We added a new endpoint for password reset', 'architecture_patterns',
			[memory('m1', 'architecture_patterns', 'The API follows a REST pattern')]);
		assert.strictEqual(decision.outcome, 'update');
	});

	test('the four preserved conflict examples are contradictions (§12.3 preserved)', () => {
		const cases: Array<[MemoryCategory, string, string]> = [
			['technology_stack', 'We use MongoDB', 'We switched from MongoDB to PostgreSQL'],          // database change
			['architecture_patterns', 'We use Express', 'We are migrating the framework to Fastify'],   // framework change
			['technology_stack', 'We use Clerk for authentication', 'We are moving from Clerk to Better Auth'], // auth provider
			['technology_stack', 'Hosted on Vercel', 'We moved deployment to AWS']                       // deployment target
		];
		for (const [category, existing, incoming] of cases) {
			const decision = classifyFact(incoming, category, [memory('m1', category, existing)]);
			assert.strictEqual(decision.outcome, 'contradiction', `${incoming} should be a contradiction`);
		}
	});

	test('different knowledge in the same category is new (§8.9)', () => {
		const decision = classifyFact('Redis is used for caching', 'technology_stack',
			[memory('m1', 'technology_stack', 'PostgreSQL is the persistence store')],
			{ similarity: () => 0.4 });
		assert.strictEqual(decision.outcome, 'new');
	});

	test('candidates from other categories are ignored (§8.5/§8.6)', () => {
		const decision = classifyFact('We use PostgreSQL', 'technology_stack',
			[memory('m1', 'constraints', 'we use postgresql')]);
		assert.strictEqual(decision.outcome, 'new', 'cross-category content is never a duplicate');
	});

	test('candidate lookup is project- and category-scoped, active only (§8.2/§8.6)', async () => {
		const client = new FakeReadClient([memory('m1', 'technology_stack', 'PostgreSQL')]);
		const candidates = await findDedupCandidates(client, 'projectA', 'technology_stack');
		assert.strictEqual(candidates.length, 1);
		const call = client.calls[0];
		assert.ok(call.text.includes('project_id = $1'));
		assert.ok(call.text.includes('category = $2'));
		assert.ok(call.text.includes('status = $3'));
		assert.deepStrictEqual(call.params, ['projectA', 'technology_stack', 'active']);
	});
});