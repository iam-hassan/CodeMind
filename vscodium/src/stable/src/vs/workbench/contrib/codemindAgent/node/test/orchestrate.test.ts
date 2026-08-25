/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { orchestrate, setDevMode } from '../codeMindOrchestrationEngine.js';
import { DeveloperIntent } from '../orchestration/types.js';
import { fakeRegistry, makeRequest } from './orchestrationTestUtils.js';

/**
 * End-to-end proof of the POST-shadow-adapter orchestrate() coordinator.
 *
 * orchestrate() now does exactly two honest things: (1) classify the developer's intent,
 * and (2) return a MINIMAL intent-hint suffix that nudges the model to gather context with
 * its OWN tools (Read/Grep/Glob/Bash/WebSearch). It runs NO adapters, aggregates NO context,
 * caches NOTHING, and emits NO trace — the real Layer-3 tool list and Layer-6 Headroom result
 * are observed downstream by the engine-main TraceCollector against the live SDK stream.
 *
 * So the assertions here are the new contract: empty toolsExecuted/toolsFailed, a clean
 * enrichedPrompt, the [CODEMIND ORCHESTRATION] hint suffix (never a serialized === REPOSITORY
 * === blob), intent_detection-only progress, and the registry argument being ignored.
 */
suite('Orchestration › orchestrate (integration, post shadow-adapter removal)', () => {

	setup(() => setDevMode(false));
	teardown(() => setDevMode(false));

	const noop = () => { /* ignore progress */ };
	const REG = fakeRegistry([]); // orchestrate ignores the registry entirely now

	// --- A.7 fast path (prompt trimmed < 20 chars) ---
	test('fast path returns the prompt unchanged with an empty suffix and no progress events', async () => {
		const events: any[] = [];
		const res = await orchestrate(makeRequest({ userPrompt: 'hi there' }), REG, e => events.push(e));
		assert.strictEqual(res.enrichedPrompt, 'hi there');
		assert.strictEqual(res.systemPromptSuffix, '');
		assert.deepStrictEqual(res.orchestrationMetadata.toolsExecuted, []);
		assert.strictEqual(events.length, 0);
	});

	test('fast path metadata is the documented default (CODE_GENERATION, 0.5, mode none)', async () => {
		const res = await orchestrate(makeRequest({ userPrompt: 'short' }), REG, noop);
		const m = res.orchestrationMetadata;
		assert.strictEqual(m.intent, DeveloperIntent.CODE_GENERATION);
		assert.strictEqual(m.confidence, 0.5);
		assert.strictEqual(m.compressionMode, 'none');
		assert.strictEqual(m.headroomAvailable, false);
		assert.strictEqual(m.totalDurationMs, 0);
	});

	test('the <20-char boundary is exact: 19 chars is fast, 20 chars runs the full path', async () => {
		const fast = await orchestrate(makeRequest({ userPrompt: 'a'.repeat(19) }), REG, noop);
		assert.strictEqual(fast.systemPromptSuffix, '', '19 chars → fast path (empty suffix)');
		const full = await orchestrate(makeRequest({ userPrompt: 'a'.repeat(20) }), REG, noop);
		assert.ok(full.systemPromptSuffix.length > 0, '20 chars → full path (hint suffix)');
	});

	// --- normal path: intent classification + minimal hint suffix, NO adapters ---
	const REVIEW = 'review this code for any issues here';

	test('enrichedPrompt is the clean, unchanged user prompt (nothing is prepended)', async () => {
		const req = makeRequest({ userPrompt: REVIEW });
		const res = await orchestrate(req, REG, noop);
		assert.strictEqual(res.enrichedPrompt, req.userPrompt);
	});

	test('systemPromptSuffix is the minimal [CODEMIND ORCHESTRATION] intent hint', async () => {
		const res = await orchestrate(makeRequest({ userPrompt: REVIEW }), REG, noop);
		const s = res.systemPromptSuffix;
		assert.ok(s.startsWith('\n\n[CODEMIND ORCHESTRATION]\n'), 'suffix begins with the orchestration marker');
		assert.ok(s.includes('Detected intent:'), 'suffix names the detected intent');
		assert.ok(
			s.includes('Gather any missing context with your own tools (Read, Grep, Glob, Bash, WebSearch)'),
			'suffix delegates context gathering to the SDK tools');
	});

	test('the suffix NEVER carries a serialized adapter context blob (that layer is gone)', async () => {
		const res = await orchestrate(makeRequest({ userPrompt: REVIEW }), REG, noop);
		assert.ok(!res.systemPromptSuffix.includes('=== REPOSITORY ==='), 'no repository blob');
		assert.ok(!res.systemPromptSuffix.includes('=== FILE:'), 'no file blob');
		assert.ok(!res.systemPromptSuffix.includes('Pre-fetched context:'), 'no pre-fetched-context line');
	});

	test('no adapters are executed — toolsExecuted and toolsFailed are both empty', async () => {
		const res = await orchestrate(makeRequest({ userPrompt: REVIEW }), REG, noop);
		assert.deepStrictEqual(res.orchestrationMetadata.toolsExecuted, []);
		assert.deepStrictEqual(res.orchestrationMetadata.toolsFailed, []);
	});

	test('orchestrate reports no compression itself (Headroom runs in the engine main)', async () => {
		const res = await orchestrate(makeRequest({ userPrompt: REVIEW }), REG, noop);
		assert.strictEqual(res.orchestrationMetadata.compressionMode, 'none');
		assert.strictEqual(res.orchestrationMetadata.headroomAvailable, false);
	});

	test('the suffix names the SAME intent + confidence the metadata reports', async () => {
		const res = await orchestrate(makeRequest({ userPrompt: REVIEW }), REG, noop);
		const m = res.orchestrationMetadata;
		assert.ok(Object.values(DeveloperIntent).includes(m.intent), 'metadata.intent is a real DeveloperIntent');
		assert.ok(res.systemPromptSuffix.includes(String(m.intent)), 'suffix echoes metadata.intent');
		assert.ok(res.systemPromptSuffix.includes(`(confidence ${m.confidence.toFixed(2)})`), 'suffix echoes metadata.confidence');
	});

	test('token estimates equal ceil(suffixLength/4) and are equal pre/post (no compression here)', async () => {
		const res = await orchestrate(makeRequest({ userPrompt: REVIEW }), REG, noop);
		const m = res.orchestrationMetadata;
		const expected = Math.ceil(res.systemPromptSuffix.length / 4);
		assert.strictEqual(m.originalTokenEstimate, expected);
		assert.strictEqual(m.finalTokenEstimate, expected);
	});

	test('progress is intent_detection-only (running → complete), never tool_execution', async () => {
		const events: any[] = [];
		await orchestrate(makeRequest({ userPrompt: REVIEW }), REG, e => events.push(e));
		const prog = events.filter(e => e.type === 'orchestration_progress');
		assert.deepStrictEqual(prog.map(e => e.phase), ['intent_detection', 'intent_detection']);
		assert.deepStrictEqual(prog.map(e => e.status), ['running', 'complete']);
		assert.ok(!prog.some(e => e.phase === 'tool_execution'), 'no tool_execution phase anymore');
	});

	test('orchestrate emits NO trace event, even in dev mode (the engine main owns the trace)', async () => {
		setDevMode(true);
		const events: any[] = [];
		await orchestrate(makeRequest({ userPrompt: REVIEW }), REG, e => events.push(e));
		assert.ok(!events.some(e => e.type === 'orchestration_trace'), 'orchestrate() never emits a trace');
	});

	test('the registry argument is ignored: an empty registry yields the same result', async () => {
		const req = makeRequest({ userPrompt: REVIEW });
		const a = await orchestrate(req, fakeRegistry([]), noop);
		const b = await orchestrate(req, REG, noop);
		assert.strictEqual(a.systemPromptSuffix, b.systemPromptSuffix);
		assert.strictEqual(a.orchestrationMetadata.intent, b.orchestrationMetadata.intent);
	});

	test('orchestrationMetadata is fully populated and well-typed', async () => {
		const res = await orchestrate(makeRequest({ userPrompt: REVIEW }), REG, noop);
		const m = res.orchestrationMetadata;
		assert.ok(Object.values(DeveloperIntent).includes(m.intent));
		assert.strictEqual(typeof m.confidence, 'number');
		assert.deepStrictEqual(m.toolsExecuted, []);
		assert.deepStrictEqual(m.toolsFailed, []);
		assert.strictEqual(typeof m.originalTokenEstimate, 'number');
		assert.strictEqual(typeof m.finalTokenEstimate, 'number');
		assert.strictEqual(m.compressionMode, 'none');
		assert.strictEqual(typeof m.headroomAvailable, 'boolean');
		assert.strictEqual(typeof m.totalDurationMs, 'number');
	});
});
