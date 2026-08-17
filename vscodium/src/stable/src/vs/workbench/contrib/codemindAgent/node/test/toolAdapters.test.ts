/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { projectBrainAdapter } from '../orchestration/toolAdapters/projectBrainAdapter.js';
import { repositoryAdapter } from '../orchestration/toolAdapters/repositoryAdapter.js';
import { fileContextAdapter } from '../orchestration/toolAdapters/fileContextAdapter.js';
import { dependencyAdapter } from '../orchestration/toolAdapters/dependencyAdapter.js';
import { gitAdapter } from '../orchestration/toolAdapters/gitAdapter.js';
import { webSearchAdapter } from '../orchestration/toolAdapters/webSearchAdapter.js';
import { terminalAdapter } from '../orchestration/toolAdapters/terminalAdapter.js';
import { DeveloperIntent } from '../orchestration/types.js';
import { makeRequest, makeIntent, makeSelectionContext, makeTempWorkspace, rmWorkspace } from './orchestrationTestUtils.js';

/**
 * Proves every tool adapter honours its contract against a real (temp) filesystem: the
 * project-brain stub, the repository walk (INTERESTING_DIRS, entry points, ≤50 cap,
 * dotfile skip), file reading (language map, 200-line trim, missing-file skip, 5-file cap),
 * dependency parsing + signal filter, git graceful non-repo, the web-search directive
 * heuristic, terminal script discovery — and each adapter's shouldRun gate.
 */
