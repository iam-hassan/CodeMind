/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { orchestrate, setDevMode } from '../codeMindOrchestrationEngine.js';
import { DeveloperIntent } from '../orchestration/types.js';
import {
	realRegistry, fakeRegistry, makeFakeAdapter, makeRequest, makeTempWorkspace, rmWorkspace,
} from './orchestrationTestUtils.js';

/**
 * End-to-end proof of the orchestrate() coordinator: the <20-char fast path, the full
 * 7-layer pipeline against real adapters + a temp workspace (enrichedPrompt, suffix,
 * toolsExecuted, compression mode), progress-event ordering, the dev-mode 7-layer trace,
 * the result-cache hit on a repeated identical request, and deterministic fake-registry runs.
 */
suite('Orchestration › orchestrate (integration)', () => {

	let tempDirs: string[] = [];
	const ws = async (files: Record<string, string>): Promise<string> => {
		const d = await makeTempWorkspace(files);
		tempDirs.push(d);
		return d;
	};
	setup(() => setDevMode(false));
	teardown(async () => { setDevMode(false); for (const d of tempDirs) { await rmWorkspace(d); } tempDirs = []; });

	const noop = () => { /* ignore progress */ };

	// --- A.7 fast path (prompt trimmed < 20 chars) ---
	test('fast path returns the prompt unchanged with an empty suffix and no progress events', async () => {
		const events: any[] = [];
		const res = await orchestrate(makeRequest({ userPrompt: 'hi there' }), realRegistry(), e => events.push(e));
		assert.strictEqual(res.enrichedPrompt, 'hi there');
		assert.strictEqual(res.systemPromptSuffix, '');
		assert.deepStrictEqual(res.orchestrationMetadata.toolsExecuted, []);
		assert.strictEqual(events.length, 0);
	});

	test('fast path metadata is the documented default (CODE_GENERATION, 0.5, mode none)', async () => {
		const res = await orchestrate(makeRequest({ userPrompt: 'short' }), realRegistry(), noop);
		const m = res.orchestrationMetadata;
		assert.strictEqual(m.intent, DeveloperIntent.CODE_GENERATION);
		assert.strictEqual(m.confidence, 0.5);
		assert.strictEqual(m.compressionMode, 'none');
		assert.strictEqual(m.headroomAvailable, false);
		assert.strictEqual(m.totalDurationMs, 0);
	});

	// --- full pipeline against the real adapters + a temp workspace ---
	const reviewReq = async () => {
		const dir = await ws({ 'login.ts': 'export const login = () => true;', 'package.json': '{}' });
		return makeRequest({ userPrompt: 'review this code for any issues here', workspaceFolder: dir, openFiles: [dir + '/login.ts'] });
	};

	test('full pipeline prepends the serialized REPOSITORY and FILE context', async () => {
		const res = await orchestrate(await reviewReq(), realRegistry(), noop);
		assert.ok(res.enrichedPrompt.includes('=== REPOSITORY ==='), 'repository section present');
		assert.ok(res.enrichedPrompt.includes('=== FILE:'), 'file section present');
	});

	test('enrichedPrompt ends with the raw user prompt and is not equal to it', async () => {
		const req = await reviewReq();
		const res = await orchestrate(req, realRegistry(), noop);
		assert.ok(res.enrichedPrompt.endsWith(req.userPrompt));
		assert.notStrictEqual(res.enrichedPrompt, req.userPrompt);
	});

	test('CODE_REVIEW with an open file executes fileContext + repository, nothing failed', async () => {
		const res = await orchestrate(await reviewReq(), realRegistry(), noop);
		assert.deepStrictEqual(res.orchestrationMetadata.toolsExecuted, ['fileContextAdapter', 'repositoryAdapter']);
		assert.deepStrictEqual(res.orchestrationMetadata.toolsFailed, []);
	});

	test('systemPromptSuffix lists exactly the present sections', async () => {
		const res = await orchestrate(await reviewReq(), realRegistry(), noop);
		assert.strictEqual(res.systemPromptSuffix,
			'\n\n[CODEMIND ORCHESTRATION]\nDetected intent: code_review\n' +
			'Pre-fetched context: repository, currentFiles\nProject Brain: stub\n' +
			'Do not ask for information already in the context above.');
	});

	test('metadata reflects the classified intent and a lossless compression mode', async () => {
		const res = await orchestrate(await reviewReq(), realRegistry(), noop);
		const m = res.orchestrationMetadata;
		assert.strictEqual(m.intent, DeveloperIntent.CODE_REVIEW);
		assert.ok(Math.abs(m.confidence - 0.833) < 0.01, `confidence ${m.confidence}`);
		assert.strictEqual(m.compressionMode, 'none');
		assert.strictEqual(m.headroomAvailable, false);
	});

	test('progress events run intent_detection before tool_execution', async () => {
		const events: any[] = [];
		await orchestrate(await reviewReq(), realRegistry(), e => events.push(e));
		const phases = events.filter(e => e.type === 'orchestration_progress').map(e => e.phase);
		assert.ok(phases.includes('intent_detection'), 'intent_detection emitted');
		assert.ok(phases.includes('tool_execution'), 'tool_execution emitted');
		assert.ok(phases.indexOf('intent_detection') < phases.indexOf('tool_execution'), 'ordering');
	});

	// --- dev-mode trace (B.2) ---
	test('dev mode emits a 7-layer trace (indices 1..7) for a cache-miss run', async () => {
		setDevMode(true);
		const events: any[] = [];
		await orchestrate(await reviewReq(), realRegistry(), e => events.push(e));
		const traceEvt = events.find(e => e.type === 'orchestration_trace');
		assert.ok(traceEvt, 'a trace event was emitted');
		assert.strictEqual(traceEvt.trace.layers.length, 7);
		assert.deepStrictEqual(traceEvt.trace.layers.map((l: any) => l.layerIndex), [1, 2, 3, 4, 5, 6, 7]);
		assert.strictEqual(traceEvt.trace.cacheHit, false);
		assert.strictEqual(typeof traceEvt.trace.originalTokens, 'number');
		assert.strictEqual(typeof traceEvt.trace.finalTokens, 'number');
	});

	test('the dev-mode trace names the first and last layers', async () => {
		setDevMode(true);
		const events: any[] = [];
		await orchestrate(await reviewReq(), realRegistry(), e => events.push(e));
		const names = events.find(e => e.type === 'orchestration_trace').trace.layers.map((l: any) => l.layerName);
		assert.strictEqual(names[0], 'intentDetection');
		assert.strictEqual(names[names.length - 1], 'claudeAgentSDK');
	});

	// --- A.5 result cache ---
	test('a repeated identical request eventually hits the cache (confidence 0.9)', async () => {
		const req = await reviewReq();
		await orchestrate(req, realRegistry(), noop); // warm 1 — stores under old-_lastIntent key
		await orchestrate(req, realRegistry(), noop); // warm 2 — stores under stable-_lastIntent key
		const events: any[] = [];
		const res = await orchestrate(req, realRegistry(), e => events.push(e)); // 3 — hit
		assert.ok(events.some(e => e.phase === 'cache_hit'), 'cache_hit progress emitted');
		assert.strictEqual(res.orchestrationMetadata.confidence, 0.9);
		assert.deepStrictEqual(res.orchestrationMetadata.toolsExecuted, ['fileContextAdapter', 'repositoryAdapter']);
	});

	// --- deterministic fake registries ---
	test('fake 2-tool run (CODE_GENERATION, no open files) is deterministic', async () => {
		const registry = fakeRegistry([
			makeFakeAdapter('projectBrainAdapter'),
			makeFakeAdapter('repositoryAdapter', { repository: { openFile: '/x.ts', relatedFiles: ['/rel.ts'], projectEntryPoints: [] } }),
		]);
		const res = await orchestrate(makeRequest({ userPrompt: 'Implement a login screen using Clerk', openFiles: [] }), registry, noop);
		assert.deepStrictEqual(res.orchestrationMetadata.toolsExecuted, ['projectBrainAdapter', 'repositoryAdapter']);
		assert.ok(res.enrichedPrompt.includes('=== REPOSITORY ==='));
		assert.ok(res.enrichedPrompt.includes('/rel.ts'));
	});

	test('fake 3-tool run (CODE_GENERATION, with open files) injects file + repository context', async () => {
		const registry = fakeRegistry([
			makeFakeAdapter('projectBrainAdapter'),
			makeFakeAdapter('repositoryAdapter', { repository: { openFile: '/x.ts', relatedFiles: ['/rel.ts'], projectEntryPoints: [] } }),
			makeFakeAdapter('fileContextAdapter', { currentFiles: [{ path: '/x.ts', language: 'typescript', content: 'FAKEBODY', trimmed: false }] }),
		]);
		const res = await orchestrate(makeRequest({ userPrompt: 'Implement a login screen using Clerk', openFiles: ['/x.ts'] }), registry, noop);
		assert.strictEqual(res.orchestrationMetadata.toolsExecuted.length, 3);
		assert.ok(res.enrichedPrompt.includes('=== FILE: /x.ts ==='));
		assert.ok(res.enrichedPrompt.includes('FAKEBODY'));
		assert.ok(res.enrichedPrompt.includes('=== REPOSITORY ==='));
	});

	test('orchestrationMetadata is fully populated and well-typed', async () => {
		const res = await orchestrate(await reviewReq(), realRegistry(), noop);
		const m = res.orchestrationMetadata;
		assert.ok(Object.values(DeveloperIntent).includes(m.intent));
		assert.strictEqual(typeof m.confidence, 'number');
		assert.ok(Array.isArray(m.toolsExecuted) && Array.isArray(m.toolsFailed));
		assert.strictEqual(typeof m.originalTokenEstimate, 'number');
		assert.strictEqual(typeof m.finalTokenEstimate, 'number');
		assert.ok(['none', 'light', 'aggressive'].includes(m.compressionMode));
		assert.strictEqual(typeof m.headroomAvailable, 'boolean');
		assert.strictEqual(typeof m.totalDurationMs, 'number');
	});
});
