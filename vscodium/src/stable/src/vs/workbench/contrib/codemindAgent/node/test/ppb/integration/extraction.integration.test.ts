/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live extraction tests (P1-T04/T05) — gated by `PPB_TEST_LLM=1` **and** a configured
 * `PPB_EXTRACT_MODEL`. Skipped silently in normal runs (no model, no network).
 */

import assert from 'assert';
import type { ConversationSegment } from '../../../orchestration/segmentQueue.js';
import { loadPpbConfig } from '../../../ppb/config.js';
import { PpbExtractor } from '../../../ppb/extraction/validate.js';
import { createExtractionClient } from '../../../ppb/llm/client.js';
import { MEMORY_CATEGORIES } from '../../../ppb/ontology.js';

const enabled = process.env.PPB_TEST_LLM === '1';
const model = process.env.PPB_EXTRACT_MODEL ?? '';

function segment(text: string): ConversationSegment {
	return {
		projectId: 'ppb-llm-itest',
		turnId: `turn-${Date.now()}`,
		role: 'user',
		text,
		intent: 'architecture',
		timestamp: Date.now(),
		editorState: { cwd: 'C:\\proj', openFiles: [], workspaceName: 'proj' }
	};
}

suite('PPB extraction (live model)', function () {

	// A reasoning model can take well over the 2 s mocha default for one call.
	this.timeout(300_000);

	setup(function () {
		if (!enabled || model.length === 0) {
			this.skip();
		}
	});

	function extractor() {
		const config = loadPpbConfig();
		const client = createExtractionClient(config.extractBaseUrl, model, config.extractApiKey, config.extractTimeoutMs);
		return new PpbExtractor({ client, policy: { maxAttempts: 2, backoffMs: 200 } });
	}

	test('engineering content yields at least one validly categorised fact (§7.13)', async () => {
		const result = await extractor().extract(
			segment('We use PostgreSQL for persistence and we chose Clerk for authentication. We rejected Auth.js because it lacked the features we needed.')
		);
		assert.ok(result.facts.length >= 1, 'expected at least one extracted fact');
		for (const fact of result.facts) {
			assert.ok((MEMORY_CATEGORIES as readonly string[]).includes(fact.category), `valid category, got ${fact.category}`);
			assert.ok(fact.content.trim().length > 0);
			assert.ok(fact.confidence >= 0 && fact.confidence <= 1);
			assert.ok(fact.importance >= 0 && fact.importance <= 1);
			assert.strictEqual(fact.sourceRef.startsWith('ppb-llm-itest:'), true);
		}
	});

	test('non-engineering chatter yields zero facts (acceptance #2)', async () => {
		const result = await extractor().extract(segment('hey, thanks! that looks great :)'));
		assert.strictEqual(result.facts.length, 0);
	});
});
