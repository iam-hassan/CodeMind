/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the embedding client and pgvector store (P1-T07, spec §9.2/§14).
 */

import assert from 'assert';
import { PPB_EMBEDDING_DIM } from '../../ppb/config.js';
import { EmbeddingError, OpenAiCompatibleEmbeddingClient } from '../../ppb/embeddings/embedder.js';
import { VectorStoreError, searchFactsByVector, upsertEmbedding } from '../../ppb/embeddings/vectorStore.js';
import type { FetchLike } from '../../ppb/llm/client.js';

function vector(seed = 0): number[] {
	const out = new Array<number>(PPB_EMBEDDING_DIM).fill(0);
	out[seed % PPB_EMBEDDING_DIM] = 1;
	return out;
}

function jsonResponse(payload: unknown, status = 200): { ok: boolean; status: number; json(): Promise<unknown> } {
	return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function clientWith(fetchImpl: FetchLike): OpenAiCompatibleEmbeddingClient {
	return new OpenAiCompatibleEmbeddingClient({ baseUrl: 'http://127.0.0.1:9/v1', model: 'bge-m3', fetchImpl });
}

class FakeSqlClient {
	readonly calls: Array<{ text: string; params: readonly unknown[] }> = [];
	constructor(private readonly _rows: Array<Record<string, unknown>> = []) { }
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, params });
		return { rows: this._rows };
	}
}

suite('PPB embeddings (spec §9.2/§14)', () => {

	test('embeds texts via /embeddings, preserving order and dimension', async () => {
		const calls: Array<{ url: string; body: string }> = [];
		const client = clientWith(async (url, init) => {
			calls.push({ url, body: String(init?.body) });
			return jsonResponse({ data: [{ embedding: vector(0) }, { embedding: vector(1) }] });
		});
		const vectors = await client.embed(['a', 'b']);
		assert.strictEqual(vectors.length, 2);
		assert.strictEqual(vectors[0].length, PPB_EMBEDDING_DIM);
		assert.ok(calls[0].url.endsWith('/embeddings'));
		const body = JSON.parse(calls[0].body);
		assert.strictEqual(body.model, 'bge-m3');
		assert.deepStrictEqual(body.input, ['a', 'b']);
	});

	test('empty input short-circuits without a request', async () => {
		let called = false;
		const client = clientWith(async () => { called = true; return jsonResponse({ data: [] }); });
		assert.deepStrictEqual(await client.embed([]), []);
		assert.strictEqual(called, false);
	});

	test('a dimension mismatch fails loudly (OD-2 pin)', async () => {
		const client = clientWith(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }));
		await assert.rejects(() => client.embed(['x']), (error: unknown) => error instanceof EmbeddingError && error.code === 'dimension-mismatch');
	});

	test('malformed and HTTP-error responses are typed', async () => {
		const malformed = clientWith(async () => jsonResponse({ data: 'nope' }));
		await assert.rejects(() => malformed.embed(['x']), (error: unknown) => error instanceof EmbeddingError && error.code === 'malformed-response');
		const httpError = clientWith(async () => jsonResponse({}, 500));
		await assert.rejects(() => httpError.embed(['x']), (error: unknown) => error instanceof EmbeddingError && error.code === 'http');
	});

	test('upsertEmbedding writes the vector in pgvector literal form with an upsert key', async () => {
		const client = new FakeSqlClient();
		await upsertEmbedding(client, { ownerKind: 'fact', ownerId: 'mem-1', embedding: [1, 0, 0], embeddedText: 'PostgreSQL is the store' });
		const call = client.calls[0];
		assert.ok(call.text.includes('INSERT INTO embeddings'));
		assert.ok(call.text.includes('$3::vector'));
		assert.ok(call.text.includes('ON CONFLICT (owner_kind, owner_id)'));
		assert.deepStrictEqual(call.params, ['fact', 'mem-1', '[1,0,0]', 'PostgreSQL is the store']);
	});

	test('searchFactsByVector is project-scoped, cosine-based, and maps similarity', async () => {
		const client = new FakeSqlClient([
			{ owner_id: 'mem-1', owner_kind: 'fact', similarity: 0.97 },
			{ owner_id: 'mem-2', owner_kind: 'fact', similarity: 0.42 }
		]);
		const matches = await searchFactsByVector(client, 'projectA', [1, 0, 0], 10);
		const call = client.calls[0];
		assert.ok(call.text.includes('m.project_id = $2'), 'project scope joined through memories');
		assert.ok(call.text.includes('<=> $1::vector'), 'cosine distance operator');
		assert.ok(call.text.includes('e.owner_kind = \'fact\''));
		assert.ok(call.text.includes('LIMIT 10'));
		assert.strictEqual(matches[0].ownerId, 'mem-1');
		assert.ok(Math.abs(matches[0].similarity - 0.97) < 1e-9);
	});

	test('searchFactsByVector rejects an empty projectId and a bad limit', async () => {
		const client = new FakeSqlClient();
		await assert.rejects(() => searchFactsByVector(client, '', [0], 5), (error: unknown) => error instanceof VectorStoreError && error.code === 'invalid-project');
		await assert.rejects(() => searchFactsByVector(client, 'projectA', [0], 0), (error: unknown) => error instanceof VectorStoreError && error.code === 'invalid-option');
		assert.strictEqual(client.calls.length, 0);
	});
});