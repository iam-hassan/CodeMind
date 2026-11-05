/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConversationSegment } from '../../orchestration/segmentQueue.js';
import {
	enqueue,
	flush,
	getSegmentQueueStats,
	setSink,
	_resetQueueForTests
} from '../../orchestration/segmentQueue.js';
import { setGlobalDeveloperPrefs, _setRegistryDirForTests } from '../../orchestration/projectRegistry.js';
import { PpbSegmentSink } from '../../ppb/sink.js';
import type { ExtractionResult, Extractor } from '../../ppb/extraction/types.js';

class RecordingExtractor implements Extractor {
	readonly seen: string[] = [];
	async extract(segment: ConversationSegment): Promise<ExtractionResult> {
		this.seen.push(segment.turnId);
		return { segmentId: segment.turnId, facts: [] };
	}
}

class ThrowingExtractor implements Extractor {
	async extract(_segment: ConversationSegment): Promise<ExtractionResult> {
		throw new Error('simulated extractor failure');
	}
}

function rawSegment(projectId: string, turnId: string, cwd: string) {
	return {
		projectId,
		turnId,
		role: 'user' as const,
		text: 'We use PostgreSQL for persistence.',
		intent: 'architecture',
		timestamp: Date.now(),
		editorState: { cwd, openFiles: [], workspaceName: 'ppb-m2' }
	};
}

suite('PPB ingestion path (spec §21 M2)', () => {

	let tempDir: string;

	setup(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppb-m2-'));
		_setRegistryDirForTests(tempDir);
		_resetQueueForTests();
		await setGlobalDeveloperPrefs({ ppbEnabled: true } as any);
	});

	teardown(async () => {
		_resetQueueForTests();
		await setGlobalDeveloperPrefs({ ppbEnabled: false } as any);
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	test('segments reach the extraction boundary end-to-end with the stub (empty fact set)', async () => {
		const extractor = new RecordingExtractor();
		setSink(new PpbSegmentSink({ extractor }));

		enqueue(rawSegment('projectA', 'm2-t1', tempDir));

		// The drain is asynchronous (setImmediate): the chat turn never waits on ingestion.
		assert.deepStrictEqual([...extractor.seen], []);

		await flush();

		assert.deepStrictEqual([...extractor.seen], ['m2-t1']);
		const stats = getSegmentQueueStats();
		assert.strictEqual(stats.queued, 1);
		assert.strictEqual(stats.drained, 1);
		assert.strictEqual(stats.dropped, 0);
	});

	test('a throwing extractor never breaks the queue (§24)', async () => {
		setSink(new PpbSegmentSink({ extractor: new ThrowingExtractor() }));
		enqueue(rawSegment('projectA', 'm2-t2', tempDir));
		await flush();
		const stats = getSegmentQueueStats();
		assert.strictEqual(stats.drained, 1, 'the queue handed the batch to the sink');
		assert.strictEqual(stats.dropped, 0);
	});

	test('ppbEnabled=false for the project drops the segment before extraction', async () => {
		await setGlobalDeveloperPrefs({ ppbEnabled: false } as any);
		const extractor = new RecordingExtractor();
		setSink(new PpbSegmentSink({ extractor }));

		enqueue(rawSegment('projectA', 'm2-t3', tempDir));
		await flush();

		assert.deepStrictEqual([...extractor.seen], []);
		const stats = getSegmentQueueStats();
		assert.strictEqual(stats.queued, 0);
		assert.strictEqual(stats.dropped, 1);
	});
});
