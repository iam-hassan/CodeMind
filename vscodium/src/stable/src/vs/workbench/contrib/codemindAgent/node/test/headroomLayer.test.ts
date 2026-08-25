/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	decideMode, estimateTokens, compressSuffix, pingHeadroomProxy, probeHeadroom,
	COMPRESS_THRESHOLD_LIGHT, COMPRESS_THRESHOLD_AGGRESSIVE, HEADROOM_BASE_URL,
} from '../orchestration/headroomLayer.js';

/**
 * Proves Layer 6 (Headroom, local-proxy only): the compression-mode thresholds, the token
 * estimator, and — crucially — the graceful-degradation contract. compressSuffix must ALWAYS
 * resolve and, whenever the local proxy is not reachable, return the suffix completely
 * unchanged (tokensSaved 0, ratio 1) so the pipeline never stalls and no data is required to
 * leave the machine. These tests are hermetic: they pass whether or not a proxy is running.
 */
suite('Orchestration › headroomLayer (Layer 6)', () => {

	// --- decideMode thresholds (500 / 2000 tokens) ---
	test('decideMode(0) → none', () => { assert.strictEqual(decideMode(0), 'none'); });
	test('decideMode(499) → none (just under the light boundary)', () => { assert.strictEqual(decideMode(499), 'none'); });
	test('decideMode(500) → light (at the light boundary)', () => { assert.strictEqual(decideMode(500), 'light'); });
	test('decideMode(1999) → light (just under the aggressive boundary)', () => { assert.strictEqual(decideMode(1999), 'light'); });
	test('decideMode(2000) → aggressive (at the aggressive boundary)', () => { assert.strictEqual(decideMode(2000), 'aggressive'); });
	test('decideMode(50000) → aggressive', () => { assert.strictEqual(decideMode(50000), 'aggressive'); });
	test('thresholds are the documented 500 / 2000', () => {
		assert.strictEqual(COMPRESS_THRESHOLD_LIGHT, 500);
		assert.strictEqual(COMPRESS_THRESHOLD_AGGRESSIVE, 2000);
	});

	// --- estimateTokens (chars / 4, rounded up) ---
	test('estimateTokens is chars/4 rounded up', () => {
		assert.strictEqual(estimateTokens(''), 0);
		assert.strictEqual(estimateTokens('abcd'), 1);
		assert.strictEqual(estimateTokens('abcde'), 2);
	});

	// --- baseUrl is local only (no data leaves the machine) ---
	test('HEADROOM_BASE_URL points at localhost only', () => {
		assert.ok(/^http:\/\/localhost:\d+$/.test(HEADROOM_BASE_URL), HEADROOM_BASE_URL);
	});

	// --- compressSuffix: small suffix (< 500 tok) is a lossless no-op ---
	test('small suffix → mode none, returned byte-for-byte unchanged', async () => {
		const suffix = '\n\n[CODEMIND ORCHESTRATION]\nDetected intent: code_review\n';
		const r = await compressSuffix(suffix, 'claude', 'code_review');
		assert.strictEqual(r.mode, 'none');
		assert.strictEqual(r.compressedSuffix, suffix);
		assert.strictEqual(r.tokensSaved, 0);
		assert.strictEqual(r.compressionRatio, 1);
		assert.strictEqual(r.proxyReachable, false);
	});

	test('empty suffix → mode none, empty output', async () => {
		const r = await compressSuffix('', 'claude', 'code_generation');
		assert.strictEqual(r.mode, 'none');
		assert.strictEqual(r.compressedSuffix, '');
		assert.strictEqual(r.originalTokens, 0);
	});

	// --- compressSuffix: large suffix degradation contract ---
	test('large suffix never rejects', async () => {
		const big = 'context line with some detail\n'.repeat(400); // > 2000 tokens
		await assert.doesNotReject(() => compressSuffix(big, 'claude', 'code_generation'));
	});

	test('large suffix: when the proxy is unreachable the suffix is unchanged (fallback)', async () => {
		const big = 'context line with some detail\n'.repeat(400);
		const r = await compressSuffix(big, 'claude', 'code_generation');
		assert.ok(['light', 'aggressive'].includes(r.mode));
		if (!r.proxyReachable) {
			assert.strictEqual(r.compressedSuffix, big, 'fallback leaves the suffix unchanged');
			assert.strictEqual(r.tokensSaved, 0);
			assert.strictEqual(r.compressionRatio, 1);
		} else {
			assert.ok(r.tokensSaved >= 0);
			assert.ok(r.compressionRatio > 0);
		}
	});

	test('light mode preserves the LAST === section === verbatim at the tail', async () => {
		const head = '=== REPOSITORY ===\n' + 'a'.repeat(3000) + '\n';
		const lastBody = 'branch: main\ncommits: aaa | bbb | ccc';
		const suffix = head + '\n=== GIT ===\n' + lastBody; // ~3.5k chars → light
		const r = await compressSuffix(suffix, 'claude', 'code_generation');
		assert.strictEqual(r.mode, 'light');
		assert.ok(r.compressedSuffix.endsWith(lastBody), 'last section preserved at the end');
	});

	// --- shape / invariants ---
	test('HeadroomResult is well-formed with correct field types', async () => {
		const r = await compressSuffix('=== X ===\n' + 'y'.repeat(9000), 'claude', 'debugging'); // aggressive
		assert.strictEqual(typeof r.compressedSuffix, 'string');
		assert.strictEqual(typeof r.originalTokens, 'number');
		assert.strictEqual(typeof r.compressedTokens, 'number');
		assert.strictEqual(typeof r.tokensSaved, 'number');
		assert.strictEqual(typeof r.compressionRatio, 'number');
		assert.ok(['none', 'light', 'aggressive'].includes(r.mode));
		assert.strictEqual(typeof r.headroomAvailable, 'boolean');
		assert.strictEqual(typeof r.proxyReachable, 'boolean');
		assert.ok(Array.isArray(r.transformsApplied));
		assert.strictEqual(typeof r.durationMs, 'number');
		assert.ok(r.tokensSaved >= 0);
		assert.ok(r.compressionRatio <= 1.0001);
	});

	test('compressedTokens never exceeds originalTokens (compression only shrinks)', async () => {
		const r = await compressSuffix('=== X ===\n' + 'z'.repeat(9000), 'claude', 'debugging');
		assert.ok(r.compressedTokens <= r.originalTokens);
	});

	// --- /doctor health probe (pingHeadroomProxy / probeHeadroom) ---
	// Hermetic: a proxy may or may not be listening on :7878, so we assert the CONTRACT
	// (always resolves, never throws, well-typed verdict) rather than a specific value.
	test('pingHeadroomProxy always resolves to a boolean verdict (never throws)', async () => {
		const v = await pingHeadroomProxy(500);
		assert.strictEqual(typeof v.reachable, 'boolean');
		if (v.status !== undefined) { assert.strictEqual(typeof v.status, 'number'); }
	});

	test('pingHeadroomProxy honours a tiny timeout without hanging', async () => {
		const started = Date.now();
		const v = await pingHeadroomProxy(1);
		assert.strictEqual(typeof v.reachable, 'boolean');
		assert.ok(Date.now() - started < 2000, 'resolved well within a bounded window');
	});

	test('probeHeadroom returns a well-formed, localhost-only summary', async () => {
		const p = await probeHeadroom();
		assert.strictEqual(typeof p.installed, 'boolean');
		assert.strictEqual(typeof p.proxyReachable, 'boolean');
		assert.strictEqual(p.baseUrl, HEADROOM_BASE_URL);
		assert.ok(/^http:\/\/localhost:\d+$/.test(p.baseUrl), p.baseUrl);
	});
});
