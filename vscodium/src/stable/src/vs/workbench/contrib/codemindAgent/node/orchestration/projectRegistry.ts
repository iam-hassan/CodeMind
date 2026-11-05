/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * PPB Part 2 — P2-T02: Project Registry.
 *
 * Persists ProjectIdentity records and developer preferences in:
 *   ~/.codemind/projects.json
 *
 * File layout:
 *   {
 *     "version": 1,
 *     "globalPrefs": { ... GlobalDeveloperPrefs ... },
 *     "projects": {
 *       "<projectId>": {
 *         "identity": ProjectIdentity,
 *         "prefs": PerProjectPrefs   // only non-undefined (override) fields are stored
 *       }
 *     }
 *   }
 *
 * Writes are atomic: content is written to a `.tmp` sibling and then renamed.
 * Reads validate `globalPrefs` against a schema so a corrupt block cannot wipe
 * project records — projects and global prefs occupy separate top-level keys.
 *
 * `resolvePreferences(projectId)` is the single call site for computing the
 * effective ppbEnabled / maxInjectionTokens for a turn. Per-project fields use
 * `undefined` (not `false`) to mean "inherit global default", so the `??`
 * operator in resolvePreferences works correctly.
 *
 * Pure Node (fs, path, os); no vscode/electron import.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { resolveProjectIdentity, type ProjectIdentity } from './projectIdentity.js';

// ── Storage path ──────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1;

/**
 * Allow tests to override the registry directory without mutating HOME.
 * In production this is always undefined and registryDir() uses os.homedir().
 * @internal
 */
let _testRegistryDir: string | undefined;

/** Returns the directory that holds projects.json. Re-evaluated on every call so that
 *  process.env.HOME overrides (used in tests) take effect without a module reload. */
function registryDir(): string {
	if (_testRegistryDir !== undefined) { return _testRegistryDir; }
	return path.join(os.homedir(), '.codemind');
}
function registryFile(): string { return path.join(registryDir(), 'projects.json'); }
function registryTmp(): string  { return path.join(registryDir(), 'projects.json.tmp'); }

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Per-project preference overrides.
 * All fields are optional: `undefined` means "inherit the global default".
 * Storing `false` explicitly overrides a global `true`.
 */
export interface PerProjectPrefs {
	ppbEnabled?: boolean;
	maxInjectionTokens?: number;
}

/**
 * Global developer preferences — always have a concrete value (never undefined).
 * These represent the developer's personal style and apply across all projects
 * unless overridden by PerProjectPrefs.
 */
export interface GlobalDeveloperPrefs {
	// PPB behaviour
	ppbEnabled: boolean;
	maxInjectionTokens: number;
	// Coding style
	preferredLanguages: string[];
	indentStyle: 'spaces' | 'tabs';
	indentSize: number;
	lineEnding: 'lf' | 'crlf' | 'auto';
	// Freeform formatting rules
	formattingRules: string[];
}

/** Resolved preferences: per-project values merged over global defaults. */
export interface ResolvedPreferences {
	ppbEnabled: boolean;
	maxInjectionTokens: number;
}

// ── File schema types (used for safe JSON round-trips) ───────────────────────

interface ProjectRecord {
	identity: ProjectIdentity;
	prefs: PerProjectPrefs;
}

