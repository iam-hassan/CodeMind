/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeveloperIntent } from '../orchestration/types.js';
import { selectTools, selectToolsWithReasons } from '../orchestration/toolSelector.js';
import { resolveRequiredCapabilities, ALL_CAPABILITIES, CANONICAL_ADAPTER_CAPABILITIES } from '../orchestration/capabilities.js';
import { projectBrainAdapter } from '../orchestration/toolAdapters/projectBrainAdapter.js';
import { makeIntent, makeSelectionContext, makeFakeAdapter, fakeRegistry, realRegistry } from './orchestrationTestUtils.js';

suite('Orchestration › capability-based selection', () => {

	// --- the one surviving real adapter self-declares its capabilities correctly ---
	// (The six shadow adapters were removed; Layer 3 now observes the real Claude Agent
	// SDK tool stream. CANONICAL_ADAPTER_CAPABILITIES still documents their ids so the
	// selection FAKES in orchestrationTestUtils reproduce the old selection behaviour.)
	test('projectBrainAdapter advertises exactly its canonical capabilities', () => {
		assert.deepStrictEqual(
			projectBrainAdapter.capabilities,
			CANONICAL_ADAPTER_CAPABILITIES['projectBrainAdapter'],
			'projectBrain capabilities drifted from canonical');
	});

	test('every advertised capability belongs to the taxonomy', () => {
		for (const caps of Object.values(CANONICAL_ADAPTER_CAPABILITIES)) {
			for (const c of caps) { assert.ok(ALL_CAPABILITIES.includes(c), `${c} missing from ALL_CAPABILITIES`); }
		}
	});

	// --- id-independence: selection follows capabilities, not a hardcoded id list ---
	test('a NEW adapter advertising repository_context is selected in place of the canonical one', () => {
		const custom = makeFakeAdapter(
			'myCustomRepoTool',
			{ repository: { openFile: '', relatedFiles: [], projectEntryPoints: [] } },
			() => true,
			['repository_context', 'project_structure'],
		);
		const reg = fakeRegistry([projectBrainAdapter, custom]); // no canonical repositoryAdapter present
		const ids = selectTools(makeIntent(DeveloperIntent.ARCHITECTURE), makeSelectionContext(), reg).map(a => a.id);
		assert.ok(ids.includes('myCustomRepoTool'), 'custom repository_context tool should win by capability');
		assert.ok(!ids.includes('repositoryAdapter'));
	});

	test('an adapter with the canonical id but NO capabilities is never selected', () => {
		const inert = makeFakeAdapter('projectBrainAdapter', {}, () => true, []);
		const ids = selectTools(makeIntent(DeveloperIntent.MEMORY_RETRIEVAL), makeSelectionContext(), fakeRegistry([inert])).map(a => a.id);
		assert.deepStrictEqual(ids, [], 'no advertised capability ⇒ not selected, even with a "known" id');
	});

	// --- decisions / reasons feed the trace ---
	test('requiredCapabilities and selected order match, in required order', () => {
		const r = selectToolsWithReasons(makeIntent(DeveloperIntent.PROJECT_ANALYSIS), makeSelectionContext(), realRegistry());
		assert.deepStrictEqual(r.requiredCapabilities, ['repository_context', 'git_context', 'dependency_context', 'project_memory']);
		assert.deepStrictEqual(r.selected.map(a => a.id), ['repositoryAdapter', 'gitAdapter', 'dependencyAdapter', 'projectBrainAdapter']);
	});

	test('every registered adapter gets a decision with a reason (selected and skipped)', () => {
		const r = selectToolsWithReasons(makeIntent(DeveloperIntent.MEMORY_RETRIEVAL), makeSelectionContext(), realRegistry());
		assert.strictEqual(r.decisions.length, 7);
		const pb = r.decisions.find(d => d.adapterId === 'projectBrainAdapter')!;
		assert.strictEqual(pb.selected, true);
		assert.match(pb.reason, /provides project_memory/);
		const web = r.decisions.find(d => d.adapterId === 'webSearchAdapter')!;
		assert.strictEqual(web.selected, false);
		assert.match(web.reason, /requires none of them/);
	});

	test('skip-by-shouldRun reads differently from skip-by-no-capability', () => {
		const r = selectToolsWithReasons(makeIntent(DeveloperIntent.CODE_REVIEW), makeSelectionContext({ hasOpenFiles: false }), realRegistry());
		const file = r.decisions.find(d => d.adapterId === 'fileContextAdapter')!;
		assert.strictEqual(file.selected, false);
		assert.match(file.reason, /shouldRun\(\) vetoed/);
		assert.ok(r.unmetCapabilities.includes('current_file_context'));
	});

	test('unmet capabilities are reported when no adapter can provide them', () => {
		const r = selectToolsWithReasons(makeIntent(DeveloperIntent.WEB_SEARCH), makeSelectionContext(), fakeRegistry([projectBrainAdapter]));
		assert.ok(r.unmetCapabilities.includes('web_search'));
		assert.deepStrictEqual(r.selected.map(a => a.id), []);
	});

	test('satisfiedCapabilities reflects exactly what enabled adapters covered', () => {
		const r = selectToolsWithReasons(makeIntent(DeveloperIntent.TERMINAL_EXECUTION), makeSelectionContext(), realRegistry());
		assert.deepStrictEqual(r.satisfiedCapabilities, ['terminal_execution']);
		assert.deepStrictEqual(r.selected.map(a => a.id), ['terminalAdapter']);
	});

	// --- resolveRequiredCapabilities semantics (safe sets, not universal) ---
	test('MEMORY_RETRIEVAL resolves to a SAFE set — never web or repository', () => {
		const caps = resolveRequiredCapabilities(makeIntent(DeveloperIntent.MEMORY_RETRIEVAL), makeSelectionContext());
		assert.deepStrictEqual(caps, ['project_memory']);
		assert.ok(!caps.includes('web_search') && !caps.includes('repository_context'));
	});

	test('DEBUGGING with a test signal adds the testing capability', () => {
		const caps = resolveRequiredCapabilities(makeIntent(DeveloperIntent.DEBUGGING, 0.8, ['test']), makeSelectionContext({ hasOpenFiles: true }));
		assert.deepStrictEqual(caps, ['current_file_context', 'repository_context', 'testing']);
	});

	test('low-confidence CODE_GENERATION narrows to project_memory only', () => {
		const caps = resolveRequiredCapabilities(makeIntent(DeveloperIntent.CODE_GENERATION, 0.5, ['make']), makeSelectionContext());
		assert.deepStrictEqual(caps, ['project_memory']);
	});
});
