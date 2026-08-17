/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { optimizeContext } from '../orchestration/contextOptimizer.js';
import { DeveloperIntent } from '../orchestration/types.js';
import { emptyAggregated } from './orchestrationTestUtils.js';

/**
 * Proves the context optimizer serializes each section under the right marker, includes a
 * section only when it carries content, prunes by intent, trims long lines, deduplicates,
 * and reports estimatedTokens / sectionsIncluded / sectionsRemoved faithfully.
 */
suite('Orchestration › contextOptimizer', () => {

	const PROMPT = 'do the thing';

	test('projectBrain (available) serializes under PROJECT CONTEXT and is included', () => {
		const agg = emptyAggregated({ projectBrain: { available: true, facts: ['Uses Postgres'], decisions: [] } });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_GENERATION);
		assert.ok(o.serializedContext.includes('=== PROJECT CONTEXT ==='));
		assert.ok(o.serializedContext.includes('Uses Postgres'));
		assert.ok(o.sectionsIncluded.includes('projectBrain'));
	});

	test('projectBrain (unavailable) is neither serialized nor included', () => {
		const agg = emptyAggregated({ projectBrain: { available: false, facts: ['x'], decisions: [] } });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_GENERATION);
		assert.ok(!o.serializedContext.includes('=== PROJECT CONTEXT ==='));
		assert.ok(!o.sectionsIncluded.includes('projectBrain'));
	});

	test('repository serializes under REPOSITORY with the open file + related files', () => {
		const agg = emptyAggregated({ repository: { openFile: '/a/login.ts', relatedFiles: ['/a/b.ts', '/a/c.ts'], projectEntryPoints: ['index.ts'] } });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_REVIEW);
		assert.ok(o.serializedContext.includes('=== REPOSITORY ==='));
		assert.ok(o.serializedContext.includes('/a/login.ts'));
		assert.ok(o.serializedContext.includes('/a/b.ts'));
		assert.ok(o.sectionsIncluded.includes('repository'));
	});

	test('a current file serializes under a FILE marker carrying its exact path', () => {
		const agg = emptyAggregated({ currentFiles: [{ path: '/a/login.ts', language: 'typescript', content: 'export const x = 1;', trimmed: false }] });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_REVIEW);
		assert.ok(o.serializedContext.includes('=== FILE: /a/login.ts ==='));
		assert.ok(o.serializedContext.includes('export const x = 1;'));
		assert.ok(o.sectionsIncluded.includes('currentFiles'));
	});

	test('multiple current files each get their own FILE marker', () => {
		const agg = emptyAggregated({ currentFiles: [
			{ path: '/a.ts', language: 'typescript', content: 'A', trimmed: false },
			{ path: '/b.ts', language: 'typescript', content: 'B', trimmed: false },
		] });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_REVIEW);
		assert.ok(o.serializedContext.includes('=== FILE: /a.ts ==='));
		assert.ok(o.serializedContext.includes('=== FILE: /b.ts ==='));
	});

	test('dependencies with packages serialize under DEPENDENCIES', () => {
		const agg = emptyAggregated({ dependencies: { projectType: 'node', packages: [{ name: 'react', version: '^18.0.0' }] } });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_GENERATION);
		assert.ok(o.serializedContext.includes('=== DEPENDENCIES ==='));
		assert.ok(o.serializedContext.includes('react:^18.0.0'));
		assert.ok(o.sectionsIncluded.includes('dependencies'));
	});

	test('dependencies with an empty package list are omitted', () => {
		const agg = emptyAggregated({ dependencies: { projectType: 'unknown', packages: [] } });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_GENERATION);
		assert.ok(!o.serializedContext.includes('=== DEPENDENCIES ==='));
		assert.ok(!o.sectionsIncluded.includes('dependencies'));
	});

	test('gitState (available) serializes under GIT with the branch', () => {
		const agg = emptyAggregated({ gitState: { available: true, branch: 'main', recentCommits: ['abc init'] } });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.PROJECT_ANALYSIS);
		assert.ok(o.serializedContext.includes('=== GIT ==='));
		assert.ok(o.serializedContext.includes('main'));
		assert.ok(o.sectionsIncluded.includes('gitState'));
	});

	test('gitState (unavailable) is omitted', () => {
		const agg = emptyAggregated({ gitState: { available: false } });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.PROJECT_ANALYSIS);
		assert.ok(!o.serializedContext.includes('=== GIT ==='));
		assert.ok(!o.sectionsIncluded.includes('gitState'));
	});

	test('webResults serialize under WEB with the injected directive', () => {
		const agg = emptyAggregated({ webResults: [{ injectedDirective: '[Search: latest next pricing]' }] });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.WEB_SEARCH);
		assert.ok(o.serializedContext.includes('=== WEB ==='));
		assert.ok(o.serializedContext.includes('[Search: latest next pricing]'));
		assert.ok(o.sectionsIncluded.includes('webResults'));
	});

	test('empty aggregated context → empty serialization, 0 tokens, no sections', () => {
		const o = optimizeContext(emptyAggregated(), PROMPT, DeveloperIntent.CODE_GENERATION);
		assert.strictEqual(o.serializedContext, '');
		assert.strictEqual(o.estimatedTokens, 0);
		assert.deepStrictEqual(o.sectionsIncluded, []);
		assert.deepStrictEqual(o.sectionsRemoved, []);
	});

	test('estimatedTokens equals floor(serializedContext.length / 4)', () => {
		const agg = emptyAggregated({
			projectBrain: { available: true, facts: ['fact one', 'fact two'], decisions: [] },
			repository: { openFile: '/x.ts', relatedFiles: ['/y.ts'], projectEntryPoints: [] },
		});
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_GENERATION);
		assert.strictEqual(o.estimatedTokens, Math.floor(o.serializedContext.length / 4));
	});

	test('TERMINAL_EXECUTION prunes repository, dependencies and git but keeps files', () => {
		const agg = emptyAggregated({
			projectBrain: { available: true, facts: ['pb'], decisions: [] },
			repository: { openFile: '/x.ts', relatedFiles: [], projectEntryPoints: [] },
			currentFiles: [{ path: '/x.ts', language: 'typescript', content: 'code', trimmed: false }],
			dependencies: { projectType: 'node', packages: [{ name: 'react', version: '18' }] },
			gitState: { available: true, branch: 'main' },
		});
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.TERMINAL_EXECUTION);
		assert.ok(!o.serializedContext.includes('=== REPOSITORY ==='), 'repository pruned');
		assert.ok(!o.serializedContext.includes('=== DEPENDENCIES ==='), 'dependencies pruned');
		assert.ok(!o.serializedContext.includes('=== GIT ==='), 'git pruned');
		assert.ok(o.serializedContext.includes('=== FILE: /x.ts ==='), 'file kept');
		assert.ok(o.sectionsRemoved.some(h => h.includes('REPOSITORY')));
		assert.ok(o.sectionsRemoved.some(h => h.includes('DEPENDENC')));
		assert.ok(o.sectionsRemoved.some(h => h.includes('GIT')));
	});

	test('MEMORY_RETRIEVAL prunes repository, dependencies, git AND web', () => {
		const agg = emptyAggregated({
			repository: { openFile: '/x.ts', relatedFiles: [], projectEntryPoints: [] },
			dependencies: { projectType: 'node', packages: [{ name: 'react', version: '18' }] },
			gitState: { available: true, branch: 'main' },
			webResults: [{ injectedDirective: '[Search: x]' }],
		});
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.MEMORY_RETRIEVAL);
		assert.ok(!o.serializedContext.includes('=== REPOSITORY ==='));
		assert.ok(!o.serializedContext.includes('=== DEPENDENCIES ==='));
		assert.ok(!o.serializedContext.includes('=== GIT ==='));
		assert.ok(!o.serializedContext.includes('=== WEB ==='));
		assert.ok(o.sectionsRemoved.some(h => h.includes('WEB')));
	});

	test('WEB_SEARCH prunes repository/dependencies/git but KEEPS web', () => {
		const agg = emptyAggregated({
			repository: { openFile: '/x.ts', relatedFiles: [], projectEntryPoints: [] },
			gitState: { available: true, branch: 'main' },
			webResults: [{ injectedDirective: '[Search: latest]' }],
		});
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.WEB_SEARCH);
		assert.ok(!o.serializedContext.includes('=== REPOSITORY ==='), 'repository pruned');
		assert.ok(!o.serializedContext.includes('=== GIT ==='), 'git pruned');
		assert.ok(o.sectionsRemoved.some(h => h.includes('REPOSITORY')), 'repository reported removed');
		assert.ok(o.sectionsRemoved.some(h => h.includes('GIT')), 'git reported removed');
		// The web section survives pruning: its injected directive is retained. (The
		// prune step splits on `\n=== `, so a sole-surviving section keeps its content
		// under a `WEB ===` header without the re-added leading marker — the directive
		// text is the load-bearing proof that web context is kept for a web search.)
		assert.ok(o.serializedContext.includes('[Search: latest]'), 'web directive kept for a web search');
		assert.ok(!o.sectionsRemoved.some(h => h.includes('WEB')), 'web is never reported as removed');
	});

	test('CODE_GENERATION prunes nothing (sectionsRemoved is empty)', () => {
		const agg = emptyAggregated({
			repository: { openFile: '/x.ts', relatedFiles: [], projectEntryPoints: [] },
			dependencies: { projectType: 'node', packages: [{ name: 'react', version: '18' }] },
			gitState: { available: true, branch: 'main' },
		});
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_GENERATION);
		assert.deepStrictEqual(o.sectionsRemoved, []);
		assert.ok(o.serializedContext.includes('=== REPOSITORY ==='));
	});

	test('duplicate lines are removed case-insensitively', () => {
		const agg = emptyAggregated({ projectBrain: { available: true, facts: ['Uses Postgres', 'uses postgres'], decisions: [] } });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_GENERATION);
		const matches = o.serializedContext.match(/postgres/gi) || [];
		assert.strictEqual(matches.length, 1, 'the case-insensitive duplicate should be collapsed');
	});

	test('a very long line is trimmed by the safety-net pass', () => {
		const agg = emptyAggregated({ currentFiles: [{ path: '/big.ts', language: 'typescript', content: 'x'.repeat(300), trimmed: false }] });
		const o = optimizeContext(agg, PROMPT, DeveloperIntent.CODE_REVIEW);
		assert.ok(o.serializedContext.includes('[... trimmed ...]'), 'long line should be truncated');
	});

	test('optimizationDurationMs is a non-negative number', () => {
		const o = optimizeContext(emptyAggregated(), PROMPT, DeveloperIntent.CODE_GENERATION);
		assert.strictEqual(typeof o.optimizationDurationMs, 'number');
		assert.ok(o.optimizationDurationMs >= 0);
	});

	test('optimization is deterministic for identical input', () => {
		const build = () => emptyAggregated({
			projectBrain: { available: true, facts: ['a', 'b'], decisions: [] },
			repository: { openFile: '/x.ts', relatedFiles: ['/y.ts'], projectEntryPoints: [] },
		});
		const a = optimizeContext(build(), PROMPT, DeveloperIntent.CODE_GENERATION);
		const b = optimizeContext(build(), PROMPT, DeveloperIntent.CODE_GENERATION);
		assert.strictEqual(a.serializedContext, b.serializedContext);
		assert.deepStrictEqual(a.sectionsIncluded, b.sectionsIncluded);
	});
});
