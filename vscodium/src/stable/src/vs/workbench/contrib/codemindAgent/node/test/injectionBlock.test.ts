import * as assert from 'assert';
import { formatInjectionBlock } from '../orchestration/injectionBlock.js';
import { RetrievedFact } from '../orchestration/retrievalRequest.js';
import * as segmentQueue from '../orchestration/segmentQueue.js';

suite('PPB › injectionBlock', () => {
	setup(() => {
		// @ts-ignore for testing
		segmentQueue._resetQueueForTests();
	});

	test('empty facts returns empty block and audit', () => {
		const result = formatInjectionBlock([], 'uuid-A', 2000);
		assert.strictEqual(result.block, '');
		assert.strictEqual(result.audit.injectedFacts, 0);
		assert.strictEqual(result.audit.droppedFacts, 0);
	});

	test('drops facts that do not match the requested projectId', () => {
		const facts: RetrievedFact[] = [
			{ id: '1', projectId: 'uuid-A', content: 'fact A', score: 0.9, category: 'fact' },
			{ id: '2', projectId: 'uuid-B', content: 'fact B', score: 0.8, category: 'fact' }
		];
		const result = formatInjectionBlock(facts, 'uuid-A', 2000);
		assert.ok(result.block.includes('fact A'));
		assert.ok(!result.block.includes('fact B'));
		assert.strictEqual(result.audit.injectedFacts, 1);
		// Note: droppedFacts includes token budget drops, filter drops are tracked in crossProjectLeaks
	});

	test('sorts by score descending and drops lowest-scored first to meet budget', () => {
		const facts: RetrievedFact[] = [
			{ id: '1', projectId: 'uuid-A', content: 'C'.repeat(400), score: 0.5, category: 'fact' }, // 100+ tokens
			{ id: '2', projectId: 'uuid-A', content: 'A'.repeat(400), score: 0.9, category: 'fact' }, // 100+ tokens
			{ id: '3', projectId: 'uuid-A', content: 'B'.repeat(400), score: 0.7, category: 'fact' }, // 100+ tokens
		];
		// Give budget of ~250 tokens, so only 2 facts can fit.
		// Highest scores are 0.9 and 0.7, so 'A' and 'B' should be kept.
		const result = formatInjectionBlock(facts, 'uuid-A', 250);
		assert.ok(result.block.includes('A'.repeat(400)));
		assert.ok(result.block.includes('B'.repeat(400)));
		assert.ok(!result.block.includes('C'.repeat(400)));
		assert.strictEqual(result.audit.injectedFacts, 2);
		assert.strictEqual(result.audit.droppedFacts, 1);
	});
});
