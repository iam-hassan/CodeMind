/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { normalise, applyPiiRedaction, shouldIngest } from '../orchestration/segmentFilter.js';

/**
 * P2-T04 tests — Segment filter: normalise, applyPiiRedaction, shouldIngest.
 *
 * All tests are synchronous and hermetic (no disk, no network, no temp dirs).
 */

suite('PPB › segmentFilter › normalise', () => {

	test('empty string → empty string', () => {
		assert.strictEqual(normalise(''), '');
	});

	test('whitespace-only string → empty string', () => {
		assert.strictEqual(normalise('   \t\n  '), '');
	});

	test('collapses mixed whitespace (tabs, newlines, spaces) to single space', () => {
		assert.strictEqual(normalise('hello\t\t\nworld   '), 'hello world');
	});

	test('trims leading and trailing whitespace', () => {
		assert.strictEqual(normalise('  hello world  '), 'hello world');
	});

	test('collapses CRLF runs', () => {
		assert.strictEqual(normalise('line1\r\nline2\r\nline3'), 'line1 line2 line3');
	});

	test('applies Unicode NFC normalisation', () => {
		// é can be represented as U+00E9 (precomposed) or U+0065 U+0301 (decomposed).
		// NFC normalisation should produce U+00E9 for both.
		const decomposed = 'e\u0301'; // e + combining acute
		const precomposed = '\u00e9';  // é
		assert.strictEqual(normalise(decomposed), precomposed);
	});

	test('normal ASCII text is returned unchanged (except trimmed)', () => {
		assert.strictEqual(normalise('Use Redis for caching'), 'Use Redis for caching');
	});

	test('preserves internal single spaces', () => {
		assert.strictEqual(normalise('one two three'), 'one two three');
	});

});

