/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the relational read API (IF-11 read half, spec §9.1/§9.5).
 */

import assert from 'assert';
import { ReadError, findFacts, getFact } from '../../ppb/storage/read.js';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'mem-1',
		project_id: 'projectA',
		category: 'technology_stack',
		content: 'PostgreSQL is the persistence store',
		confidence: 0.9,
		importance: 0.8,
		source_ref: 'projectA:turn-1',
		author: 'user',
		extracted_at: '2026-01-01T00:00:00.000Z',
		status: 'active',
		access_count: 3,
		...overrides
	};
}

class FakeReadClient {
	readonly calls: Array<{ text: string; params?: readonly unknown[] }> = [];
	constructor(private readonly _rows: Array<Record<string, unknown>>) { }
	async query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, params });
		return { rows: this._rows };
	}
}

suite('PPB relational read API (IF-11, spec §9.1/§9.5)', () => {

	test('findFacts maps rows to typed records and scopes to the project', async () => {
		const client = new FakeReadClient([row()]);
		const facts = await findFacts(client, 'projectA');
		assert.strictEqual(facts.length, 1);
		const fact = facts[0];
		assert.strictEqual(fact.id, 'mem-1');
		assert.strictEqual(fact.projectId, 'projectA');
		assert.strictEqual(fact.category, 'technology_stack');
		assert.strictEqual(fact.confidence, 0.9);
		assert.strictEqual(fact.status, 'active');
		assert.strictEqual(fact.sourceRef, 'projectA:turn-1');
		assert.ok(client.calls[0].text.includes('project_id = $1'));
		assert.deepStrictEqual(client.calls[0].params, ['projectA']);
	});

	test('null source_ref/author map to undefined', async () => {
		const client = new FakeReadClient([row({ source_ref: null, author: null })]);
		const fact = (await findFacts(client, 'projectA'))[0];
		assert.strictEqual(fact.sourceRef, undefined);
		assert.strictEqual(fact.author, undefined);
	});

	test('category and status filters bind as parameters; the limit is a validated integer', async () => {
		const client = new FakeReadClient([]);
		await findFacts(client, 'projectA', { category: 'constraints', status: 'archived', limit: 25 });
		const call = client.calls[0];
		assert.ok(call.text.includes('category = $2'));
		assert.ok(call.text.includes('status = $3'));
		assert.ok(call.text.includes('LIMIT 25'));
		assert.deepStrictEqual(call.params, ['projectA', 'constraints', 'archived']);
	});

	test('rejects an empty projectId and a bad limit (§6.12)', async () => {
		const client = new FakeReadClient([]);
		await assert.rejects(() => findFacts(client, ''), (error: unknown) => error instanceof ReadError && error.code === 'invalid-project');
		await assert.rejects(() => findFacts(client, 'projectA', { limit: 0 }), (error: unknown) => error instanceof ReadError && error.code === 'invalid-option');
		assert.strictEqual(client.calls.length, 0, 'guards run before any query');
	});

	test('getFact is project-scoped and returns undefined when absent', async () => {
		const present = new FakeReadClient([row()]);
		assert.strictEqual((await getFact(present, 'projectA', 'mem-1'))?.id, 'mem-1');
		assert.ok(present.calls[0].text.includes('project_id = $1 AND id = $2'));
		const absent = new FakeReadClient([]);
		assert.strictEqual(await getFact(absent, 'projectA', 'missing'), undefined);
	});
});