suite('Orchestration › toolAdapters', () => {

	let tempDirs: string[] = [];
	const ws = async (files: Record<string, string>): Promise<string> => {
		const d = await makeTempWorkspace(files);
		tempDirs.push(d);
		return d;
	};
	teardown(async () => { for (const d of tempDirs) { await rmWorkspace(d); } tempDirs = []; });

	// ===================== projectBrainAdapter (stub) =====================
	suite('projectBrainAdapter', () => {
		test('executes to a success with an unavailable Project Brain', async () => {
			const o = await projectBrainAdapter.execute(makeRequest());
			assert.strictEqual(o.status, 'success');
			assert.strictEqual(o.adapterId, 'projectBrainAdapter');
			assert.strictEqual(o.projectBrain!.available, false);
		});
		test('the stub carries empty facts/decisions and a Phase-1 reason', async () => {
			const o = await projectBrainAdapter.execute(makeRequest());
			assert.deepStrictEqual(o.projectBrain!.facts, []);
			assert.deepStrictEqual(o.projectBrain!.decisions, []);
			assert.match(o.projectBrain!.reason!, /Phase 1/);
		});
		test('shouldRun is always true and TIMEOUT_MS is 50', () => {
			assert.strictEqual(projectBrainAdapter.shouldRun(makeIntent(DeveloperIntent.MEMORY_RETRIEVAL), makeSelectionContext()), true);
			assert.strictEqual(projectBrainAdapter.TIMEOUT_MS, 50);
		});
	});

	// ===================== repositoryAdapter =====================
	suite('repositoryAdapter', () => {
		test('walks the open file directory and returns related files', async () => {
			const dir = await ws({ 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' });
			const o = await repositoryAdapter.execute(makeRequest({ workspaceFolder: dir, openFiles: [dir + '/a.ts'] }));
			assert.strictEqual(o.status, 'success');
			assert.ok(o.repository!.relatedFiles.length >= 3, 'siblings of the open file are collected');
			assert.ok(o.repository!.relatedFiles.some(p => p.endsWith('b.ts')));
		});
		test('collects files from an INTERESTING_DIR (e.g. auth/)', async () => {
			const dir = await ws({ 'auth/login.ts': 'x', 'index.ts': 'y' });
			const o = await repositoryAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.ok(o.repository!.relatedFiles.some(p => /auth[\\/]login\.ts$/.test(p)), 'auth/login.ts is walked');
		});
		test('reports only entry points that actually exist', async () => {
			const dir = await ws({ 'index.ts': 'x', 'package.json': '{}' });
			const o = await repositoryAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.deepStrictEqual(o.repository!.projectEntryPoints.sort(), ['index.ts', 'package.json']);
		});
		test('a non-existent entry point is never reported', async () => {
			const dir = await ws({ 'package.json': '{}' }); // no index.ts/main.ts/app.ts
			const o = await repositoryAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.deepStrictEqual(o.repository!.projectEntryPoints, ['package.json']);
		});
		test('related files are capped at 50', async () => {
			const files: Record<string, string> = {};
			for (const d of ['auth', 'api', 'lib', 'utils', 'services', 'components', 'hooks', 'store', 'routes']) {
				for (let i = 0; i < 8; i++) { files[`${d}/f${i}.ts`] = 'x'; }
			}
			const dir = await ws(files); // 72 candidate files across 9 interesting dirs
			const o = await repositoryAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.strictEqual(o.repository!.relatedFiles.length, 50);
		});
		test('dotfiles are skipped in the sibling scan', async () => {
			const dir = await ws({ '.secret': 'x', 'visible.ts': 'y' });
			const o = await repositoryAdapter.execute(makeRequest({ workspaceFolder: dir, openFiles: [dir + '/visible.ts'] }));
			assert.ok(!o.repository!.relatedFiles.some(p => p.endsWith('.secret')), 'dotfile excluded');
		});
		test('a missing workspace degrades gracefully to empty related files', async () => {
			const o = await repositoryAdapter.execute(makeRequest({ workspaceFolder: '/no/such/dir/here-xyz' }));
			assert.strictEqual(o.status, 'success');
			assert.deepStrictEqual(o.repository!.relatedFiles, []);
		});
		test('shouldRun is always true; TIMEOUT_MS is 600', () => {
			assert.strictEqual(repositoryAdapter.shouldRun(makeIntent(DeveloperIntent.WEB_SEARCH), makeSelectionContext()), true);
			assert.strictEqual(repositoryAdapter.TIMEOUT_MS, 600);
		});
	});

	// ===================== fileContextAdapter =====================
	suite('fileContextAdapter', () => {
		test('reads an open file into currentFiles with its content', async () => {
			const dir = await ws({ 'x.ts': 'export const x = 1;' });
			const o = await fileContextAdapter.execute(makeRequest({ openFiles: [dir + '/x.ts'] }));
			assert.strictEqual(o.currentFiles!.length, 1);
			assert.strictEqual(o.currentFiles![0].content, 'export const x = 1;');
			assert.strictEqual(o.currentFiles![0].trimmed, false);
		});
		test('maps .ts → typescript', async () => {
			const dir = await ws({ 'x.ts': 'a' });
			const o = await fileContextAdapter.execute(makeRequest({ openFiles: [dir + '/x.ts'] }));
			assert.strictEqual(o.currentFiles![0].language, 'typescript');
		});
		test('maps .py → python', async () => {
			const dir = await ws({ 'x.py': 'a = 1' });
			const o = await fileContextAdapter.execute(makeRequest({ openFiles: [dir + '/x.py'] }));
			assert.strictEqual(o.currentFiles![0].language, 'python');
		});
		test('maps an unknown extension → text', async () => {
			const dir = await ws({ 'x.zzz': 'a' });
			const o = await fileContextAdapter.execute(makeRequest({ openFiles: [dir + '/x.zzz'] }));
			assert.strictEqual(o.currentFiles![0].language, 'text');
		});
		test('a file over 200 lines is trimmed with an omission marker', async () => {
			const dir = await ws({ 'big.ts': Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') });
			const o = await fileContextAdapter.execute(makeRequest({ openFiles: [dir + '/big.ts'] }));
			assert.strictEqual(o.currentFiles![0].trimmed, true);
			assert.match(o.currentFiles![0].content, /\[\.\.\. 100 lines omitted \.\.\.\]/);
		});
		test('a missing/unreadable file is silently skipped', async () => {
			const o = await fileContextAdapter.execute(makeRequest({ openFiles: ['/no/such/file-xyz.ts'] }));
			assert.deepStrictEqual(o.currentFiles, []);
			assert.strictEqual(o.status, 'success');
		});
		test('at most the first 5 open files are read', async () => {
			const files: Record<string, string> = {};
			for (let i = 0; i < 6; i++) { files[`f${i}.ts`] = 'x'; }
			const dir = await ws(files);
			const o = await fileContextAdapter.execute(makeRequest({ openFiles: Object.keys(files).map(f => dir + '/' + f) }));
			assert.strictEqual(o.currentFiles!.length, 5);
		});
		test('shouldRun follows hasOpenFiles', () => {
			assert.strictEqual(fileContextAdapter.shouldRun(makeIntent(DeveloperIntent.CODE_REVIEW), makeSelectionContext({ hasOpenFiles: true })), true);
			assert.strictEqual(fileContextAdapter.shouldRun(makeIntent(DeveloperIntent.CODE_REVIEW), makeSelectionContext({ hasOpenFiles: false })), false);
		});
	});

	// ===================== dependencyAdapter =====================
	suite('dependencyAdapter', () => {
		const PKG = JSON.stringify({ dependencies: { react: '^18.0.0', express: '^4.0.0' } });
		test('parses package.json into a node project with packages', async () => {
			const dir = await ws({ 'package.json': PKG });
			const o = await dependencyAdapter.execute(makeRequest({ workspaceFolder: dir, userPrompt: 'do something meaningful here' }));
			assert.strictEqual(o.dependencies!.projectType, 'node');
			assert.deepStrictEqual(o.dependencies!.packages.map(p => p.name).sort(), ['express', 'react']);
		});
		test('filters packages by a name mentioned in the prompt', async () => {
			const dir = await ws({ 'package.json': PKG });
			const o = await dependencyAdapter.execute(makeRequest({ workspaceFolder: dir, userPrompt: 'please add the react package for me' }));
			assert.deepStrictEqual(o.dependencies!.packages.map(p => p.name), ['react']);
		});
		test('with no matching signal, every package is kept', async () => {
			const dir = await ws({ 'package.json': PKG });
			const o = await dependencyAdapter.execute(makeRequest({ workspaceFolder: dir, userPrompt: 'unrelated words only' }));
			assert.strictEqual(o.dependencies!.packages.length, 2);
		});
		test('devDependencies are merged in alongside dependencies', async () => {
			const dir = await ws({ 'package.json': JSON.stringify({ dependencies: { react: '18' }, devDependencies: { jest: '29' } }) });
			const o = await dependencyAdapter.execute(makeRequest({ workspaceFolder: dir, userPrompt: 'unrelated words only' }));
			assert.deepStrictEqual(o.dependencies!.packages.map(p => p.name).sort(), ['jest', 'react']);
		});
		test('a missing package.json yields an unknown project with no packages', async () => {
			const dir = await ws({});
			const o = await dependencyAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.strictEqual(o.status, 'success');
			assert.strictEqual(o.dependencies!.projectType, 'unknown');
			assert.deepStrictEqual(o.dependencies!.packages, []);
		});
		test('shouldRun gates on generation/debugging/testing/analysis intents', () => {
			const ctx = makeSelectionContext();
			for (const i of [DeveloperIntent.CODE_GENERATION, DeveloperIntent.DEBUGGING, DeveloperIntent.TESTING, DeveloperIntent.PROJECT_ANALYSIS]) {
				assert.strictEqual(dependencyAdapter.shouldRun(makeIntent(i), ctx), true, `should run for ${i}`);
			}
			for (const i of [DeveloperIntent.WEB_SEARCH, DeveloperIntent.GIT_OPERATIONS, DeveloperIntent.MEMORY_RETRIEVAL]) {
				assert.strictEqual(dependencyAdapter.shouldRun(makeIntent(i), ctx), false, `should NOT run for ${i}`);
			}
		});
	});

	// ===================== gitAdapter =====================
	suite('gitAdapter', () => {
		test('a non-repo directory resolves to a success (never rejects)', async () => {
			const dir = await ws({ 'x.ts': 'a' });
			const o = await gitAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.strictEqual(o.adapterId, 'gitAdapter');
			// Promise.allSettled swallows per-command failures, so the adapter always
			// reports success with an available git-state container.
			assert.strictEqual(o.status, 'success');
			assert.strictEqual(o.gitState!.available, true);
		});
		test('does not reject for a non-repo directory', async () => {
			const dir = await ws({});
			await assert.doesNotReject(() => gitAdapter.execute(makeRequest({ workspaceFolder: dir })));
		});
		test('shouldRun is always true; TIMEOUT_MS is 3000', () => {
			assert.strictEqual(gitAdapter.shouldRun(makeIntent(DeveloperIntent.CODE_GENERATION), makeSelectionContext()), true);
			assert.strictEqual(gitAdapter.TIMEOUT_MS, 3000);
		});
	});

	// ===================== webSearchAdapter =====================
	suite('webSearchAdapter', () => {
		test('builds a [Search: …] directive from prompt keywords', async () => {
			const o = await webSearchAdapter.execute(makeRequest({ userPrompt: 'latest nextjs pricing comparison benchmark' }));
			assert.strictEqual(o.webResults!.length, 1);
			assert.ok(o.webResults![0].injectedDirective.startsWith('[Search:'));
			assert.match(o.webResults![0].injectedDirective, /nextjs/);
		});
		test('falls back to a generic directive when no strong terms survive', async () => {
			const o = await webSearchAdapter.execute(makeRequest({ userPrompt: 'a an is to of' }));
			assert.strictEqual(o.webResults![0].injectedDirective, '[Search: latest information]');
		});
		test('runs with no network and zero duration', async () => {
			const o = await webSearchAdapter.execute(makeRequest({ userPrompt: 'find latest release notes' }));
			assert.strictEqual(o.status, 'success');
			assert.strictEqual(o.durationMs, 0);
		});
		test('shouldRun covers web-search, code-review and multi-tool intents', () => {
			const ctx = makeSelectionContext();
			assert.strictEqual(webSearchAdapter.shouldRun(makeIntent(DeveloperIntent.WEB_SEARCH), ctx), true);
			assert.strictEqual(webSearchAdapter.shouldRun(makeIntent(DeveloperIntent.CODE_REVIEW), ctx), true);
			assert.strictEqual(webSearchAdapter.shouldRun(makeIntent(DeveloperIntent.MULTI_TOOL_WORKFLOW), ctx), true);
			assert.strictEqual(webSearchAdapter.shouldRun(makeIntent(DeveloperIntent.CODE_GENERATION), ctx), false);
		});
		test('TIMEOUT_MS is 100', () => { assert.strictEqual(webSearchAdapter.TIMEOUT_MS, 100); });
	});

	// ===================== terminalAdapter =====================
	suite('terminalAdapter', () => {
		test('discovers package.json scripts as availableScripts', async () => {
			const dir = await ws({ 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'mocha', dev: 'vite' } }) });
			const o = await terminalAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.strictEqual(o.status, 'success');
			assert.deepStrictEqual(o.terminalContext!.availableScripts.sort(), ['build', 'dev', 'test']);
		});
		test('reports the workspace folder as cwd', async () => {
			const dir = await ws({});
			const o = await terminalAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.strictEqual(o.terminalContext!.cwd, dir);
		});
		test('a missing package.json yields no scripts', async () => {
			const dir = await ws({});
			const o = await terminalAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.deepStrictEqual(o.terminalContext!.availableScripts, []);
		});
		test('devServerRunning is a boolean', async () => {
			const dir = await ws({});
			const o = await terminalAdapter.execute(makeRequest({ workspaceFolder: dir }));
			assert.strictEqual(typeof o.terminalContext!.devServerRunning, 'boolean');
		});
		test('shouldRun gates on terminal/debugging/testing intents', () => {
			const ctx = makeSelectionContext();
			assert.strictEqual(terminalAdapter.shouldRun(makeIntent(DeveloperIntent.TERMINAL_EXECUTION), ctx), true);
			assert.strictEqual(terminalAdapter.shouldRun(makeIntent(DeveloperIntent.DEBUGGING), ctx), true);
			assert.strictEqual(terminalAdapter.shouldRun(makeIntent(DeveloperIntent.TESTING), ctx), true);
			assert.strictEqual(terminalAdapter.shouldRun(makeIntent(DeveloperIntent.CODE_GENERATION), ctx), false);
		});
		test('TIMEOUT_MS is 300', () => { assert.strictEqual(terminalAdapter.TIMEOUT_MS, 300); });
	});
});
