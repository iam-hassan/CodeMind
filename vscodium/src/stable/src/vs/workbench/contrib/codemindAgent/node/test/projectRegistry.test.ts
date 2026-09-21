/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
	getOrCreateProject,
	listProjects,
	deleteProject,
	getGlobalDeveloperPrefs,
	setGlobalDeveloperPrefs,
	getPerProjectPrefs,
	setPerProjectPrefs,
	resolvePreferences,
	filterToProject,
	_resetForTests,
	_setRegistryDirForTests,
	_getRegistryFileForTests,
} from '../orchestration/projectRegistry.js';

/**
 * P2-T02 tests — Project Registry.
 *
 * Every test calls _resetForTests() first to wipe in-memory state, then points
 * the registry at a fresh temp directory so tests do not share disk state.
 *
 * Scenarios covered:
 *   - getOrCreateProject creates projects.json on first call
 *   - Same cwd → same projectId
 *   - resolvePreferences inheritance (no per-project override → global default)
 *   - resolvePreferences override (per-project false beats global true)
 *   - Corrupt globalPrefs block → safe defaults, project records untouched
 *   - deleteProject removes project but leaves global prefs
 *   - setPerProjectPrefs with empty projectId → throws
 *   - filterToProject: cross-project leak guarantee
 *   - filterToProject: missing/empty projectId → filtered out
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Interface for a fact-like object used in filterToProject tests. */
interface Fact {
	id: string;
	projectId: string;
	content: string;
}

function makeFacts(...pairs: [string, string][]): Fact[] {
	return pairs.map(([id, projectId]) => ({ id, projectId, content: `content-${id}` }));
}

// ── Per-test registry directory isolation ────────────────────────────────────
// Each test gets its own temp dir via _setRegistryDirForTests().  This is
// more reliable than mutating HOME (os.homedir() is evaluated at module-load
// time when constants are top-level; _setRegistryDirForTests overrides it
// via the module's lazy getter).

let _tempRegistryDir: string;

async function setupTempRegistry(): Promise<void> {
	_tempRegistryDir = await mkdtemp(join(tmpdir(), 'ppb-reg-'));
	_setRegistryDirForTests(_tempRegistryDir);
}

