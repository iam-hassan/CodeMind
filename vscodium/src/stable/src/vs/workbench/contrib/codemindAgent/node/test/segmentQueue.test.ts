/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
	enqueue,
	setSink,
	getSegmentQueueStats,
	recordCrossProjectLeaks,
	NoopSegmentSink,
	_resetQueueForTests,
	_getRingForTests,
	_getSinkForTests,
	flush,
	type ConversationSegment,
	type ISegmentSink,
} from '../orchestration/segmentQueue.js';
import {
	getOrCreateProject,
	setGlobalDeveloperPrefs,
	setPerProjectPrefs,
	_resetForTests as _resetRegistry,
	_setRegistryDirForTests,
} from '../orchestration/projectRegistry.js';

/**
 * P2-T05 tests — Segment queue: ring buffer, async handoff, guards, stats.
 *
 * Each test uses a fresh temp registry dir so resolvePreferences() reads from
 * an isolated file and never touches ~/.codemind.
 */

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeSegment(overrides: Partial<ConversationSegment> & { projectId: string }): ConversationSegment {
	return {
		projectId: overrides.projectId,
		turnId: overrides.turnId ?? 'turn-1',
		role: overrides.role ?? 'user',
		text: overrides.text ?? 'Use Redis for caching',
		intent: overrides.intent ?? 'fact',
		timestamp: overrides.timestamp ?? Date.now(),
		editorState: overrides.editorState ?? { cwd: '/tmp/ws', openFiles: [], workspaceName: 'ws' },
	};
}

/** A sink that collects all ingested segments for inspection. */
class CollectingSink implements ISegmentSink {
	readonly batches: ConversationSegment[][] = [];
	async ingest(segments: ConversationSegment[]): Promise<void> {
		this.batches.push([...segments]);
	}
	get flat(): ConversationSegment[] {
		return this.batches.flat();
	}
}

/** A sink that always rejects. */
class ErrorSink implements ISegmentSink {
	async ingest(_segments: ConversationSegment[]): Promise<void> {
		throw new Error('sink error');
	}
}

// ── Per-test temp registry isolation ─────────────────────────────────────────

let _tempRegistryDir: string;

async function setupTempRegistry(): Promise<void> {
	_tempRegistryDir = await mkdtemp(join(tmpdir(), 'ppb-sq-'));
	_resetRegistry();
	_setRegistryDirForTests(_tempRegistryDir);
}

