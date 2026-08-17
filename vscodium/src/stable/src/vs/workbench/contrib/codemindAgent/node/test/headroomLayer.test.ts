/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { shouldCompress, compressContext } from '../orchestration/headroomLayer.js';
import { OptimizedContext } from '../orchestration/types.js';
import { makeToken } from './orchestrationTestUtils.js';

/**
 * Proves the headroom layer's compression-mode thresholds and its hermetic NONE path,
 * plus the documented fallback when the optional headroom-ai library is unavailable.
 */
suite('Orchestration › headroomLayer', () => {

	const optimized = (serializedContext: string, estimatedTokens: number): OptimizedContext =>
		({ serializedContext, estimatedTokens, sectionsIncluded: [], sectionsRemoved: [], optimizationDurationMs: 0 });

	// --- shouldCompress thresholds ---
	test('shouldCompress(0) → none', () => { assert.strictEqual(shouldCompress(0), 'none'); });
	test('shouldCompress(1999) → none (just under the light boundary)', () => { assert.strictEqual(shouldCompress(1999), 'none'); });
	test('shouldCompress(2000) → light (at the light boundary)', () => { assert.strictEqual(shouldCompress(2000), 'light'); });
	test('shouldCompress(5000) → light', () => { assert.strictEqual(shouldCompress(5000), 'light'); });
	test('shouldCompress(7999) → light (just under the aggressive boundary)', () => { assert.strictEqual(shouldCompress(7999), 'light'); });
	test('shouldCompress(8000) → aggressive (at the aggressive boundary)', () => { assert.strictEqual(shouldCompress(8000), 'aggressive'); });
	test('shouldCompress(50000) → aggressive', () => { assert.strictEqual(shouldCompress(50000), 'aggressive'); });

	// --- compressContext: NONE path (< 2000 tokens) is hermetic and lossless ---
	test('small context is returned UNCHANGED with mode none', async () => {
		const opt = optimized('=== REPOSITORY ===\nCurrent: /x.ts\n', 500);
		const c = await compressContext(opt, 'claude', makeToken());
		assert.strictEqual(c.context, opt.serializedContext);
		assert.strictEqual(c.mode, 'none');
		assert.strictEqual(c.headroomAvailable, false);
	});

	test('small context preserves the exact estimatedTokens', async () => {
		const opt = optimized('some short context', 123);
		const c = await compressContext(opt, 'claude', makeToken());
		assert.strictEqual(c.estimatedTokens, 123);
	});

	test('empty context compresses to mode none', async () => {
		const c = await compressContext(optimized('', 0), 'claude', makeToken());
		assert.strictEqual(c.mode, 'none');
		assert.strictEqual(c.context, '');
	});

	// --- compressContext: large context fallback contract ---
	test('large context: when headroom is unavailable, mode is coerced to none and text is unchanged', async () => {
		const big = 'line of context text\n'.repeat(400); // > 2000 tokens by the /4 heuristic
		const opt = optimized(big, Math.floor(big.length / 4));
		const c = await compressContext(opt, 'claude', makeToken());
		// The optional headroom-ai lib is not part of the test build; either it is present
		// (real compression, mode preserved) or absent (documented fallback below).
		if (!c.headroomAvailable) {
			assert.strictEqual(c.mode, 'none', 'fallback coerces mode to none');
			assert.strictEqual(c.context, big, 'fallback leaves the text unchanged');
		} else {
			assert.ok(['light', 'aggressive'].includes(c.mode));
			assert.strictEqual(typeof c.context, 'string');
		}
	});

	test('compressContext never rejects for a large context', async () => {
		const big = 'x'.repeat(40000);
		await assert.doesNotReject(() => compressContext(optimized(big, 10000), 'claude', makeToken()));
	});

	test('compressContext returns a well-formed CompressedContext', async () => {
		const c = await compressContext(optimized('ctx', 400), 'claude', makeToken());
		assert.ok(c.context === null || typeof c.context === 'string');
		assert.strictEqual(typeof c.estimatedTokens, 'number');
		assert.ok(['none', 'light', 'aggressive'].includes(c.mode));
		assert.strictEqual(typeof c.headroomAvailable, 'boolean');
	});
});
