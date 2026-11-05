/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for extraction (P1-T04/T05, spec §7). Network-free: a fake LlmClient supplies
 * canned responses. The live-model path is covered by integration/extraction.integration.test.ts.
 */

import assert from 'assert';
import type { ConversationSegment } from '../../orchestration/segmentQueue.js';
import { MEMORY_CATEGORIES } from '../../ppb/ontology.js';
import {
	EXTRACTION_CATEGORIES,
	EXTRACTION_JSON_SCHEMA,
	EXTRACTION_SYSTEM_PROMPT,
	buildExtractionUserPrompt
} from '../../ppb/extraction/extractor.js';
import {
	ExtractionValidationError,
	PpbExtractor,
	parseExtractionPayload
} from '../../ppb/extraction/validate.js';
import type { LlmChatRequest, LlmChatResult, LlmClient } from '../../ppb/llm/client.js';

function segment(text: string, role: 'user' | 'assistant' = 'user'): ConversationSegment {
	return {
		projectId: 'projectA',
		turnId: 'turn-1',
		role,
		text,
		intent: 'architecture',
		timestamp: Date.now(),
		editorState: { cwd: 'C:\\proj', openFiles: [], workspaceName: 'proj' }
	};
}

class FakeClient implements LlmClient {
	readonly model = 'fake-model';
	readonly calls: LlmChatRequest[] = [];
	constructor(private readonly _responses: Array<string | Error>) { }
	async chat(request: LlmChatRequest): Promise<LlmChatResult> {
		this.calls.push(request);
		const next = this._responses.shift();
		if (next === undefined) { throw new Error('no canned response left'); }
		if (next instanceof Error) { throw next; }
		return { text: next };
	}
}

const validJson = JSON.stringify({
	facts: [{ category: 'technology_stack', content: 'The project uses PostgreSQL for persistence.', confidence: 0.9, importance: 0.8 }]
});
const emptyJson = JSON.stringify({ facts: [] });

suite('PPB extraction (spec §7)', () => {

	test('the schema and prompt cover exactly the six categories (§7.4)', () => {
		assert.deepStrictEqual([...EXTRACTION_CATEGORIES], [...MEMORY_CATEGORIES]);
		const items = (EXTRACTION_JSON_SCHEMA as unknown as { properties: { facts: { items: { properties: { category: { enum: string[] } } } } } }).properties.facts.items;
		assert.deepStrictEqual([...items.properties.category.enum], [...MEMORY_CATEGORIES]);
		for (const category of MEMORY_CATEGORIES) {
			assert.ok(EXTRACTION_SYSTEM_PROMPT.includes(category), `prompt must name ${category}`);
		}
	});

	test('the user prompt carries the segment text and its source identity (§7.2)', () => {
		const prompt = buildExtractionUserPrompt(segment('We use Clerk for auth.'));
		assert.ok(prompt.includes('We use Clerk for auth.'));
		assert.ok(prompt.includes('projectA'));
		assert.ok(prompt.includes('turn-1'));
	});

	test('valid output yields facts with the complete §7.5 metadata (T05)', async () => {
		const client = new FakeClient([validJson]);
		const extractor = new PpbExtractor({
			client,
			policy: { maxAttempts: 1, backoffMs: 0 },
			now: () => new Date('2026-01-01T00:00:00.000Z')
		});
		const result = await extractor.extract(segment('We use PostgreSQL.'));
		assert.strictEqual(result.segmentId, 'turn-1');
		assert.strictEqual(result.facts.length, 1);
		const fact = result.facts[0];
		assert.strictEqual(fact.category, 'technology_stack');
		assert.strictEqual(fact.sourceRef, 'projectA:turn-1');
		assert.strictEqual(fact.author, 'user');
		assert.strictEqual(fact.extractedAt, '2026-01-01T00:00:00.000Z');
		assert.match(fact.id, /^[0-9a-f-]{36}$/);
		assert.strictEqual(fact.confidence, 0.9);
		assert.strictEqual(fact.importance, 0.8);
	});

	test('the model call is deterministic (temperature 0)', async () => {
		const client = new FakeClient([emptyJson]);
		await new PpbExtractor({ client, policy: { maxAttempts: 1, backoffMs: 0 } }).extract(segment('x'));
		assert.strictEqual(client.calls[0].temperature, 0);
	});

	test('non-engineering content yields zero facts (§7.6 / acceptance #2)', async () => {
		const extractor = new PpbExtractor({ client: new FakeClient([emptyJson]), policy: { maxAttempts: 1, backoffMs: 0 } });
		const result = await extractor.extract(segment('hey, thanks! looks great :)'));
		assert.deepStrictEqual([...result.facts], []);
	});

	test('missing confidence/importance fall back to the documented placeholder defaults (§7.5/§32)', async () => {
		const response = JSON.stringify({ facts: [{ category: 'constraints', content: 'No flashy UI.' }] });
		const extractor = new PpbExtractor({ client: new FakeClient([response]), policy: { maxAttempts: 1, backoffMs: 0 } });
		const fact = (await extractor.extract(segment('no flashy UI'))).facts[0];
		assert.strictEqual(fact.confidence, 0.5);
		assert.strictEqual(fact.importance, 0.5);
	});

	test('malformed output is retried and a later valid response wins (§7.7)', async () => {
		const client = new FakeClient(['not json at all', validJson]);
		const extractor = new PpbExtractor({ client, policy: { maxAttempts: 2, backoffMs: 0 } });
		const result = await extractor.extract(segment('We use PostgreSQL.'));
		assert.strictEqual(client.calls.length, 2);
		assert.strictEqual(result.facts.length, 1);
	});

	test('an unknown category fails validation and is retried', async () => {
		const bad = JSON.stringify({ facts: [{ category: 'databases', content: 'x' }] });
		const client = new FakeClient([bad, validJson]);
		const extractor = new PpbExtractor({ client, policy: { maxAttempts: 2, backoffMs: 0 } });
		assert.strictEqual((await extractor.extract(segment('x'))).facts.length, 1);
		assert.strictEqual(client.calls.length, 2);
	});

	test('retries exhausted → logged, zero facts, never throws (§7.7/§24)', async () => {
		const logs: string[] = [];
		const client = new FakeClient(['bad', 'bad', 'bad']);
		const extractor = new PpbExtractor({ client, policy: { maxAttempts: 3, backoffMs: 0 }, log: message => logs.push(message) });
		const result = await extractor.extract(segment('x'));
		assert.strictEqual(client.calls.length, 3);
		assert.deepStrictEqual([...result.facts], []);
		assert.ok(logs.some(line => line.includes('extraction failed for turn turn-1')), 'failure must be traced');
	});

	test('transport failures are retried like malformed output (§24)', async () => {
		const client = new FakeClient([new Error('ECONNREFUSED'), validJson]);
		const extractor = new PpbExtractor({ client, policy: { maxAttempts: 2, backoffMs: 0 } });
		assert.strictEqual((await extractor.extract(segment('We use PostgreSQL.'))).facts.length, 1);
	});

	test('fenced JSON is tolerated; out-of-range scores are rejected', () => {
		assert.strictEqual(parseExtractionPayload('```json\n' + validJson + '\n```').length, 1);
		assert.throws(
			() => parseExtractionPayload(JSON.stringify({ facts: [{ category: 'technology_stack', content: 'x', confidence: 2 }] })),
			ExtractionValidationError
		);
		assert.throws(() => parseExtractionPayload(JSON.stringify({ facts: [{ category: 'technology_stack' }] })), ExtractionValidationError);
	});
});
