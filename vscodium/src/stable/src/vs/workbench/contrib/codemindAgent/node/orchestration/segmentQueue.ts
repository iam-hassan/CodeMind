/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * PPB Part 2 — P2-T05: Segment buffer + async handoff.
 *
 * The queue is the *only* path through which raw conversation segments enter
 * the PPB pipeline.  It enforces three invariants:
 *
 *   1. enqueue() NEVER throws and NEVER blocks the chat turn.
 *      The handoff to the sink happens via setImmediate so the current
 *      synchronous call stack is always unblocked first.
 *
 *   2. Every segment must carry a non-empty projectId.
 *      Segments without a projectId are dropped (crossProjectLeaks is NOT
 *      incremented — a missing id is not a cross-project leak, it is a
 *      programming error logged to stderr).
 *
 *   3. ppbEnabled is checked synchronously against resolvePreferences().
 *      Segments for disabled projects are dropped silently.
 *
 * Ring buffer:
 *   The queue is bounded at RING_CAPACITY segments.  When the ring is full
 *   the oldest segment is evicted (overflows counter incremented) — never the
 *   newest, so the most recent context is always retained.
 *
 * Sink interface:
 *   The sink is injected via setSink().  The default no-op sink (NoopSegmentSink)
 *   is used until a real Part 1 sink is registered.
 *
 * Pure Node; no vscode/electron import.
 */

import { normalise, applyPiiRedaction, shouldIngest } from './segmentFilter.js';
import { resolvePreferences } from './projectRegistry.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of segments held in the ring buffer at any time. */
const RING_CAPACITY = 256;

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * A single conversation segment ready for ingestion.
 * Mirrors the shape Part 1 expects from its sink.
 */
export interface ConversationSegment {
	/** Non-empty project UUID. */
	projectId: string;
	/** Unique turn identifier (UUID or turn counter). */
	turnId: string;
	/** Who generated this segment. */
	role: 'user' | 'assistant';
	/** Normalised, PII-redacted text. */
	text: string;
	/** High-level intent category. */
	intent: string;
	/** Unix ms timestamp. */
	timestamp: number;
	/** Snapshot of editor state at the time of the turn. */
	editorState: {
		cwd: string;
		openFiles: string[];
		workspaceName: string;
	};
}

/**
 * The sink interface that Part 1 will implement.
 * Both methods must resolve (never reject) so the queue can fire-and-forget.
 */
export interface ISegmentSink {
	ingest(segments: ConversationSegment[]): Promise<void>;
	scheduleBackfill?(projectId: string, options: any): void;
}

/**
 * Operational statistics reported by getSegmentQueueStats().
 */
export interface SegmentQueueStats {
	/** Segments accepted into the ring buffer. */
	queued: number;
	/** Segments successfully handed off to the sink. */
	drained: number;
	/** Segments dropped before queuing (ppbEnabled=false, bad projectId, PII-empty, etc.). */
	dropped: number;
	/** Segments evicted from the ring because it was full. */
	overflows: number;
	/**
	 * Cross-project leak counter.
	 * Incremented by filterToProject() in injectionBlock.ts whenever a
	 * retrieved fact is filtered out because its projectId doesn't match
	 * the active project.  Surfaced here so it can be reported in ppb_injection
	 * audit events alongside queue stats.
	 */
	crossProjectLeaks: number;
}

// ── No-op sink ────────────────────────────────────────────────────────────────

/**
 * Default sink: drops all segments silently.
 * Used until Part 1 registers a real implementation via setSink().
 */
export class NoopSegmentSink implements ISegmentSink {
	async ingest(_segments: ConversationSegment[]): Promise<void> {
		// Intentional no-op: Part 1 not yet wired.
	}
}

// ── Module state ──────────────────────────────────────────────────────────────

/** The ring buffer holding segments waiting to be drained. */
let _ring: ConversationSegment[] = [];

/** True if a setImmediate drain is already pending. */
let _drainScheduled = false;

/** The active sink (default: NoopSegmentSink). */
let _sink: ISegmentSink = new NoopSegmentSink();

/** Cumulative statistics. */
let _stats: SegmentQueueStats = {
	queued: 0,
	drained: 0,
	dropped: 0,
	overflows: 0,
	crossProjectLeaks: 0,
};

// ── Sink management ───────────────────────────────────────────────────────────

/**
 * Replace the active sink.  Call this at startup when Part 1 becomes available.
 * The NoopSegmentSink is restored by _resetForTests().
 */
export function setSink(sink: ISegmentSink): void {
	_sink = sink;
}

