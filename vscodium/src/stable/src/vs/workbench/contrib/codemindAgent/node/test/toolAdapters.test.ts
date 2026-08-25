/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { projectBrainAdapter } from '../orchestration/toolAdapters/projectBrainAdapter.js';
import { DeveloperIntent } from '../orchestration/types.js';
import { TraceCollector } from '../orchestration/traceCollector.js';
import { makeRequest, makeIntent, makeSelectionContext } from './orchestrationTestUtils.js';

/**
 * Two things are proven here:
 *   1. projectBrainAdapter — the ONE real adapter left after the six shadow adapters were
 *      removed — still honours its Phase-1 stub contract.
 *   2. TraceCollector — the Layer-3/Layer-6 observer that REPLACED the shadow adapters. It
 *      watches the real Claude Agent SDK tool stream (tool_use → recordToolCall,
 *      tool_result → recordToolResult, result → finalize) and builds the 7-layer dev-mode
 *      trace whose Layer 3 lists the tools the model ACTUALLY invoked (Read/Write/Bash/…),
 *      never adapter names, and whose Layer 6 carries the ACTUAL Headroom result.
 */

/** A structurally-valid HeadroomResult for the Layer-6 assertions (no proxy involved). */
function hr(opts: {
	mode?: 'none' | 'light' | 'aggressive'; headroomAvailable?: boolean; proxyReachable?: boolean;
	originalTokens?: number; compressedTokens?: number;
} = {}) {
	const originalTokens = opts.originalTokens ?? 100;
	const compressedTokens = opts.compressedTokens ?? 60;
	return {
		compressedSuffix: 'compressed-suffix',
		originalTokens,
		compressedTokens,
		tokensSaved: Math.max(0, originalTokens - compressedTokens),
		compressionRatio: originalTokens ? compressedTokens / originalTokens : 1,
		mode: opts.mode ?? 'light',
		headroomAvailable: opts.headroomAvailable ?? true,
		proxyReachable: opts.proxyReachable ?? true,
		transformsApplied: ['summarize'],
		durationMs: 7,
	};
}

/** A structurally-valid terminal `result` message for the Layer-7 assertions. */
function resultMsg(over: Record<string, unknown> = {}) {
	return {
		model: 'claude-opus-4-8-thinking',
		session_id: 's-1',
		duration_ms: 1234,
		total_cost_usd: 0.0201,
		usage: { input_tokens: 111, output_tokens: 222 },
		...over,
	};
}

/** Finalize a collector in dev mode and pull individual layers out by index (1..7). */
class Finalizer {
	readonly trace: any;
	constructor(tc: TraceCollector, over: Record<string, unknown> = {}) {
		this.trace = tc.finalize(resultMsg(over), 'q-fin', true);
	}
	layer(index: number): any { return this.trace.layers.find((l: any) => l.layerIndex === index); }
}

suite('Orchestration › projectBrainAdapter (the one surviving real adapter)', () => {

	test('execute() returns the Phase-1 "not yet available" stub', async () => {
		const out = await projectBrainAdapter.execute(makeRequest());
		assert.strictEqual(out.adapterId, 'projectBrainAdapter');
		assert.strictEqual(out.status, 'success');
		assert.ok(out.projectBrain, 'projectBrain payload present');
		assert.strictEqual(out.projectBrain!.available, false);
		assert.match(out.projectBrain!.reason!, /Phase 1/);
		assert.deepStrictEqual(out.projectBrain!.facts, []);
		assert.deepStrictEqual(out.projectBrain!.decisions, []);
	});

	test('advertises its id, name, capabilities and a fast TIMEOUT_MS', () => {
		assert.strictEqual(projectBrainAdapter.id, 'projectBrainAdapter');
		assert.strictEqual(projectBrainAdapter.name, 'Project Brain');
		assert.strictEqual(projectBrainAdapter.TIMEOUT_MS, 50);
		assert.deepStrictEqual(
			projectBrainAdapter.capabilities,
			['project_memory', 'architecture_history', 'decision_history']);
	});

	test('shouldRun() is always true (stub is unconditionally available)', () => {
		assert.strictEqual(projectBrainAdapter.shouldRun(makeIntent(DeveloperIntent.MEMORY_RETRIEVAL), makeSelectionContext()), true);
		assert.strictEqual(projectBrainAdapter.shouldRun(makeIntent(DeveloperIntent.WEB_SEARCH), makeSelectionContext({ hasOpenFiles: true })), true);
	});
});

