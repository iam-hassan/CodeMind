/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { aggregateToolOutputs } from '../orchestration/contextAggregator.js';
import { ToolOutput } from '../orchestration/types.js';

/**
 * Proves the aggregator sorts each adapter output into the right AggregatedContext slot,
 * splits ids into toolsExecuted vs toolsFailed by status, sums durationMs, accumulates
 * currentFiles/webResults, and applies last-wins for the single-value slots.
 */
suite('Orchestration › contextAggregator', () => {

	const out = (partial: Partial<ToolOutput> & { adapterId: string }): ToolOutput =>
		({ status: 'success', durationMs: 0, outputSummary: '', outputTokenEstimate: 0, ...partial });

	test('empty input → fully-empty AggregatedContext', () => {
		const a = aggregateToolOutputs([]);
		assert.strictEqual(a.projectBrain, null);
		assert.strictEqual(a.repository, null);
		assert.deepStrictEqual(a.currentFiles, []);
		assert.strictEqual(a.dependencies, null);
		assert.strictEqual(a.gitState, null);
		assert.deepStrictEqual(a.webResults, []);
		assert.strictEqual(a.terminalContext, null);
		assert.strictEqual(a.collectionDurationMs, 0);
		assert.deepStrictEqual(a.toolsExecuted, []);
		assert.deepStrictEqual(a.toolsFailed, []);
	});

	test('a single success output lands in toolsExecuted, not toolsFailed', () => {
		const a = aggregateToolOutputs([out({ adapterId: 'x', status: 'success' })]);
		assert.deepStrictEqual(a.toolsExecuted, ['x']);
		assert.deepStrictEqual(a.toolsFailed, []);
	});

	test('a timeout output lands in toolsFailed', () => {
		const a = aggregateToolOutputs([out({ adapterId: 'slow', status: 'timeout' })]);
		assert.deepStrictEqual(a.toolsFailed, ['slow']);
		assert.deepStrictEqual(a.toolsExecuted, []);
	});

	test('an error output lands in toolsFailed', () => {
		const a = aggregateToolOutputs([out({ adapterId: 'boom', status: 'error' })]);
		assert.deepStrictEqual(a.toolsFailed, ['boom']);
		assert.deepStrictEqual(a.toolsExecuted, []);
	});

	test('durationMs is summed across every output regardless of status', () => {
		const a = aggregateToolOutputs([
			out({ adapterId: 'a', durationMs: 10 }),
			out({ adapterId: 'b', durationMs: 25, status: 'error' }),
			out({ adapterId: 'c', durationMs: 5 }),
		]);
		assert.strictEqual(a.collectionDurationMs, 40);
	});

	test('projectBrain output is stored', () => {
		const pb = { available: true, facts: ['f'], decisions: [] };
		const a = aggregateToolOutputs([out({ adapterId: 'pb', projectBrain: pb })]);
		assert.strictEqual(a.projectBrain, pb);
	});

	test('repository output is stored', () => {
		const repo = { openFile: '/x.ts', relatedFiles: ['/y.ts'], projectEntryPoints: [] };
		const a = aggregateToolOutputs([out({ adapterId: 'repo', repository: repo })]);
		assert.strictEqual(a.repository, repo);
	});

	test('dependencies output is stored', () => {
		const deps = { projectType: 'node', packages: [{ name: 'react', version: '18' }] };
		const a = aggregateToolOutputs([out({ adapterId: 'dep', dependencies: deps })]);
		assert.strictEqual(a.dependencies, deps);
	});

	test('gitState output is stored', () => {
		const git = { available: true, branch: 'main' };
		const a = aggregateToolOutputs([out({ adapterId: 'git', gitState: git })]);
		assert.strictEqual(a.gitState, git);
	});

	test('terminalContext output is stored', () => {
		const term = { cwd: '/w', shell: 'bash', devServerRunning: false, availableScripts: ['build'] };
		const a = aggregateToolOutputs([out({ adapterId: 'term', terminalContext: term })]);
		assert.strictEqual(a.terminalContext, term);
	});

	test('currentFiles accumulate across outputs (spread, not overwrite)', () => {
		const a = aggregateToolOutputs([
			out({ adapterId: 'f1', currentFiles: [{ path: '/a.ts', language: 'typescript', content: 'A', trimmed: false }] }),
			out({ adapterId: 'f2', currentFiles: [{ path: '/b.ts', language: 'typescript', content: 'B', trimmed: false }] }),
		]);
		assert.strictEqual(a.currentFiles.length, 2);
		assert.deepStrictEqual(a.currentFiles.map(f => f.path), ['/a.ts', '/b.ts']);
	});

	test('webResults accumulate across outputs', () => {
		const a = aggregateToolOutputs([
			out({ adapterId: 'w1', webResults: [{ injectedDirective: '[Search: a]' }] }),
			out({ adapterId: 'w2', webResults: [{ injectedDirective: '[Search: b]' }] }),
		]);
		assert.strictEqual(a.webResults.length, 2);
		assert.deepStrictEqual(a.webResults.map(w => w.injectedDirective), ['[Search: a]', '[Search: b]']);
	});

	test('single-value slots are last-wins when two outputs both carry one', () => {
		const first = { openFile: '/first.ts', relatedFiles: [], projectEntryPoints: [] };
		const second = { openFile: '/second.ts', relatedFiles: [], projectEntryPoints: [] };
		const a = aggregateToolOutputs([
			out({ adapterId: 'r1', repository: first }),
			out({ adapterId: 'r2', repository: second }),
		]);
		assert.strictEqual(a.repository, second);
	});

	test('a success output with no context payload still records the id, leaves slots empty', () => {
		const a = aggregateToolOutputs([out({ adapterId: 'noop', status: 'success' })]);
		assert.deepStrictEqual(a.toolsExecuted, ['noop']);
		assert.strictEqual(a.repository, null);
		assert.deepStrictEqual(a.currentFiles, []);
	});

	test('mixed success + failure splits ids into the right buckets, preserving order', () => {
		const a = aggregateToolOutputs([
			out({ adapterId: 'ok1', status: 'success' }),
			out({ adapterId: 'bad', status: 'error' }),
			out({ adapterId: 'ok2', status: 'success' }),
			out({ adapterId: 'slow', status: 'timeout' }),
		]);
		assert.deepStrictEqual(a.toolsExecuted, ['ok1', 'ok2']);
		assert.deepStrictEqual(a.toolsFailed, ['bad', 'slow']);
	});
});
