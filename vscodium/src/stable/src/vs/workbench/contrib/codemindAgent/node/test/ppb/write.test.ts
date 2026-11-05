/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the write path (P1-T04/T05 persist, spec §9.1/§24).
 * Transaction-free: an in-memory `pg`-like fake with `query()` recording calls.
 */

import assert from 'assert';
import type { ExtractedFact } from '../../ppb/extraction/types.js';
import { PersistenceError, persistFacts } from '../../ppb/storage/write.js';

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

class FakeQueryClient {
	readonly calls: Array<{ text: string; values: unknown[] }> = [];
	readonly rowsByQuery: Map<string, Array<Record<string, unknown>>> = new Map();
	constructor(rows: Array<Record<string, unknown>> = []) {
		this.rowsByQuery.set('default', rows);
	}
	async query(text: string, values: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, values: [...values] });
		// The existence check (SELECT … WHERE content = $3) is the only read; everything else is write.
		if (text.includes('SELECT id FROM memories WHERE project_id')) {
			return { rows: this.rowsByQuery.get('default') ?? [] };
		}
		return { rows: [] };
	}
}

suite('PPB write path (spec §9.1/§24)', () => {

	test('a new fact inserts memory + version + outbox row (§9.1/§24)', async () => {
		const client = new FakeQueryClient();
		const result = await persistFacts(client, 'projectA', [fact('technology_stack', 'PostgreSQL is the persistence store')]);
		assert.strictEqual(result.projectId, 'projectA');
		assert.strictEqual(result.results.length, 1);
		assert.strictEqual(result.results[0].status, 'inserted');
		assert.match(result.results[0].factId, /^[0-9a-f-]{36}$/);
		const queries = client.calls.map(call => call.text);
		assert.ok(queries.some(text => text.includes('INSERT INTO memories')));
		assert.ok(queries.some(text => text.includes('INSERT INTO memory_versions')));
		assert.ok(queries.some(text => text.includes('INSERT INTO neo4j_outbox')));
	});

	test('an identical fact updates the memory and adds a version row (§9.1)', async () => {
		const client = new FakeQueryClient([{ id: 'mem-1' }]);
		const result = await persistFacts(client, 'projectA', [fact('technology_stack', 'PostgreSQL is the persistence store')]);
		assert.strictEqual(result.results[0].status, 'updated');
		assert.strictEqual(result.results[0].factId, 'mem-1');
		const queries = client.calls.map(call => call.text);
		assert.ok(queries.some(text => text.includes('INSERT INTO memory_versions')));
		assert.ok(queries.some(text => text.includes('UPDATE memories SET confidence')));
		assert.ok(!queries.some(text => text.includes('INSERT INTO memories')));
		assert.ok(!queries.some(text => text.includes('INSERT INTO neo4j_outbox')), 'no graph projection on update');
	});

	test('the whole batch is atomic — a failure rolls back everything (§24)', async () => {
		const client = new FakeQueryClient();
		client.rowsByQuery.set('default', [{ id: 'mem-1' }]);
// Force the UPDATE to fail by injecting a syntax error mid-batch.
		const orig = client.query.bind(client);
		client.query = async (text: string, values: readonly unknown[] = []) => {
			if (text.startsWith('UPDATE memories')) {
				throw new Error('SQL error');
			}
			return orig(text, values);
		};
		await assert.rejects(() => persistFacts(client, 'projectA', [fact('technology_stack', 'PostgreSQL is the persistence store')]), PersistenceError);
		assert.ok(client.calls.some(call => call.text.includes('ROLLBACK')), 'the transaction must roll back');
	});

	test('empty input yields an empty result, no queries (§24)', async () => {
		const client = new FakeQueryClient();
		const result = await persistFacts(client, 'projectA', []);
		assert.deepStrictEqual([...result.results], []);
		assert.strictEqual(client.calls.length, 0);
	});

	test('category and confidence are bound as parameters, never interpolated (§9.5)', async () => {
		const client = new FakeQueryClient();
		await persistFacts(client, 'projectA', [fact('developer_preferences', 'No flashy UI')]);
		const insert = client.calls.find(call => call.text.includes('INSERT INTO memories'));
		assert.ok(insert);
		assert.strictEqual(insert!.values[1], 'projectA');
		assert.strictEqual(insert!.values[2], 'developer_preferences');
		assert.strictEqual(insert!.values[4], 0.9);
		assert.strictEqual(insert!.values[5], 0.8);
		assert.ok(!insert!.text.includes('developer_preferences'), 'no literal interpolation');
	});
});