/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for extraction target resolution (OD-6, spec §7.6). Pure: no network, no engine —
 * the engine-side capture is exercised only through the integration suites.
 */

import assert from 'assert';
import { resolveExtractionTarget, type ExtractionTarget } from '../../ppb/extraction/target.js';

const ACTIVE: ExtractionTarget = {
	model: 'picked-model',
	baseUrl: 'https://picked.example/v1',
	apiKey: 'picked-key'
};

suite('ppb/extraction/target — resolveExtractionTarget (OD-6)', () => {

	test('the active selection is used when there is no override (§7.6)', () => {
		assert.deepStrictEqual(resolveExtractionTarget(ACTIVE, undefined), ACTIVE);
	});

	test('an override model takes over the target (dev/test isolation)', () => {
		const resolved = resolveExtractionTarget(ACTIVE, {
			model: 'override-model',
			baseUrl: 'http://127.0.0.1:20128/v1',
			apiKey: ''
		});
		assert.strictEqual(resolved?.model, 'override-model');
		assert.strictEqual(resolved?.baseUrl, 'http://127.0.0.1:20128/v1');
	});

	test('absent override fields fall back to the active selection per field', () => {
		const resolved = resolveExtractionTarget(ACTIVE, { model: 'override-model', baseUrl: '', apiKey: '' });
		assert.strictEqual(resolved?.model, 'override-model');
		assert.strictEqual(resolved?.baseUrl, ACTIVE.baseUrl);
		assert.strictEqual(resolved?.apiKey, ACTIVE.apiKey);
	});

	test('no usable target means undefined — the M2 stub stays in place (§21 M2)', () => {
		assert.strictEqual(resolveExtractionTarget(undefined, undefined), undefined);
		assert.strictEqual(resolveExtractionTarget({ model: '', baseUrl: 'https://x/v1' }, undefined), undefined);
		assert.strictEqual(resolveExtractionTarget({ model: 'm', baseUrl: '   ' }, undefined), undefined);
	});

	test('whitespace-only values are absent; real values are trimmed', () => {
		assert.strictEqual(resolveExtractionTarget({ model: '  ', baseUrl: 'https://x/v1' }, undefined), undefined);
		assert.deepStrictEqual(
			resolveExtractionTarget(undefined, { model: ' m ', baseUrl: ' https://x/v1 ' }),
			{ model: 'm', baseUrl: 'https://x/v1' }
		);
	});
});