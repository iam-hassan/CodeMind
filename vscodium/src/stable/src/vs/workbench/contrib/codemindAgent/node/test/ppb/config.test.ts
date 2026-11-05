/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isPpbEnabled, loadPpbConfig } from '../../ppb/config.js';

suite('PPB config', () => {

	test('isPpbEnabled is on by default and off only for CODEMIND_PPB_ENABLED=0', () => {
		assert.strictEqual(isPpbEnabled({}), true);
		assert.strictEqual(isPpbEnabled({ CODEMIND_PPB_ENABLED: '0' }), false);
		assert.strictEqual(isPpbEnabled({ CODEMIND_PPB_ENABLED: '1' }), true);
	});

	test('loadPpbConfig uses placeholder defaults (spec §26/§32)', () => {
		const config = loadPpbConfig({});
		assert.ok(config.pgUrl.startsWith('postgres://'));
		assert.ok(config.neo4jUrl.startsWith('bolt://'));
		assert.ok(config.redisUrl.startsWith('redis://'));
		assert.strictEqual(config.embedModel, 'bge-m3');
	});

	test('loadPpbConfig honors environment overrides', () => {
		const config = loadPpbConfig({
			PPB_PG_URL: 'postgres://u:p@db:5432/x',
			PPB_NEO4J_URL: 'bolt://db:7687',
			PPB_REDIS_URL: 'redis://cache:6379',
			PPB_EMBED_MODEL: 'custom-embed'
		});
		assert.strictEqual(config.pgUrl, 'postgres://u:p@db:5432/x');
		assert.strictEqual(config.neo4jUrl, 'bolt://db:7687');
		assert.strictEqual(config.redisUrl, 'redis://cache:6379');
		assert.strictEqual(config.embedModel, 'custom-embed');
	});
});
