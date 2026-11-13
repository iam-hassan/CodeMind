/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ConversationSegment } from '../../orchestration/segmentQueue.js';
import { PpbSegmentSink } from '../../ppb/sink.js';
import { StubExtractor } from '../../ppb/extraction/stubExtractor.js';
import type { ExtractedFact, ExtractionResult, Extractor } from '../../ppb/extraction/types.js';
import type { RetrievalCache } from '../../ppb/storage/redis.js';

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

	test('invalidates the ranked-result cache after a successful persist (IF-12)', async () => {
		const cache = new RecordingCache();
		const sink = new PpbSegmentSink({ extractor: new FactExtractor(), write: new FakeWrite(), cache });

		await sink.ingest([makeSegment('t1')]);

		assert.deepStrictEqual([...cache.invalidated], ['projectA']);
	});

	test('a failing cache invalidation never breaks ingestion (§24)', async () => {
		const cache = new RecordingCache();
		cache.throwOnInvalidate = true;
		const sink = new PpbSegmentSink({ extractor: new FactExtractor(), write: new FakeWrite(), cache });

		await sink.ingest([makeSegment('t1')]);
		assert.strictEqual(cache.invalidated.length, 1);
	});

	test('ingestion logs and events never expose credential-shaped error text (§11)', async () => {
		const logs: string[] = [];
		const events: Array<{ detail?: string }> = [];
		const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
		const extractor: Extractor = { extract: async () => { throw new Error(`upstream rejected ${secret}`); } };
		const sink = new PpbSegmentSink({
			extractor,
			log: message => logs.push(message),
			onEvent: event => events.push({ detail: event.detail })
		});

		await sink.ingest([makeSegment('t1')]);

		assert.ok(logs.length > 0);
		assert.ok(logs.every(line => !line.includes(secret)), 'log must be redacted');
		assert.ok(events.every(event => !event.detail || !event.detail.includes(secret)), 'event detail must be redacted');
	});
});

class FactExtractor implements Extractor {
	async extract(segment: ConversationSegment): Promise<ExtractionResult> {
		const fact: ExtractedFact = {
			id: 'f1', category: 'technology_stack', content: 'The project uses PostgreSQL for persistence',
			confidence: 0.9, importance: 0.8, sourceRef: `${segment.projectId}:${segment.turnId}`,
			author: 'user', extractedAt: '2026-01-01T00:00:00.000Z'
		};
		return { segmentId: segment.turnId, facts: [fact] };
	}
}

class FakeWrite {
	async query(_text: string, _params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		return { rows: [] };
	}
}

class RecordingCache implements RetrievalCache {
	readonly enabled = true;
	readonly invalidated: string[] = [];
	throwOnInvalidate = false;

	async get(): Promise<undefined> { return undefined; }
	async set(): Promise<void> { /* no-op */ }
	async invalidate(projectId: string): Promise<void> {
		this.invalidated.push(projectId);
		if (this.throwOnInvalidate) {
			throw new Error('cache down');
		}
	}
	async close(): Promise<void> { /* no-op */ }
}