suite('Orchestration › TraceCollector (real SDK-stream observer)', () => {

	// --- dev-mode gating: zero overhead when the 🐛 toggle is off ---
	test('finalize() returns null when dev mode is OFF', () => {
		const tc = new TraceCollector();
		tc.recordIntent(makeIntent(DeveloperIntent.CODE_GENERATION));
		assert.strictEqual(tc.finalize(resultMsg(), 'q-off', false), null);
	});

	test('finalize() returns a trace object when dev mode is ON', () => {
		const tc = new TraceCollector();
		tc.recordIntent(makeIntent(DeveloperIntent.CODE_GENERATION));
		const trace = tc.finalize(resultMsg(), 'q-on', true);
		assert.ok(trace, 'a trace is produced in dev mode');
		assert.strictEqual(trace!.queryId, 'q-on');
	});

	// --- the 7-layer skeleton ---
	test('builds exactly 7 layers, indexed 1..7 in order', () => {
		const trace = new TraceCollector().finalize(resultMsg(), 'q', true)!;
		assert.strictEqual(trace.layers.length, 7);
		assert.deepStrictEqual(trace.layers.map(l => l.layerIndex), [1, 2, 3, 4, 5, 6, 7]);
	});

	test('layer names are the canonical 7 in pipeline order', () => {
		const trace = new TraceCollector().finalize(resultMsg(), 'q', true)!;
		assert.deepStrictEqual(trace.layers.map(l => l.layerName), [
			'intentDetection', 'toolSelection', 'toolExecution',
			'contextAggregation', 'contextOptimization', 'headroomCompression', 'claudeAgentSDK',
		]);
	});

	// --- Layer 3 is the whole point: it lists the tools the MODEL invoked ---
	test('Layer 3 lists the REAL SDK tool names the model invoked (Read/Grep/Bash)', () => {
		const tc = new TraceCollector();
		tc.recordToolCall({ toolName: 'Read', toolId: 't1', input: { file_path: '/a.ts' }, startMs: 1000 });
		tc.recordToolCall({ toolName: 'Grep', toolId: 't2', input: { pattern: 'foo' }, startMs: 1001 });
		tc.recordToolCall({ toolName: 'Bash', toolId: 't3', input: { command: 'ls' }, startMs: 1002 });
		tc.recordToolResult({ toolId: 't1', content: 'file body', isError: false, durationMs: 12 });
		tc.recordToolResult({ toolId: 't2', content: 'match', isError: false, durationMs: 8 });
		tc.recordToolResult({ toolId: 't3', content: 'a.ts b.ts', isError: false, durationMs: 20 });
		const l3 = new Finalizer(tc).layer(3);
		assert.strictEqual(typeof l3.output, 'string');
		for (const name of ['Read', 'Grep', 'Bash']) { assert.ok(l3.output.includes(name), `Layer 3 should mention ${name}`); }
		assert.match(l3.notes[0], /3 tool call\(s\): Read, Grep, Bash/);
	});

	test('Layer 3 NEVER lists shadow-adapter names (they were removed)', () => {
		const tc = new TraceCollector();
		tc.recordToolCall({ toolName: 'Read', toolId: 't1', input: {}, startMs: 1 });
		tc.recordToolResult({ toolId: 't1', content: 'x', isError: false, durationMs: 1 });
		const l3 = new Finalizer(tc).layer(3);
		for (const adapter of ['repositoryAdapter', 'fileContextAdapter', 'dependencyAdapter', 'gitAdapter', 'webSearchAdapter', 'terminalAdapter']) {
			assert.ok(!l3.output.includes(adapter), `Layer 3 must not mention ${adapter}`);
		}
	});

	test('Layer 3 is "error" when any tool result is an error, else "pass"', () => {
		const ok = new TraceCollector();
		ok.recordToolCall({ toolName: 'Read', toolId: 'a', input: {}, startMs: 1 });
		ok.recordToolResult({ toolId: 'a', content: 'ok', isError: false, durationMs: 3 });
		assert.strictEqual(new Finalizer(ok).layer(3).status, 'pass');

		const bad = new TraceCollector();
		bad.recordToolCall({ toolName: 'Bash', toolId: 'b', input: { command: 'nope' }, startMs: 1 });
		bad.recordToolResult({ toolId: 'b', content: 'command not found', isError: true, durationMs: 4 });
		const l3 = new Finalizer(bad).layer(3);
		assert.strictEqual(l3.status, 'error');
		assert.ok(l3.notes.some((n: string) => /error/i.test(n)), 'an error note is present');
	});

	test('recordToolCall dedupes by toolId (a duplicate tool_use is ignored)', () => {
		const tc = new TraceCollector();
		tc.recordToolCall({ toolName: 'Read', toolId: 'dup', input: {}, startMs: 1 });
		tc.recordToolCall({ toolName: 'Read', toolId: 'dup', input: {}, startMs: 2 });
		tc.recordToolResult({ toolId: 'dup', content: 'x', isError: false, durationMs: 1 });
		assert.match(new Finalizer(tc).layer(3).notes[0], /^1 tool call\(s\)/);
	});

	test('a tool_result for an UNRECORDED id is ignored (sub-agent results not traced)', () => {
		const tc = new TraceCollector();
		tc.recordToolCall({ toolName: 'Read', toolId: 'main', input: {}, startMs: 1 });
		tc.recordToolResult({ toolId: 'main', content: 'ok', isError: false, durationMs: 5 });
		// A result whose tool_use was never seen on the main stream (e.g. a sub-agent's Task):
		tc.recordToolResult({ toolId: 'sub-agent-only', content: 'ignored', isError: true, durationMs: 99 });
		const l3 = new Finalizer(tc).layer(3);
		assert.match(l3.notes[0], /^1 tool call\(s\)/);
		assert.strictEqual(l3.status, 'pass', 'the stray sub-agent error must not colour Layer 3');
	});

	test('getToolStartMs returns the recorded start, and a live fallback for unknown ids', () => {
		const tc = new TraceCollector();
		tc.recordToolCall({ toolName: 'Read', toolId: 'k', input: {}, startMs: 4242 });
		assert.strictEqual(tc.getToolStartMs('k'), 4242);
		assert.ok(tc.getToolStartMs('missing') > 0, 'unknown id falls back to a positive timestamp');
	});

	test('Layer 3 carries the per-tool duration and sums it into the layer duration', () => {
		const tc = new TraceCollector();
		tc.recordToolCall({ toolName: 'Read', toolId: 'a', input: {}, startMs: 1 });
		tc.recordToolCall({ toolName: 'Bash', toolId: 'b', input: { command: 'ls' }, startMs: 2 });
		tc.recordToolResult({ toolId: 'a', content: 'x', isError: false, durationMs: 10 });
		tc.recordToolResult({ toolId: 'b', content: 'y', isError: false, durationMs: 25 });
		const l3 = new Finalizer(tc).layer(3);
		assert.strictEqual(l3.durationMs, 35, 'layer duration is the sum of tool durations');
		assert.ok(l3.output.includes('10') && l3.output.includes('25'), 'per-tool ms are rendered');
	});

	test('Layer 3 notes that the model answered directly when no tools ran', () => {
		const l3 = new Finalizer(new TraceCollector()).layer(3);
		assert.strictEqual(l3.status, 'pass');
		assert.match(l3.notes[0], /no tool calls this turn/);
	});

	// --- Layer 4: which files the tool results touched ---
	test('Layer 4 lists files touched by Read/Write/Edit, ignoring Bash', () => {
		const tc = new TraceCollector();
		tc.recordToolCall({ toolName: 'Read', toolId: 'r', input: { file_path: '/src/login.ts' }, startMs: 1 });
		tc.recordToolCall({ toolName: 'Write', toolId: 'w', input: { file_path: '/src/clerk.ts' }, startMs: 2 });
		tc.recordToolCall({ toolName: 'Bash', toolId: 'b', input: { command: 'npm i @clerk/clerk-react' }, startMs: 3 });
		for (const id of ['r', 'w', 'b']) { tc.recordToolResult({ toolId: id, content: 'ok', isError: false, durationMs: 1 }); }
		const l4 = new Finalizer(tc).layer(4);
		assert.ok(l4.output.includes('/src/login.ts'), 'Read target present');
		assert.ok(l4.output.includes('/src/clerk.ts'), 'Write target present');
		assert.ok(!l4.output.includes('npm i'), 'Bash command is not a touched file');
	});

	// --- Layer 6: the ACTUAL HeadroomResult, local-proxy only ---
	test('Layer 6 carries the actual Headroom metadata (mode + token counts)', () => {
		const tc = new TraceCollector();
		tc.recordHeadroom(hr({ mode: 'aggressive', originalTokens: 900, compressedTokens: 300 }));
		const l6 = new Finalizer(tc).layer(6);
		assert.strictEqual(l6.status, 'pass');
		assert.strictEqual(l6.headroom.mode, 'aggressive');
		assert.strictEqual(l6.headroom.originalTokens, 900);
		assert.strictEqual(l6.headroom.compressedTokens, 300);
		assert.strictEqual(l6.headroom.tokensSaved, 600);
		assert.strictEqual(l6.inputTokenEstimate, 900);
		assert.strictEqual(l6.outputTokenEstimate, 300);
		assert.strictEqual(l6.headroom.baseUrl, 'http://localhost:7878', 'Layer 6 stays local-proxy only');
	});

	test('Layer 6 is "skipped" when no compression happened this turn', () => {
		const l6 = new Finalizer(new TraceCollector()).layer(6);
		assert.strictEqual(l6.status, 'skipped');
		assert.strictEqual(l6.headroom, undefined);
		assert.match(l6.notes[0], /not engaged/);
	});

	test('Layer 6 notes reflect a passthrough when the proxy is unreachable', () => {
		const tc = new TraceCollector();
		tc.recordHeadroom(hr({ mode: 'light', headroomAvailable: true, proxyReachable: false }));
		const l6 = new Finalizer(tc).layer(6);
		assert.ok(l6.notes.some((n: string) => /unreachable|passthrough/i.test(n)));
	});

	// --- Layer 1: intent classification is carried verbatim ---
	test('Layer 1 carries the classified intent, confidence and signals', () => {
		const tc = new TraceCollector();
		const intent = makeIntent(DeveloperIntent.DEBUGGING, 0.77, ['stack trace', 'error']);
		tc.recordIntent(intent);
		const l1 = new Finalizer(tc).layer(1);
		assert.ok(l1.output.includes(String(intent.intent)), 'intent name rendered');
		assert.ok(l1.output.includes('0.77'), 'confidence rendered');
		assert.deepStrictEqual(l1.notes, ['stack trace', 'error']);
	});

	test('Layer 1 degrades to "unknown"/"no signals" when no intent was recorded', () => {
		const l1 = new Finalizer(new TraceCollector()).layer(1);
		assert.ok(l1.output.includes('unknown'));
		assert.deepStrictEqual(l1.notes, ['no signals']);
	});

	// --- Layer 2: the SDK tool registry available this turn ---
	test('Layer 2 lists the SDK tools when a registry was recorded', () => {
		const tc = new TraceCollector();
		tc.recordToolRegistry(['Read', 'Write', 'Bash', 'Grep', 'Glob', 'WebSearch']);
		const l2 = new Finalizer(tc).layer(2);
		assert.ok(l2.output.includes('WebSearch') && l2.output.includes('Read'));
	});

	test('Layer 2 falls back to "(sdk defaults)" when no registry was recorded', () => {
		assert.ok(new Finalizer(new TraceCollector()).layer(2).output.includes('sdk defaults'));
	});

	// --- Layer 5: the minimal intent-hint suffix ---
	test('Layer 5 carries the raw intent-hint suffix fed into Headroom', () => {
		const tc = new TraceCollector();
		tc.recordSuffix('[CODEMIND ORCHESTRATION]\nDetected intent: debugging');
		assert.ok(new Finalizer(tc).layer(5).output.includes('CODEMIND ORCHESTRATION'));
	});

	test('Layer 5 shows "(empty suffix)" when nothing was recorded', () => {
		assert.ok(new Finalizer(new TraceCollector()).layer(5).output.includes('(empty suffix)'));
	});

	// --- Layer 7: the terminal SDK result message ---
	test('Layer 7 reflects the result message model, token usage and cost', () => {
		const l7 = new Finalizer(new TraceCollector(), {
			model: 'glm-5.2', usage: { input_tokens: 333, output_tokens: 444 },
			total_cost_usd: 0.5, duration_ms: 999,
		}).layer(7);
		assert.ok(l7.output.includes('glm-5.2'), 'model rendered');
		assert.ok(l7.output.includes('333') && l7.output.includes('444'), 'token usage rendered');
		assert.match(l7.notes[0], /glm-5\.2/);
	});

	// --- trace-level fields ---
	test('trace.intent mirrors the classified intent', () => {
		const tc = new TraceCollector();
		const intent = makeIntent(DeveloperIntent.ARCHITECTURE);
		tc.recordIntent(intent);
		assert.strictEqual(new Finalizer(tc).trace.intent, intent.intent);
	});

	test('trace.originalTokens / finalTokens come from the Headroom result', () => {
		const tc = new TraceCollector();
		tc.recordHeadroom(hr({ originalTokens: 800, compressedTokens: 200 }));
		const trace = new Finalizer(tc).trace;
		assert.strictEqual(trace.originalTokens, 800);
		assert.strictEqual(trace.finalTokens, 200);
	});

	test('trace is neither a cache hit nor timed out (there is no cache anymore)', () => {
		const trace = new Finalizer(new TraceCollector()).trace;
		assert.strictEqual(trace.cacheHit, false);
		assert.strictEqual(trace.timedOut, false);
	});

	test('trace.totalDurationMs is a non-negative number', () => {
		const trace = new Finalizer(new TraceCollector()).trace;
		assert.strictEqual(typeof trace.totalDurationMs, 'number');
		assert.ok(trace.totalDurationMs >= 0);
	});

	test('oversized tool inputs are preview-capped (no unbounded trace rows)', () => {
		const tc = new TraceCollector();
		tc.recordToolCall({ toolName: 'Read', toolId: 'big', input: { file_path: 'x'.repeat(5000) }, startMs: 1 });
		tc.recordToolResult({ toolId: 'big', content: 'ok', isError: false, durationMs: 1 });
		assert.ok(new Finalizer(tc).layer(3).output.length <= 501, 'Layer 3 output is capped');
	});
});