async function teardownTempRegistry(): Promise<void> {
	try { await rm(_tempRegistryDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

suite('PPB › segmentQueue', () => {

	setup(async () => {
		_resetQueueForTests();
		await setupTempRegistry();
		// Enable PPB globally for tests that need it
		await setGlobalDeveloperPrefs({ ppbEnabled: true });
	});

	teardown(async () => {
		_resetQueueForTests();
		_resetRegistry();
		await teardownTempRegistry();
	});

	// ── NoopSegmentSink ───────────────────────────────────────────────────────

	test('default sink is NoopSegmentSink', () => {
		assert.ok(_getSinkForTests() instanceof NoopSegmentSink);
	});

	test('setSink replaces the active sink', () => {
		const sink = new CollectingSink();
		setSink(sink);
		assert.strictEqual(_getSinkForTests(), sink);
	});

	// ── enqueue never throws ──────────────────────────────────────────────────

	test('enqueue never throws even with completely bad input', () => {
		assert.doesNotThrow(() => {
			// @ts-expect-error — deliberate bad call for robustness test
			enqueue(null);
		});
		assert.doesNotThrow(() => {
			// @ts-expect-error
			enqueue(undefined);
		});
		assert.doesNotThrow(() => {
			enqueue(makeSegment({ projectId: '' }));
		});
	});

	// ── projectId guard ───────────────────────────────────────────────────────

	test('segment with empty projectId is dropped (not queued)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			enqueue(makeSegment({ projectId: '' }));
			const stats = getSegmentQueueStats();
			assert.strictEqual(stats.queued, 0, 'nothing should be queued');
			assert.strictEqual(stats.dropped, 1, 'drop counter must increment');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── ppbEnabled guard ──────────────────────────────────────────────────────

	test('segment is dropped when ppbEnabled=false for that project', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			// Create a project record so resolvePreferences works
			const id = await getOrCreateProject(dir);
			// Override: disable PPB for this project
			await setPerProjectPrefs(id.projectId, { ppbEnabled: false });

			enqueue(makeSegment({ projectId: id.projectId }));
			const stats = getSegmentQueueStats();
			assert.strictEqual(stats.queued, 0, 'ppbEnabled=false must prevent queuing');
			assert.strictEqual(stats.dropped, 1);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('segment is queued when ppbEnabled=true for that project', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			// ppbEnabled=true already set globally in setup()
			const sink = new CollectingSink();
			setSink(sink);

			enqueue(makeSegment({ projectId: id.projectId }));
			const stats = getSegmentQueueStats();
			assert.strictEqual(stats.queued, 1, 'segment must be queued');
			assert.strictEqual(stats.dropped, 0);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('global ppbEnabled=false drops all segments', async () => {
		// Override global to false (no per-project override)
		await setGlobalDeveloperPrefs({ ppbEnabled: false });
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			enqueue(makeSegment({ projectId: id.projectId }));
			assert.strictEqual(getSegmentQueueStats().queued, 0);
			assert.strictEqual(getSegmentQueueStats().dropped, 1);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── PII + shouldIngest filter ─────────────────────────────────────────────

	test('segment with empty text after PII redaction is dropped', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			// A string that becomes empty after redaction and normalisation
			enqueue(makeSegment({ projectId: id.projectId, text: '   ' }));
			assert.strictEqual(getSegmentQueueStats().dropped, 1);
			assert.strictEqual(getSegmentQueueStats().queued, 0);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('segment with bare file path is dropped', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			enqueue(makeSegment({ projectId: id.projectId, text: '/home/user/project/src/foo.ts' }));
			assert.strictEqual(getSegmentQueueStats().dropped, 1);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('text is PII-redacted before storage', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			const sink = new CollectingSink();
			setSink(sink);

			enqueue(makeSegment({
				projectId: id.projectId,
				text: 'Contact user@example.com for access',
			}));
			await flush();  // let drain fire

			assert.strictEqual(sink.flat.length, 1);
			assert.ok(!sink.flat[0].text.includes('user@example.com'), 'email must be redacted');
			assert.ok(sink.flat[0].text.includes('[REDACTED]'), 'placeholder must be present');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── setImmediate handoff ──────────────────────────────────────────────────

	test('enqueue is synchronous but drain happens asynchronously via setImmediate', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			const sink = new CollectingSink();
			setSink(sink);

			enqueue(makeSegment({ projectId: id.projectId }));

			// Immediately after enqueue: sink has NOT been called yet
			assert.strictEqual(sink.flat.length, 0, 'sink must not be called synchronously');
			assert.strictEqual(_getRingForTests().length, 1, 'segment must be in ring');

			// After yielding to the event loop: drain runs
			await flush();
			assert.strictEqual(sink.flat.length, 1, 'segment must reach sink after nextTick');
			assert.strictEqual(_getRingForTests().length, 0, 'ring must be empty after drain');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('multiple enqueue calls before the tick are drained in one batch', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			const sink = new CollectingSink();
			setSink(sink);

			enqueue(makeSegment({ projectId: id.projectId, turnId: 'turn-1' }));
			enqueue(makeSegment({ projectId: id.projectId, turnId: 'turn-2' }));
			enqueue(makeSegment({ projectId: id.projectId, turnId: 'turn-3' }));

			assert.strictEqual(_getRingForTests().length, 3, 'all 3 must be in ring before tick');
			await flush();

			assert.strictEqual(sink.batches.length, 1, 'drain must send exactly 1 batch');
			assert.strictEqual(sink.flat.length, 3, 'all 3 segments must reach sink');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── Ring buffer overflow ──────────────────────────────────────────────────

	test('ring buffer caps at 256; overflows counter increments for each evicted segment', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			const sink = new CollectingSink();
			setSink(sink);

			// Enqueue 260 segments without yielding (drain is deferred)
			const count = 260;
			for (let i = 0; i < count; i++) {
				enqueue(makeSegment({ projectId: id.projectId, turnId: `turn-${i}` }));
			}

			const stats = getSegmentQueueStats();
			assert.strictEqual(_getRingForTests().length, 256, 'ring must cap at 256');
			assert.strictEqual(stats.overflows, 4, 'exactly 4 evictions for 260 - 256');
			assert.strictEqual(stats.queued, count, 'queued counts all accepted segments including overflowed');

			// After drain: all 256 remaining segments must reach sink
			await flush();
			assert.strictEqual(sink.flat.length, 256, 'sink receives the 256 that survived');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('oldest segment is evicted (most recent is kept)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			const sink = new CollectingSink();
			setSink(sink);

			// Fill ring to capacity + 1
			for (let i = 0; i < 256; i++) {
				enqueue(makeSegment({ projectId: id.projectId, turnId: `old-${i}` }));
			}
			// This one evicts old-0
			enqueue(makeSegment({ projectId: id.projectId, turnId: 'newest' }));

			await flush();
			const ids = sink.flat.map(s => s.turnId);
			assert.ok(!ids.includes('old-0'), 'oldest segment must be evicted');
			assert.ok(ids.includes('newest'), 'newest segment must be retained');
			assert.strictEqual(ids[ids.length - 1], 'newest', 'newest must be last');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── Stats ─────────────────────────────────────────────────────────────────

	test('getSegmentQueueStats returns a snapshot (mutations do not affect the returned object)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			const sink = new CollectingSink();
			setSink(sink);

			enqueue(makeSegment({ projectId: id.projectId }));
			const snap1 = getSegmentQueueStats();
			assert.strictEqual(snap1.queued, 1);

			enqueue(makeSegment({ projectId: id.projectId, turnId: 'turn-2' }));
			const snap2 = getSegmentQueueStats();
			assert.strictEqual(snap2.queued, 2);
			// snap1 must not change
			assert.strictEqual(snap1.queued, 1, 'earlier snapshot must be immutable');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('drained counter increments after successful drain', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			setSink(new CollectingSink());

			enqueue(makeSegment({ projectId: id.projectId }));
			assert.strictEqual(getSegmentQueueStats().drained, 0, 'not drained yet');
			await flush();
			assert.strictEqual(getSegmentQueueStats().drained, 1, 'drained after tick');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('sink error is caught; segments are counted as dropped and queue does not throw', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			setSink(new ErrorSink());

			enqueue(makeSegment({ projectId: id.projectId }));
			// Must not throw
			await flush();

			const stats = getSegmentQueueStats();
			assert.strictEqual(stats.drained, 0, 'drained must remain 0 on sink error');
			assert.strictEqual(stats.dropped, 1, 'dropped must reflect the failed batch');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── crossProjectLeaks counter ─────────────────────────────────────────────

	test('recordCrossProjectLeaks increments the counter', () => {
		assert.strictEqual(getSegmentQueueStats().crossProjectLeaks, 0);
		recordCrossProjectLeaks(3);
		assert.strictEqual(getSegmentQueueStats().crossProjectLeaks, 3);
		recordCrossProjectLeaks(2);
		assert.strictEqual(getSegmentQueueStats().crossProjectLeaks, 5);
	});

	test('recordCrossProjectLeaks with zero or negative does not increment', () => {
		recordCrossProjectLeaks(0);
		recordCrossProjectLeaks(-5);
		assert.strictEqual(getSegmentQueueStats().crossProjectLeaks, 0);
	});

	test('crossProjectLeaks is reset by _resetQueueForTests', () => {
		recordCrossProjectLeaks(10);
		_resetQueueForTests();
		assert.strictEqual(getSegmentQueueStats().crossProjectLeaks, 0);
	});

	// ── Text normalisation in stored segments ─────────────────────────────────

	test('stored segment text is normalised (whitespace collapsed)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			const sink = new CollectingSink();
			setSink(sink);

			enqueue(makeSegment({
				projectId: id.projectId,
				text: 'Use   Redis\t\nfor caching',
			}));
			await flush();

			assert.strictEqual(sink.flat[0].text, 'Use Redis for caching');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

});