suite('PPB › segmentFilter › applyPiiRedaction', () => {

	// ── Email ─────────────────────────────────────────────────────────────────

	test('redacts a simple email address', () => {
		const result = applyPiiRedaction('Contact me at user@example.com please');
		assert.ok(!result.includes('user@example.com'), 'email must be removed');
		assert.ok(result.includes('[REDACTED]'), 'placeholder must be present');
	});

	test('redacts email with + and . in local part', () => {
		const result = applyPiiRedaction('Email: first.last+tag@sub.domain.org');
		assert.ok(!result.includes('first.last'), 'email local part must be removed');
	});

	test('redacts multiple emails in one string', () => {
		const result = applyPiiRedaction('From: a@b.com To: c@d.org');
		assert.strictEqual((result.match(/\[REDACTED\]/g) ?? []).length, 2);
	});

	test('text without email is unchanged', () => {
		const input = 'Use Redis for caching';
		assert.strictEqual(applyPiiRedaction(input), input);
	});

	// ── Bearer token ──────────────────────────────────────────────────────────

	test('redacts a long bearer token (≥20 chars)', () => {
		const input = 'Authorization: bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abc123';
		const result = applyPiiRedaction(input);
		assert.ok(!result.includes('eyJhbGciO'), 'token must be removed');
		assert.ok(result.includes('bearer [REDACTED]'), 'placeholder must follow bearer');
	});

	test('does not redact short strings after bearer (< 20 chars)', () => {
		const input = 'bearer shorttoken';  // only 10 chars
		// Should NOT be redacted — too short to be a real token
		const result = applyPiiRedaction(input);
		assert.ok(!result.includes('[REDACTED]'), 'short token must not be redacted');
	});

	test('bearer token redaction is case-insensitive', () => {
		const input = 'BEARER eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abc123';
		const result = applyPiiRedaction(input);
		assert.ok(!result.includes('eyJhbGciO'), 'token must be removed case-insensitively');
	});

	// ── Password assignment ───────────────────────────────────────────────────

	test('redacts password: value', () => {
		const result = applyPiiRedaction('password: hunter2');
		assert.ok(!result.includes('hunter2'), 'password value must be removed');
		assert.ok(result.includes('[REDACTED]'), 'placeholder must be present');
	});

	test('redacts password=value', () => {
		const result = applyPiiRedaction('password=supersecret123');
		assert.ok(!result.includes('supersecret123'), 'password value must be removed');
	});

	test('redacts PASSWORD with spaces around operator', () => {
		const result = applyPiiRedaction('PASSWORD = "hunter2"');
		assert.ok(!result.includes('hunter2'), 'password value must be removed');
	});

	test('does not redact unrelated lines', () => {
		const input = 'The password field must be non-empty (validation only)';
		// This line mentions "password" but does not have a `: value` pattern
		const result = applyPiiRedaction(input);
		// "password field" should NOT be redacted (no := delimiter followed by value)
		assert.ok(result.includes('password field'), 'prose mentioning password must not be redacted');
	});

	// ── PEM block ─────────────────────────────────────────────────────────────

	test('redacts a PEM private key block', () => {
		const input = [
			'-----BEGIN RSA PRIVATE KEY-----',
			'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4PAtEsHABwGHaJuMptTj+TobL3y',
			'-----END RSA PRIVATE KEY-----',
		].join('\n');
		const result = applyPiiRedaction(input);
		assert.ok(!result.includes('MIIEpAIBAAKCAQEA'), 'key data must be removed');
		assert.ok(result.includes('[REDACTED]'), 'placeholder must be present');
	});

	test('redacts a PEM certificate block', () => {
		const input = '-----BEGIN CERTIFICATE-----\nABCDEFGH\n-----END CERTIFICATE-----';
		const result = applyPiiRedaction(input);
		assert.ok(!result.includes('ABCDEFGH'), 'cert data must be removed');
	});

	test('text with no PII is returned unchanged', () => {
		const input = 'Use Redis for caching. Set TTL to 300s.';
		assert.strictEqual(applyPiiRedaction(input), input);
	});

	// ── Composition ───────────────────────────────────────────────────────────

	test('redacts multiple PII kinds in one string', () => {
		const input = 'Email user@example.com, password: hunter2, bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abc123';
		const result = applyPiiRedaction(input);
		assert.ok(!result.includes('user@example.com'), 'email must be removed');
		assert.ok(!result.includes('hunter2'), 'password must be removed');
		assert.ok(!result.includes('eyJhbGciO'), 'token must be removed');
		assert.strictEqual((result.match(/\[REDACTED\]/g) ?? []).length, 3);
	});

});

suite('PPB › segmentFilter › shouldIngest', () => {

	test('returns true for normal prose', () => {
		assert.strictEqual(shouldIngest('Use Redis for caching'), true);
	});

	test('returns true for very short decision text (no 30-char minimum)', () => {
		assert.strictEqual(shouldIngest('OK'), true);
	});

	test('returns true for single word', () => {
		assert.strictEqual(shouldIngest('TypeScript'), true);
	});

	test('returns false for empty string', () => {
		assert.strictEqual(shouldIngest(''), false);
	});

	test('returns false for whitespace-only string', () => {
		assert.strictEqual(shouldIngest('   '), false);
	});

	test('returns false for bare POSIX absolute path', () => {
		assert.strictEqual(shouldIngest('/home/user/project/src/foo.ts'), false);
	});

	test('returns false for bare Windows absolute path', () => {
		assert.strictEqual(shouldIngest('C:\\Users\\user\\project\\src\\foo.ts'), false);
	});

	test('returns true for prose that contains a path (not bare)', () => {
		assert.strictEqual(
			shouldIngest('Changed /home/user/project/foo.ts to add logging'),
			true,
			'path embedded in prose should be ingested',
		);
	});

	test('returns true for [REDACTED] placeholder string (post-PII)', () => {
		// After PII redaction an email becomes "[REDACTED]" — that is still worth
		// ingesting because the surrounding sentence may carry useful context.
		assert.strictEqual(shouldIngest('Contact [REDACTED] for access'), true);
	});

	test('returns false for bare relative path', () => {
		assert.strictEqual(shouldIngest('./relative/path/to/file.ts'), false);
	});

});