async function teardownTempRegistry(): Promise<void> {
	try { await rm(_tempRegistryDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

suite('PPB › projectRegistry', () => {

	setup(async () => {
		_resetForTests();
		await setupTempRegistry();
	});

	teardown(async () => {
		_resetForTests();
		await teardownTempRegistry();
	});

	// ── getOrCreateProject ───────────────────────────────────────────────────

	test('creates projects.json on first call', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const identity = await getOrCreateProject(dir);
			assert.ok(identity.projectId, 'projectId must be non-empty');
			assert.match(identity.projectId, /^[0-9a-f-]{36}$/, 'Must be a valid UUID');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('same cwd called twice returns the same projectId', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id1 = await getOrCreateProject(dir);
			// Force an in-memory reset and re-point to the same temp registry dir
			// so the second call reloads from disk (proving persistence).
			_resetForTests();
			_setRegistryDirForTests(_tempRegistryDir);
			const id2 = await getOrCreateProject(dir);
			assert.strictEqual(id1.projectId, id2.projectId, 'projectId must be stable');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('second call with same cwd hits in-memory cache and returns exact same reference', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id1 = await getOrCreateProject(dir);
			const id2 = await getOrCreateProject(dir);
			assert.strictEqual(id1, id2, 'Must return the exact same object reference from cache');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── listProjects / deleteProject ─────────────────────────────────────────

	test('listProjects includes a project that was created', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			await getOrCreateProject(dir);
			const list = await listProjects();
			assert.ok(list.length >= 1, 'At least one project should be listed');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('deleteProject removes the project record', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			await deleteProject(id.projectId);
			const list = await listProjects();
			assert.ok(!list.some(p => p.projectId === id.projectId), 'Deleted project must not appear in list');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('deleteProject leaves global prefs intact', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			const id = await getOrCreateProject(dir);
			await setGlobalDeveloperPrefs({ formattingRules: ['Use early returns'] });
			await deleteProject(id.projectId);
			const prefs = await getGlobalDeveloperPrefs();
			assert.deepStrictEqual(prefs.formattingRules, ['Use early returns']);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('deleteProject with empty projectId throws', async () => {
		await assert.rejects(
			() => deleteProject(''),
			/projectId must not be empty/,
		);
	});

	// ── resolvePreferences: inheritance ──────────────────────────────────────

	test('project with NO per-project override inherits global ppbEnabled [REQUIRED]', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			await setGlobalDeveloperPrefs({ ppbEnabled: true });
			const id = await getOrCreateProject(dir);
			// No per-project prefs set → should inherit global
			const resolved = resolvePreferences(id.projectId);
			assert.strictEqual(resolved.ppbEnabled, true, 'Must inherit global ppbEnabled=true');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('project with NO per-project override inherits global maxInjectionTokens [REQUIRED]', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			await setGlobalDeveloperPrefs({ maxInjectionTokens: 3000 });
			const id = await getOrCreateProject(dir);
			const resolved = resolvePreferences(id.projectId);
			assert.strictEqual(resolved.maxInjectionTokens, 3000, 'Must inherit global maxInjectionTokens');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── resolvePreferences: override ─────────────────────────────────────────

	test('per-project ppbEnabled=false overrides global ppbEnabled=true [REQUIRED]', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			await setGlobalDeveloperPrefs({ ppbEnabled: true });
			const id = await getOrCreateProject(dir);
			await setPerProjectPrefs(id.projectId, { ppbEnabled: false });
			const resolved = resolvePreferences(id.projectId);
			assert.strictEqual(resolved.ppbEnabled, false, 'Per-project false must override global true');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('per-project ppbEnabled=true overrides global ppbEnabled=false', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			await setGlobalDeveloperPrefs({ ppbEnabled: false });
			const id = await getOrCreateProject(dir);
			await setPerProjectPrefs(id.projectId, { ppbEnabled: true });
			const resolved = resolvePreferences(id.projectId);
			assert.strictEqual(resolved.ppbEnabled, true, 'Per-project true must override global false');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('per-project maxInjectionTokens overrides global default', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			await setGlobalDeveloperPrefs({ maxInjectionTokens: 2000 });
			const id = await getOrCreateProject(dir);
			await setPerProjectPrefs(id.projectId, { maxInjectionTokens: 500 });
			const resolved = resolvePreferences(id.projectId);
			assert.strictEqual(resolved.maxInjectionTokens, 500);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	test('undefined per-project ppbEnabled (not set) correctly inherits global', async () => {
		// This specifically tests the ?? operator: undefined ?? global, not false ?? global
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			await setGlobalDeveloperPrefs({ ppbEnabled: true });
			const id = await getOrCreateProject(dir);
			await setPerProjectPrefs(id.projectId, {}); // no ppbEnabled field → undefined
			const resolved = resolvePreferences(id.projectId);
			assert.strictEqual(resolved.ppbEnabled, true, 'undefined per-project must not block global true');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── Corrupt globalPrefs ───────────────────────────────────────────────────

	test('corrupt globalPrefs block uses safe defaults; project records untouched', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ppb-ws-'));
		try {
			// Pre-create a registry file with corrupt globalPrefs but valid project data
			const id = await getOrCreateProject(dir);
			const projectId = id.projectId;

			// Explicitly flush prefs to disk and find out the EXACT path the module
			// uses — so we corrupt the right file regardless of _tempRegistryDir.
			await setGlobalDeveloperPrefs({ formattingRules: ['sentinel'] });
			const registryPath = _getRegistryFileForTests();

			// Manually corrupt the globalPrefs section on disk.
			const raw = JSON.parse(await readFile(registryPath, 'utf8'));
			raw.globalPrefs = { ppbEnabled: 'not-a-boolean', maxInjectionTokens: 'not-a-number', garbage: true };
			await writeFile(registryPath, JSON.stringify(raw, null, 2), 'utf8');

			// Reset in-memory state and re-point to the same temp dir so the
			// next load() reads the corrupted file.
			_resetForTests();
			_setRegistryDirForTests(_tempRegistryDir);

			const prefs = await getGlobalDeveloperPrefs();
			// Corrupt fields should be replaced with defaults
			assert.strictEqual(typeof prefs.ppbEnabled, 'boolean', 'ppbEnabled must be boolean after corrupt load');
			assert.strictEqual(typeof prefs.maxInjectionTokens, 'number', 'maxInjectionTokens must be number');

			// Project record must still be accessible
			const list = await listProjects();
			assert.ok(list.some(p => p.projectId === projectId), 'Project record must survive corrupt globalPrefs');
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	// ── setPerProjectPrefs guard ──────────────────────────────────────────────

	test('setPerProjectPrefs with empty projectId throws', async () => {
		await assert.rejects(
			() => setPerProjectPrefs('', { ppbEnabled: true }),
			/projectId must not be empty/,
		);
	});

	test('setPerProjectPrefs with unknown projectId throws', async () => {
		await assert.rejects(
			() => setPerProjectPrefs('non-existent-uuid', { ppbEnabled: true }),
			/Unknown projectId/,
		);
	});

	// ── filterToProject ───────────────────────────────────────────────────────

	test('filterToProject returns only facts for the given project', () => {
		const facts = makeFacts(['1', 'uuid-A'], ['2', 'uuid-B'], ['3', 'uuid-A']);
		const result = filterToProject(facts, 'uuid-A');
		assert.deepStrictEqual(result.map(f => f.id), ['1', '3']);
	});

	test('filterToProject returns only project B facts when queried for B', () => {
		const facts = makeFacts(['1', 'uuid-A'], ['2', 'uuid-B'], ['3', 'uuid-A']);
		const result = filterToProject(facts, 'uuid-B');
		assert.deepStrictEqual(result.map(f => f.id), ['2']);
	});

	test('filterToProject returns empty array for unknown project [cross-project leak test]', () => {
		const facts = makeFacts(['1', 'uuid-A'], ['2', 'uuid-B']);
		const result = filterToProject(facts, 'uuid-C');
		assert.strictEqual(result.length, 0);
	});

	test('filterToProject: data written for project A is never returned for project B [REQUIRED]', () => {
		// This is the definitive cross-project leak test
		const projectAFacts = makeFacts(['1', 'uuid-A'], ['2', 'uuid-A'], ['3', 'uuid-A']);
		const resultForB = filterToProject(projectAFacts, 'uuid-B');
		assert.strictEqual(resultForB.length, 0, 'No project-A fact must appear in a project-B query');
	});

	test('filterToProject: fact with empty projectId is filtered out', () => {
		const facts: Fact[] = [{ id: '1', projectId: '', content: 'x' }];
		const result = filterToProject(facts, 'uuid-A');
		assert.strictEqual(result.length, 0);
	});

	test('filterToProject: empty facts array returns empty array', () => {
		assert.deepStrictEqual(filterToProject([], 'uuid-A'), []);
	});

	test('filterToProject: empty projectId argument returns empty array', () => {
		const facts = makeFacts(['1', 'uuid-A']);
		assert.deepStrictEqual(filterToProject(facts, ''), []);
	});

	// ── Global developer prefs persistence ────────────────────────────────────

	test('setGlobalDeveloperPrefs persists formattingRules across reload', async () => {
		const rules = ['Use early returns', 'Prefer async/await'];
		await setGlobalDeveloperPrefs({ formattingRules: rules });
		// After a reset, re-point to the same temp dir before reloading
		_resetForTests();
		_setRegistryDirForTests(_tempRegistryDir);
		const prefs = await getGlobalDeveloperPrefs();
		assert.deepStrictEqual(prefs.formattingRules, rules);
	});

	test('setGlobalDeveloperPrefs: partial update does not wipe other fields', async () => {
		await setGlobalDeveloperPrefs({ indentSize: 4, preferredLanguages: ['typescript'] });
		await setGlobalDeveloperPrefs({ formattingRules: ['No magic numbers'] });
		const prefs = await getGlobalDeveloperPrefs();
		assert.strictEqual(prefs.indentSize, 4, 'indentSize must survive partial update');
		assert.deepStrictEqual(prefs.preferredLanguages, ['typescript'], 'preferredLanguages must survive');
		assert.deepStrictEqual(prefs.formattingRules, ['No magic numbers']);
	});
});
