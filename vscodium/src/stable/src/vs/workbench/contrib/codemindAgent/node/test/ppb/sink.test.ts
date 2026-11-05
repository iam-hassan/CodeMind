/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ConversationSegment } from '../../orchestration/segmentQueue.js';
import { PpbSegmentSink } from '../../ppb/sink.js';
import { StubExtractor } from '../../ppb/extraction/stubExtractor.js';
import type { ExtractionResult, Extractor } from '../../ppb/extraction/types.js';

function makeSegment(turnId: string): ConversationSegment {
	return {
		projectId: 'projectA',
		turnId,
		role: 'user',
		text: `normalised text for ${turnId}`,
		intent: 'unknown',
		timestamp: Date.now(),
		editorState: { cwd: 'C:\\proj', openFiles: [], workspaceName: 'proj' }
	};
}

class RecordingExtractor implements Extractor {
	readonly seen: string[] = [];
	async extract(segment: ConversationSegment): Promise<ExtractionResult> {
		this.seen.push(segment.turnId);
		return { segmentId: segment.turnId, facts: [] };
	}
}

class ThrowingExtractor implements Extractor {
	async extract(_segment: ConversationSegment): Promise<ExtractionResult> {
		throw new Error('boom');
	}
}

suite('PPB sink (spec §21 M2)', () => {

	test('stub extractor returns an empty fact set', async () => {
		const result = await new StubExtractor().extract(makeSegment('t1'));
		assert.strictEqual(result.segmentId, 't1');
		assert.deepStrictEqual([...result.facts], []);
	});

	test('ingest invokes the extractor once per segment', async () => {
		const extractor = new RecordingExtractor();
		await new PpbSegmentSink({ extractor }).ingest([makeSegment('a'), makeSegment('b')]);
		assert.deepStrictEqual([...extractor.seen], ['a', 'b']);
	});

	test('ingest resolves even when extraction throws (§24)', async () => {
		await new PpbSegmentSink({ extractor: new ThrowingExtractor() }).ingest([makeSegment('x')]);
		// Resolving without throwing is the assertion (queue semantics require it).
	});

	test('scheduleBackfill never throws, even with missing options', () => {
		const sink = new PpbSegmentSink();
		sink.scheduleBackfill('projectA', { scope: 'project', changedPaths: [], reason: 'test' });
		sink.scheduleBackfill('projectA', undefined as any);
	});
});
