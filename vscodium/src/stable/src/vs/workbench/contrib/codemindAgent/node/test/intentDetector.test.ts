/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { classifyIntent } from '../orchestration/intentDetector.js';
import { DeveloperIntent } from '../orchestration/types.js';

/**
 * Proves the intent classifier maps representative developer prompts to the right
 * DeveloperIntent with the expected confidence band and non-empty signals.
 * Every expected value below was captured from the compiled classifier itself.
 */
suite('Orchestration › intentDetector', () => {

	// [prompt, expected intent, expected confidence (±0.01)]
	const CASES: Array<[string, DeveloperIntent, number]> = [
		// CODE_GENERATION
		['Implement a login screen using Clerk', DeveloperIntent.CODE_GENERATION, 0.75],
		['Build a REST API endpoint for users', DeveloperIntent.CODE_GENERATION, 0.917],
		['generate a TypeScript interface for the config', DeveloperIntent.CODE_GENERATION, 0.75],
		['write a function to parse dates', DeveloperIntent.CODE_GENERATION, 0.917],
		['create a new component for the navbar', DeveloperIntent.CODE_GENERATION, 0.917],
		['IMPLEMENT A LOGIN SCREEN USING CLERK', DeveloperIntent.CODE_GENERATION, 0.75],
		['implement a login screen using clerk!!!', DeveloperIntent.CODE_GENERATION, 0.75],
		// MEMORY_RETRIEVAL
		['What database are we using?', DeveloperIntent.MEMORY_RETRIEVAL, 0.98],
		['which library did we decide on for state management', DeveloperIntent.MEMORY_RETRIEVAL, 0.98],
		['remind me what the reason was for choosing Postgres', DeveloperIntent.MEMORY_RETRIEVAL, 0.833],
		// ARCHITECTURE
		['give me a high-level overview of the module structure', DeveloperIntent.ARCHITECTURE, 0.833],
		['design the folder layout for the app', DeveloperIntent.ARCHITECTURE, 0.5],
		// WEB_SEARCH
		['Search for the latest Next.js pricing', DeveloperIntent.WEB_SEARCH, 0.833],
		['find the latest release notes for Node', DeveloperIntent.WEB_SEARCH, 0.833],
		// GIT_OPERATIONS
		['commit these changes with a good message', DeveloperIntent.GIT_OPERATIONS, 0.833],
		['push my branch to origin', DeveloperIntent.GIT_OPERATIONS, 0.833],
		// TERMINAL_EXECUTION
		['npm run build the whole project now', DeveloperIntent.TERMINAL_EXECUTION, 0.98],
		['yarn install and start the dev server', DeveloperIntent.TERMINAL_EXECUTION, 0.98],
		// DOCUMENTATION
		['document this module in the readme', DeveloperIntent.DOCUMENTATION, 0.917],
		['document the authentication flow', DeveloperIntent.DOCUMENTATION, 0.917],
		// DEBUGGING
		['fix the bug that crashes on startup', DeveloperIntent.DEBUGGING, 0.833],
		// CODE_REVIEW
		['review this code for any issues here', DeveloperIntent.CODE_REVIEW, 0.833],
		['check this for correctness and clean up', DeveloperIntent.CODE_REVIEW, 0.833],
		['refactor this function to be cleaner', DeveloperIntent.CODE_REVIEW, 0.833],
		// TESTING
		['write tests for the parser module', DeveloperIntent.TESTING, 0.5],
		['add unit tests for the login module', DeveloperIntent.TESTING, 0.5],
		// PROJECT_ANALYSIS
		['analyze the project dependencies and tech stack', DeveloperIntent.PROJECT_ANALYSIS, 0.917],
		['summarize the project and give me metrics', DeveloperIntent.PROJECT_ANALYSIS, 0.917],
		// MULTI_TOOL_WORKFLOW (two strong competing signals)
		['Build auth using Clerk and also check the latest Clerk pricing', DeveloperIntent.MULTI_TOOL_WORKFLOW, 0.65],
		['why is my authentication failing with an error', DeveloperIntent.MULTI_TOOL_WORKFLOW, 0.7],
	];

	for (const [prompt, intent, conf] of CASES) {
		test(`classifies "${prompt}" → ${intent} (~${conf})`, () => {
			const r = classifyIntent(prompt);
			assert.strictEqual(r.intent, intent, `intent for "${prompt}"`);
			assert.ok(Math.abs(r.confidence - conf) < 0.01, `confidence for "${prompt}": expected ~${conf}, got ${r.confidence}`);
			assert.ok(Array.isArray(r.signals) && r.signals.length > 0, `signals non-empty for "${prompt}"`);
		});
	}

	// --- Fast paths & edge cases ---

	test('slash command "/status" → TERMINAL_EXECUTION with confidence 1.0', () => {
		const r = classifyIntent('/status');
		assert.strictEqual(r.intent, DeveloperIntent.TERMINAL_EXECUTION);
		assert.strictEqual(r.confidence, 1.0);
		assert.deepStrictEqual(r.signals, ['slash_command']);
	});

	test('slash command with args "/deploy the app now" → TERMINAL_EXECUTION 1.0', () => {
		const r = classifyIntent('/deploy the app now');
		assert.strictEqual(r.intent, DeveloperIntent.TERMINAL_EXECUTION);
		assert.strictEqual(r.confidence, 1.0);
		assert.deepStrictEqual(r.signals, ['slash_command']);
	});

	test('very short prompt "hi" → CODE_GENERATION short_prompt_fallback', () => {
		const r = classifyIntent('hi');
		assert.strictEqual(r.intent, DeveloperIntent.CODE_GENERATION);
		assert.strictEqual(r.confidence, 0.5);
		assert.deepStrictEqual(r.signals, ['short_prompt_fallback']);
	});

	test('"test" (<5 chars) hits the short-prompt fast path, NOT the testing keyword', () => {
		const r = classifyIntent('test');
		assert.strictEqual(r.intent, DeveloperIntent.CODE_GENERATION);
		assert.deepStrictEqual(r.signals, ['short_prompt_fallback']);
	});

	test('empty prompt → CODE_GENERATION short_prompt_fallback', () => {
		const r = classifyIntent('');
		assert.strictEqual(r.intent, DeveloperIntent.CODE_GENERATION);
		assert.strictEqual(r.confidence, 0.5);
		assert.deepStrictEqual(r.signals, ['short_prompt_fallback']);
	});

	test('whitespace-only prompt is treated as short (trimmed)', () => {
		const r = classifyIntent('     ');
		assert.strictEqual(r.intent, DeveloperIntent.CODE_GENERATION);
		assert.deepStrictEqual(r.signals, ['short_prompt_fallback']);
	});

	test('gibberish with no signals → CODE_GENERATION 0.3 no_strong_signals', () => {
		const r = classifyIntent('asdf qwer zxcv hjkl');
		assert.strictEqual(r.intent, DeveloperIntent.CODE_GENERATION);
		assert.ok(Math.abs(r.confidence - 0.3) < 0.01, `got ${r.confidence}`);
		assert.deepStrictEqual(r.signals, ['no_strong_signals']);
	});

	test('casing does not change the classified intent', () => {
		const lower = classifyIntent('review this code for any issues here');
		const upper = classifyIntent('REVIEW THIS CODE FOR ANY ISSUES HERE');
		assert.strictEqual(lower.intent, upper.intent);
		assert.strictEqual(lower.intent, DeveloperIntent.CODE_REVIEW);
	});

	// --- Invariants across a batch of prompts ---

	const BATCH = [
		'Implement a login screen using Clerk', 'What database are we using?',
		'Search for the latest Next.js pricing', 'commit these changes',
		'npm run build the whole project', 'review this code for any issues here',
		'analyze the project dependencies', '/deploy', 'x', 'asdf qwer zxcv',
	];

	test('confidence is always within [0, 1]', () => {
		for (const p of BATCH) {
			const c = classifyIntent(p).confidence;
			assert.ok(c >= 0 && c <= 1, `confidence out of range for "${p}": ${c}`);
		}
	});

	test('signals is always a non-empty string array', () => {
		for (const p of BATCH) {
			const s = classifyIntent(p).signals;
			assert.ok(Array.isArray(s) && s.length > 0, `signals empty for "${p}"`);
			assert.ok(s.every(x => typeof x === 'string'), `non-string signal for "${p}"`);
		}
	});

	test('classified intent is always a known DeveloperIntent value', () => {
		const known = new Set(Object.values(DeveloperIntent));
		for (const p of BATCH) {
			assert.ok(known.has(classifyIntent(p).intent), `unknown intent for "${p}"`);
		}
	});

	test('classifier is deterministic for the same prompt', () => {
		const a = classifyIntent('Build a REST API endpoint for users');
		const b = classifyIntent('Build a REST API endpoint for users');
		assert.deepStrictEqual(a, b);
	});
});
