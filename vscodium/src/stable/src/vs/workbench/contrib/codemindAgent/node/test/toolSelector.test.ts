/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { classifyIntent } from '../orchestration/intentDetector.js';
import { selectTools } from '../orchestration/toolSelector.js';
import { DeveloperIntent } from '../orchestration/types.js';
import {
	realRegistry, fakeRegistry, makeFakeAdapter, makeIntent, makeSelectionContext,
} from './orchestrationTestUtils.js';

/**
 * Proves the tool selector maps each intent to the correct adapter set, honours the
 * hasOpenFiles / isFollowUp / confidence gates, and respects each adapter's shouldRun.
 */
suite('Orchestration › toolSelector', () => {

	const reg = realRegistry();
	const idsFor = (intent: any, open: boolean, followUp = false) =>
		selectTools(intent, makeSelectionContext({ hasOpenFiles: open, isFollowUp: followUp }), reg).map(t => t.id);
	const idsForPrompt = (prompt: string, open: boolean) => idsFor(classifyIntent(prompt), open);

	test('CODE_GENERATION with open files → projectBrain + repository + fileContext', () => {
		assert.deepStrictEqual(
			idsForPrompt('Implement a login screen using Clerk', true),
			['projectBrainAdapter', 'repositoryAdapter', 'fileContextAdapter']);
	});

	test('CODE_GENERATION without open files drops fileContext', () => {
		assert.deepStrictEqual(
			idsForPrompt('Implement a login screen using Clerk', false),
			['projectBrainAdapter', 'repositoryAdapter']);
	});

	test('CODE_GENERATION below 0.7 confidence → projectBrain only', () => {
		const lowConf = makeIntent(DeveloperIntent.CODE_GENERATION, 0.5, ['implement']);
		assert.deepStrictEqual(idsFor(lowConf, true), ['projectBrainAdapter']);
	});

	test('CODE_GENERATION with a library/package signal adds dependencyAdapter', () => {
		const withDep = makeIntent(DeveloperIntent.CODE_GENERATION, 0.9, ['implement', 'add a package']);
		assert.deepStrictEqual(idsFor(withDep, true),
			['projectBrainAdapter', 'repositoryAdapter', 'fileContextAdapter', 'dependencyAdapter']);
	});

	test('MEMORY_RETRIEVAL → projectBrain only (never repository/web)', () => {
		assert.deepStrictEqual(idsForPrompt('What database are we using?', true), ['projectBrainAdapter']);
		assert.deepStrictEqual(idsForPrompt('What database are we using?', false), ['projectBrainAdapter']);
	});

	test('ARCHITECTURE → projectBrain + repository (no fileContext when not a follow-up)', () => {
		assert.deepStrictEqual(
			idsForPrompt('give me a high-level overview of the module structure', true),
			['projectBrainAdapter', 'repositoryAdapter']);
	});

	test('ARCHITECTURE as a follow-up with open files adds fileContext', () => {
		const arch = makeIntent(DeveloperIntent.ARCHITECTURE, 0.8, ['module structure']);
		assert.deepStrictEqual(idsFor(arch, true, /*followUp*/ true),
			['projectBrainAdapter', 'repositoryAdapter', 'fileContextAdapter']);
	});

	test('WEB_SEARCH → webSearch only', () => {
		assert.deepStrictEqual(idsForPrompt('Search for the latest Next.js pricing', true), ['webSearchAdapter']);
	});

	test('WEB_SEARCH with a project/our/we signal also adds projectBrain', () => {
		const ws = makeIntent(DeveloperIntent.WEB_SEARCH, 0.8, ['search for', 'our project']);
		assert.deepStrictEqual(idsFor(ws, true), ['webSearchAdapter', 'projectBrainAdapter']);
	});

	test('GIT_OPERATIONS → gitAdapter only', () => {
		assert.deepStrictEqual(idsForPrompt('commit these changes with a good message', true), ['gitAdapter']);
	});

	test('GIT_OPERATIONS with a pull-request signal adds fileContext', () => {
		const git = makeIntent(DeveloperIntent.GIT_OPERATIONS, 0.8, ['commit', 'pull request']);
		assert.deepStrictEqual(idsFor(git, true), ['gitAdapter', 'fileContextAdapter']);
	});

	test('TERMINAL_EXECUTION → terminalAdapter only', () => {
		assert.deepStrictEqual(idsForPrompt('npm run build the whole project now', true), ['terminalAdapter']);
	});

	test('DEBUGGING with open files → fileContext + repository', () => {
		assert.deepStrictEqual(idsForPrompt('fix the bug that crashes on startup', true),
			['fileContextAdapter', 'repositoryAdapter']);
	});

	test('DEBUGGING without open files drops fileContext', () => {
		assert.deepStrictEqual(idsForPrompt('fix the bug that crashes on startup', false), ['repositoryAdapter']);
	});

	test('DEBUGGING with a test signal adds terminalAdapter', () => {
		const dbg = makeIntent(DeveloperIntent.DEBUGGING, 0.8, ['fix', 'test']);
		assert.deepStrictEqual(idsFor(dbg, true), ['fileContextAdapter', 'repositoryAdapter', 'terminalAdapter']);
	});

	test('CODE_REVIEW with open files → fileContext + repository', () => {
		assert.deepStrictEqual(idsForPrompt('review this code for any issues here', true),
			['fileContextAdapter', 'repositoryAdapter']);
	});

	test('CODE_REVIEW with a "latest/best practice" signal adds webSearch', () => {
		const cr = makeIntent(DeveloperIntent.CODE_REVIEW, 0.8, ['review', 'latest']);
		assert.deepStrictEqual(idsFor(cr, true), ['fileContextAdapter', 'repositoryAdapter', 'webSearchAdapter']);
	});

	test('TESTING with open files → fileContext + dependency + terminal', () => {
		assert.deepStrictEqual(idsForPrompt('write tests for the parser module', true),
			['fileContextAdapter', 'dependencyAdapter', 'terminalAdapter']);
	});

	test('TESTING without open files drops fileContext', () => {
		assert.deepStrictEqual(idsForPrompt('write tests for the parser module', false),
			['dependencyAdapter', 'terminalAdapter']);
	});

	test('PROJECT_ANALYSIS → repository + git + dependency + projectBrain', () => {
		assert.deepStrictEqual(idsForPrompt('analyze the project dependencies and tech stack', true),
			['repositoryAdapter', 'gitAdapter', 'dependencyAdapter', 'projectBrainAdapter']);
	});

	test('MULTI_TOOL_WORKFLOW with open files → projectBrain + repository + fileContext + webSearch', () => {
		const multi = makeIntent(DeveloperIntent.MULTI_TOOL_WORKFLOW, 0.7, ['build', 'latest']);
		assert.deepStrictEqual(idsFor(multi, true),
			['projectBrainAdapter', 'repositoryAdapter', 'fileContextAdapter', 'webSearchAdapter']);
	});

	test('MULTI_TOOL_WORKFLOW without open files drops fileContext', () => {
		const multi = makeIntent(DeveloperIntent.MULTI_TOOL_WORKFLOW, 0.7, ['build', 'latest']);
		assert.deepStrictEqual(idsFor(multi, false),
			['projectBrainAdapter', 'repositoryAdapter', 'webSearchAdapter']);
	});

	test('empty registry selects nothing', () => {
		const empty = fakeRegistry([]);
		for (const intent of Object.values(DeveloperIntent)) {
			const sel = selectTools(makeIntent(intent as DeveloperIntent, 0.9, ['x', 'test', 'package', 'latest', 'pull request']),
				makeSelectionContext({ hasOpenFiles: true, isFollowUp: true }), empty);
			assert.strictEqual(sel.length, 0, `expected nothing for ${intent}`);
		}
	});

	test('an adapter whose shouldRun returns false is excluded', () => {
		const custom = fakeRegistry([
			makeFakeAdapter('fileContextAdapter', {}, () => true),
			makeFakeAdapter('repositoryAdapter', {}, () => false),
		]);
		const sel = selectTools(makeIntent(DeveloperIntent.CODE_REVIEW, 0.8, ['review']),
			makeSelectionContext({ hasOpenFiles: true }), custom).map(t => t.id);
		assert.deepStrictEqual(sel, ['fileContextAdapter']);
	});

	test('selection never contains duplicate adapters', () => {
		const multi = makeIntent(DeveloperIntent.MULTI_TOOL_WORKFLOW, 0.7, ['build', 'latest']);
		const sel = idsFor(multi, true);
		assert.strictEqual(new Set(sel).size, sel.length);
	});

	test('only adapters that exist in the registry are ever returned', () => {
		const partial = fakeRegistry([makeFakeAdapter('projectBrainAdapter')]);
		const sel = selectTools(makeIntent(DeveloperIntent.CODE_GENERATION, 0.9, ['implement']),
			makeSelectionContext({ hasOpenFiles: true }), partial).map(t => t.id);
		assert.deepStrictEqual(sel, ['projectBrainAdapter']);
	});
});