interface RegistryFile {
	version: number;
	globalPrefs: GlobalDeveloperPrefs;
	projects: Record<string, ProjectRecord>;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

function defaultGlobalPrefs(): GlobalDeveloperPrefs {
	return {
		ppbEnabled: true,            // part of CodeMind by default; unset env CODEMIND_PPB_ENABLED=0 disables
		maxInjectionTokens: 2000,
		preferredLanguages: [],
		indentStyle: 'spaces',
		indentSize: 2,
		lineEnding: 'auto',
		formattingRules: [],
	};
}

// ── In-memory cache ───────────────────────────────────────────────────────────

let _loaded = false;
let _projects: Map<string, ProjectRecord> = new Map();
let _globalPrefs: GlobalDeveloperPrefs = defaultGlobalPrefs();
let _cwdCache: Map<string, string> = new Map();

// ── Global prefs validation ───────────────────────────────────────────────────

/**
 * Validate and coerce a raw globalPrefs object loaded from disk.
 * Unknown or incorrectly-typed fields are silently replaced with the default.
 * A corrupt globalPrefs block cannot affect the projects map (separate key).
 */
function validateGlobalPrefs(raw: unknown): GlobalDeveloperPrefs {
	const def = defaultGlobalPrefs();
	if (typeof raw !== 'object' || raw === null) { return def; }
	const r = raw as Record<string, unknown>;
	return {
		ppbEnabled:          typeof r['ppbEnabled'] === 'boolean'    ? r['ppbEnabled']          : def.ppbEnabled,
		maxInjectionTokens:  typeof r['maxInjectionTokens'] === 'number' ? r['maxInjectionTokens'] : def.maxInjectionTokens,
		preferredLanguages:  Array.isArray(r['preferredLanguages'])  ? (r['preferredLanguages'] as string[]).filter(x => typeof x === 'string') : def.preferredLanguages,
		indentStyle:         (r['indentStyle'] === 'spaces' || r['indentStyle'] === 'tabs') ? r['indentStyle'] : def.indentStyle,
		indentSize:          typeof r['indentSize'] === 'number'     ? r['indentSize']           : def.indentSize,
		lineEnding:          (r['lineEnding'] === 'lf' || r['lineEnding'] === 'crlf' || r['lineEnding'] === 'auto') ? r['lineEnding'] : def.lineEnding,
		formattingRules:     Array.isArray(r['formattingRules'])     ? (r['formattingRules'] as string[]).filter(x => typeof x === 'string') : def.formattingRules,
	};
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function ensureDir(): Promise<void> {
	await mkdir(registryDir(), { recursive: true });
}

async function load(): Promise<void> {
	if (_loaded) { return; }
	_loaded = true;
	try {
		const raw = await readFile(registryFile(), 'utf8');
		const parsed = JSON.parse(raw) as Partial<RegistryFile>;

		// Validate global prefs separately — a corrupt block cannot touch projects
		_globalPrefs = validateGlobalPrefs(parsed.globalPrefs);

		// Load project records (skip entries with missing/invalid projectId)
		_projects = new Map();
		if (parsed.projects && typeof parsed.projects === 'object') {
			for (const [id, record] of Object.entries(parsed.projects)) {
				if (typeof id === 'string' && id && record?.identity) {
					_projects.set(id, {
						identity: record.identity as ProjectIdentity,
						prefs: typeof record.prefs === 'object' && record.prefs !== null
							? record.prefs as PerProjectPrefs
							: {},
					});
				}
			}
		}
	} catch {
		// File does not exist or is unparseable — start with defaults
		_projects = new Map();
		_globalPrefs = defaultGlobalPrefs();
	}
}

async function persist(): Promise<void> {
	await ensureDir();
	const projectsObj: Record<string, ProjectRecord> = {};
	for (const [id, rec] of _projects) {
		projectsObj[id] = rec;
	}
	const content: RegistryFile = {
		version: CURRENT_VERSION,
		globalPrefs: _globalPrefs,
		projects: projectsObj,
	};
	const json = JSON.stringify(content, null, 2);
	// Atomic write: write tmp then rename
	await writeFile(registryTmp(), json, 'utf8');
	// On Windows, rename can replace an existing file; use it for atomicity
	const { rename } = await import('fs/promises');
	try {
		await rename(registryTmp(), registryFile());
	} catch {
		// rename may fail on Windows across devices (shouldn't happen same-dir)
		await writeFile(registryFile(), json, 'utf8');
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return (and persist if new) the ProjectIdentity for the given workspace directory.
 * The in-memory cache is consulted first; identity is derived via resolveProjectIdentity
 * and stored on first call for a given cwd.
 *
 * Never throws.
 */
export async function getOrCreateProject(cwd: string): Promise<ProjectIdentity> {
	await load();
	const cachedId = _cwdCache.get(cwd);
	if (cachedId) {
		const rec = _projects.get(cachedId);
		if (rec) {
			return rec.identity;
		}
	}

	// Check if this cwd already maps to a known project
	// (search by repoPath since cwd may differ from the stored repoPath)
	for (const rec of _projects.values()) {
		if (rec.identity.repoPath === cwd || rec.identity.primarySignal === cwd) {
			_cwdCache.set(cwd, rec.identity.projectId);
			return rec.identity;
		}
	}

	const identity = await resolveProjectIdentity(cwd);
	_cwdCache.set(cwd, identity.projectId);
	// Also check by projectId in case a different cwd maps to the same repo
	if (!_projects.has(identity.projectId)) {
		_projects.set(identity.projectId, { identity, prefs: {} });
		// Await persist so callers that read the file immediately (e.g. tests)
		// see the written record. Registration only happens once per project so
		// this does not add meaningful latency to the per-turn path.
		await persist();
	}
	return identity;
}

/** List all known projects (in-memory; loads from disk on first call). */
export async function listProjects(): Promise<ProjectIdentity[]> {
	await load();
	return [..._projects.values()].map(r => r.identity);
}

/**
 * Delete a project record.
 * Validates that projectId is non-empty before writing.
 * Global prefs are NOT affected.
 */
export async function deleteProject(projectId: string): Promise<void> {
	if (!projectId) { throw new Error('projectId must not be empty'); }
	await load();
	_projects.delete(projectId);
	await persist();
}

// ── Global developer preferences ──────────────────────────────────────────────

/** Returns the current global developer preferences (loaded from disk on first call). */
export async function getGlobalDeveloperPrefs(): Promise<GlobalDeveloperPrefs> {
	await load();
	return { ..._globalPrefs };
}

/** Update global developer preferences (partial merge). Validates on load. */
export async function setGlobalDeveloperPrefs(prefs: Partial<GlobalDeveloperPrefs>): Promise<void> {
	await load();
	_globalPrefs = validateGlobalPrefs({ ..._globalPrefs, ...prefs });
	await persist();
}

// ── Per-project preferences ───────────────────────────────────────────────────

/**
 * Returns per-project preference overrides.
 * Fields that are not overridden are `undefined` (not the global default).
 * Use `resolvePreferences` to get the effective merged value.
 */
export async function getPerProjectPrefs(projectId: string): Promise<PerProjectPrefs> {
	if (!projectId) { return {}; }
	await load();
	return { ...(_projects.get(projectId)?.prefs ?? {}) };
}

/**
 * Set per-project preference overrides. Pass `undefined` for a field to clear it
 * (restore inheritance of the global default).
 *
 * Validates that projectId is non-empty.
 */
export async function setPerProjectPrefs(projectId: string, prefs: PerProjectPrefs): Promise<void> {
	if (!projectId) { throw new Error('projectId must not be empty'); }
	await load();
	const existing = _projects.get(projectId);
	if (!existing) {
		// Project not yet registered — this is a logic error in the caller
		throw new Error(`Unknown projectId: ${projectId}`);
	}
	existing.prefs = { ...prefs }; // store only the explicitly-set overrides
	await persist();
}

// ── Scope resolution ──────────────────────────────────────────────────────────

/**
 * Returns the effective preferences for a project: per-project overrides win over
 * global defaults for fields that are explicitly set (not undefined).
 *
 * This is the SINGLE call site that computes ppbEnabled / maxInjectionTokens.
 * Both segmentQueue.enqueue() and injectionBlock use this function.
 *
 * Sync (reads from in-memory cache). Call after load() has been awaited.
 */
export function resolvePreferences(projectId: string): ResolvedPreferences {
	const global = _globalPrefs;
	const perProject = _projects.get(projectId)?.prefs ?? {};
	return {
		// ?? is correct here: perProject fields are undefined (not false) when not set
		ppbEnabled:         perProject.ppbEnabled         ?? global.ppbEnabled,
		maxInjectionTokens: perProject.maxInjectionTokens ?? global.maxInjectionTokens,
	};
}

// ── Cross-project leak filter ─────────────────────────────────────────────────

/**
 * Filter a list of retrieved facts to only those belonging to `projectId`.
 * Facts with a mismatched or missing projectId are dropped silently.
 *
 * Exported for direct testing and used by injectionBlock before formatting.
 */
export function filterToProject<T extends { projectId?: string }>(
	facts: T[],
	projectId: string,
): T[] {
	if (!projectId) { return []; }
	return facts.filter(f => f.projectId === projectId);
}

// ── Internal test helpers ─────────────────────────────────────────────────────

/**
 * Reset in-memory state. ONLY for use in unit tests.
 * @internal
 */
export function _resetForTests(): void {
	_loaded = false;
	_projects = new Map();
	_globalPrefs = defaultGlobalPrefs();
	_cwdCache = new Map();
	_testRegistryDir = undefined;
}

/**
 * Override the registry directory used by the module. ONLY for use in unit tests.
 * Call _resetForTests() first to clear any loaded state.
 * @internal
 */
export function _setRegistryDirForTests(dir: string): void {
	_testRegistryDir = dir;
}

/**
 * Return the absolute path to the registry file the module will use on the next
 * load/persist call.  ONLY for use in unit tests — to let tests read/corrupt the
 * file at the exact same path the module writes to.
 * @internal
 */
export function _getRegistryFileForTests(): string {
	return registryFile();
}