/** Get the active sink */
export function getSink(): ISegmentSink {
	return _sink;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/** Return a snapshot of the current queue statistics. */
export function getSegmentQueueStats(): SegmentQueueStats {
	return { ..._stats };
}

/**
 * Increment the cross-project leak counter.
 * Called by filterToProject() in injectionBlock.ts (P2-T07).
 */
export function recordCrossProjectLeaks(count: number): void {
	if (count > 0) {
		_stats.crossProjectLeaks += count;
	}
}

// ── Drain ─────────────────────────────────────────────────────────────────────

/** Promise that resolves when the current drain cycle completes. */
let _drainPromise: Promise<void> | null = null;
let _drainResolve: (() => void) | null = null;

/**
 * Drain all buffered segments to the sink in one batch.
 * Called via setImmediate — never on the synchronous chat path.
 * Any sink error is caught and logged; it never propagates.
 */
async function drain(): Promise<void> {
	_drainScheduled = false;

	if (_ring.length > 0) {
		const batch = _ring.splice(0, _ring.length);

		try {
			await _sink.ingest(batch);
			_stats.drained += batch.length;
		} catch (err) {
			// Sink errors must never reach the chat path.
			process.stderr.write(`[PPB] segmentQueue drain error: ${String(err)}\n`);
			// Count as dropped so stats remain meaningful.
			_stats.dropped += batch.length;
		}
	}

	if (_drainResolve) {
		_drainResolve();
		_drainResolve = null;
		_drainPromise = null;
	}
}

/** Schedule a drain on the next iteration of the event loop (if not already scheduled). */
function scheduleDrain(): void {
	if (_drainScheduled) { return; }
	_drainScheduled = true;
	
	if (!_drainPromise) {
		_drainPromise = new Promise(resolve => {
			_drainResolve = resolve;
		});
	}

	setImmediate(() => { drain().catch(() => { /* already handled inside drain */ }); });
}

/**
 * Wait for any pending drain operation to complete.
 * Exported specifically for tests to avoid timing-dependent setTimeouts.
 */
export async function flush(): Promise<void> {
	if (_drainPromise) {
		await _drainPromise;
	}
}

// ── Ring buffer write ─────────────────────────────────────────────────────────

function pushToRing(segment: ConversationSegment): void {
	if (_ring.length < RING_CAPACITY) {
		_ring.push(segment);
	} else {
		// Ring full: evict the oldest entry (index 0) and append to tail.
		// This retains the most recent context.
		_ring.shift();
		_ring.push(segment);
		_stats.overflows++;
	}
}

// ── Public enqueue ────────────────────────────────────────────────────────────

/**
 * Enqueue a segment for async ingestion.
 *
 * This function:
 *   1. Validates projectId (non-empty string).
 *   2. Checks resolvePreferences(projectId).ppbEnabled.
 *   3. Applies PII redaction and normalisation.
 *   4. Calls shouldIngest() on the cleaned text.
 *   5. Pushes the segment into the ring buffer.
 *   6. Schedules a drain via setImmediate.
 *
 * NEVER throws. NEVER awaited by callers.
 *
 * @param raw  The raw segment to enqueue.  `text` is redacted + normalised internally.
 */
export function enqueue(raw: Omit<ConversationSegment, 'text'> & { text: string }): void {
	try {
		// Guard 1: projectId must be present.
		if (!raw.projectId || typeof raw.projectId !== 'string') {
			process.stderr.write('[PPB] segmentQueue.enqueue: missing projectId — segment dropped\n');
			_stats.dropped++;
			return;
		}

		// Guard 2: ppbEnabled must be true for this project.
		let ppbEnabled = false;
		try {
			ppbEnabled = resolvePreferences(raw.projectId).ppbEnabled;
		} catch {
			// resolvePreferences should never throw, but be defensive.
			_stats.dropped++;
			return;
		}
		if (!ppbEnabled) {
			_stats.dropped++;
			return;
		}

		// Guard 3: PII redaction + normalisation + shouldIngest.
		const redacted = applyPiiRedaction(raw.text);
		const cleaned = normalise(redacted);
		if (!shouldIngest(cleaned)) {
			_stats.dropped++;
			return;
		}

		// All guards passed — push to ring and schedule drain.
		pushToRing({ ...raw, text: cleaned });
		_stats.queued++;
		scheduleDrain();
	} catch (err) {
		// Safety net: enqueue must never throw under any circumstance.
		process.stderr.write(`[PPB] segmentQueue.enqueue unexpected error: ${String(err)}\n`);
		_stats.dropped++;
	}
}

// ── Internal test helpers ─────────────────────────────────────────────────────

/**
 * Reset all in-memory state.  ONLY for use in unit tests.
 * @internal
 */
export function _resetQueueForTests(): void {
	_ring = [];
	_drainScheduled = false;
	if (_drainResolve) { _drainResolve(); }
	_drainPromise = null;
	_drainResolve = null;
	_sink = new NoopSegmentSink();
	_stats = {
		queued: 0,
		drained: 0,
		dropped: 0,
		overflows: 0,
		crossProjectLeaks: 0,
	};
}

/**
 * Return the current ring buffer contents (a copy).  ONLY for use in unit tests.
 * @internal
 */
export function _getRingForTests(): ConversationSegment[] {
	return [..._ring];
}

/**
 * Return the current sink.  ONLY for use in unit tests.
 * @internal
 */
export function _getSinkForTests(): ISegmentSink {
	return _sink;
}
