/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for the central secret redactor (spec §8/§11). */

import assert from 'assert';
import { REDACTED, redact, redactJson, redactValue } from '../../ppb/redact.js';

suite('PPB secret redaction (spec §8/§11)', () => {

	test('masks OpenAI-style, GitHub, AWS and Slack tokens', () => {
		const samples = [
			'sk-abcdefghijklmnopqrstuvwxyz012345',
			'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
			'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			'AKIAABCDEFGHIJKLMNOP',
			'xoxb-1234567890-abcdefghij'
		];
		for (const secret of samples) {
			const masked = redact(`value=${secret} end`);
			assert.ok(!masked.includes(secret), `${secret} must not survive`);
			assert.ok(masked.includes(REDACTED), `${secret} must be replaced`);
		}
	});

	test('masks bearer tokens and auth headers but keeps the label', () => {
		const bearer = redact('Authorization: Bearer abcdef0123456789xyz');
		assert.ok(!bearer.includes('abcdef0123456789xyz'));
		assert.ok(bearer.includes('Bearer'));
		assert.ok(bearer.includes(REDACTED));

		const header = redact('x-api-key: super-secret-value');
		assert.ok(!header.includes('super-secret-value'));
	});

	test('masks key/value forms and URL credentials', () => {
		assert.ok(!redact('apiKey=abcdef1234567890').includes('abcdef1234567890'));
		assert.ok(!redact('"api_key": "abcdef1234567890"').includes('abcdef1234567890'));
		assert.ok(!redact('password: hunter2hunter2').includes('hunter2hunter2'));

		const url = redact('https://user:supersecret@example.com/repo');
		assert.ok(!url.includes('supersecret'));
		assert.ok(url.includes('example.com'));
	});

	test('leaves ordinary project knowledge untouched', () => {
		const text = 'We use PostgreSQL for persistence and Clerk for authentication.';
		assert.strictEqual(redact(text), text);
	});

	test('redactValue masks credential-named keys recursively and redacts string values', () => {
		const input = {
			projectId: 'projectA',
			apiKey: 'plain-looking-but-secret',
			nested: { authorization: 'Bearer abcdef0123456789', note: 'uses sk-abcdefghijklmnopqrstuvwxyz012345' }
		};
		const output = redactValue(input) as typeof input;
		assert.strictEqual(output.projectId, 'projectA');
		assert.strictEqual(output.apiKey, REDACTED);
		assert.strictEqual(output.nested.authorization, REDACTED);
		assert.ok(!output.nested.note.includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
	});

	test('redactJson emits valid JSON with no secrets', () => {
		const json = redactJson({ token: 'abc', detail: 'Bearer abcdef0123456789' });
		assert.ok(!json.includes('abcdef0123456789'));
		const parsed = JSON.parse(json) as { token: string };
		assert.strictEqual(parsed.token, REDACTED);
	});
});
