/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * PPB Part 2 — P2-T01: Project Identity Resolution.
 *
 * Derives a stable projectId (UUIDv5) for a workspace directory. The identity signal
 * is chosen from most-stable to least-stable:
 *
 *   1. Normalised Git remote URL (survives renames, moves, re-clones of the same remote)
 *   2. First-commit hash (survives renames/moves; different for forks)
 *   3. realpath(cwd) (non-git folders only)
 *
 * For multiple remotes: prefer 'origin'; otherwise take the alphabetically-first name.
 * Forks have a different remote URL → different projectId (intentional: fork knowledge
 * graphs should be independent of the upstream).
 *
 * All git calls are bounded at GIT_TIMEOUT_MS and treat any error as "unavailable".
 * Pure Node (child_process, fs, crypto); no vscode/electron import.
 */

import { exec } from 'child_process';
import { realpath } from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * DNS namespace UUID used as the UUIDv5 namespace.
 * Chosen once and fixed forever; changing it would invalidate all stored project IDs.
 */
const PPB_NAMESPACE_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** Maximum time (ms) to wait for any single git command. */
const GIT_TIMEOUT_MS = 500;

// ── Public types ─────────────────────────────────────────────────────────────

export interface ProjectIdentity {
	/** UUIDv5(PPB_NAMESPACE, primarySignal) — stable across renames/moves. */
	readonly projectId: string;
	/** The normalised string that was hashed to produce projectId. */
	readonly primarySignal: string;
	/** How primarySignal was obtained. */
	readonly signalKind: 'git-remote' | 'first-commit' | 'path';
	/** Absolute path of the git repository root, or realpath(cwd) for non-git. */
	readonly repoPath: string;
	/** Raw (pre-normalisation) remote URL, when available. */
	readonly gitRemote?: string;
	/** Current HEAD SHA (8 chars) — informational only; NOT used for identity. */
	readonly gitHeadSha?: string;
	/** basename(repoPath) — human-readable project name. */
	readonly workspaceName: string;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/** Run a git command in cwd, resolve with stdout, or resolve with '' on any error. */
function gitExec(args: string, cwd: string): Promise<string> {
	return new Promise<string>(resolve => {
		const child = exec(
			`git ${args}`,
			{ cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
			(err, stdout) => resolve(err ? '' : stdout.trim()),
		);
		child.on('error', () => resolve(''));
	});
}

/** Resolve the git repository root for `cwd`. Returns '' if not a git repo. */
async function gitRoot(cwd: string): Promise<string> {
	return gitExec('rev-parse --show-toplevel', cwd);
}

/**
 * Returns all remotes as a Map<name, url>. Returns empty map on any error.
 * Parses `git remote -v` output:
 *   origin  https://github.com/org/repo.git (fetch)
 */
async function gitRemotes(cwd: string): Promise<Map<string, string>> {
	const output = await gitExec('remote -v', cwd);
	const remotes = new Map<string, string>();
	if (!output) { return remotes; }
	for (const line of output.split('\n')) {
		// Only capture the first occurrence of each name (fetch vs push duplicates)
		const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
		if (m && !remotes.has(m[1])) {
			remotes.set(m[1], m[2]);
		}
	}
	return remotes;
}

/** First commit hash (short, 40 chars). Returns '' if none. */
async function gitFirstCommitHash(cwd: string): Promise<string> {
	// --max-parents=0 returns only root commits
	return gitExec('rev-list --max-parents=0 HEAD', cwd);
}

/** Current HEAD sha (8 chars). Returns '' on error. */
async function gitHeadSha(cwd: string): Promise<string> {
	const sha = await gitExec('rev-parse --short=8 HEAD', cwd);
	return sha.slice(0, 8); // guard against unexpected output
}

// ── Remote URL normalisation ──────────────────────────────────────────────────

/**
 * Normalise a git remote URL so that all of the following produce the same string:
 *
 *   https://github.com/org/repo.git       →  github.com/org/repo
 *   https://github.com/org/repo           →  github.com/org/repo
 *   git@github.com:org/repo.git           →  github.com/org/repo
 *   git@github.com:org/repo               →  github.com/org/repo
 *   ssh://git@github.com/org/repo.git     →  github.com/org/repo
 *   https://user:pass@github.com/org/repo →  github.com/org/repo
 *
 * The function is exported for direct testing.
 */
export function normaliseRemoteUrl(raw: string): string {
	if (!raw.trim()) { return ''; }

	// Lowercase the entire input first so that all subsequent string comparisons
	// and replacements work uniformly regardless of scheme casing (HTTPS:// vs https://).
	let s = raw.trim().toLowerCase();

	// 1. Strip SSH SCP syntax: git@host:path or user@host:path → host/path
	// This branch matches only when there is no URL scheme prefix.
	const scpMatch = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(s);
	if (scpMatch && !s.startsWith('http') && !s.startsWith('ssh') && !s.startsWith('git://')) {
		s = `${scpMatch[1]}/${scpMatch[2]}`;
	} else {
		// 2. Strip scheme (https://, ssh://, git://, etc.)
		s = s.replace(/^[a-z][a-z0-9+\-.]*:\/\//, '');
		// 3. Strip optional user:password@ prefix (after scheme removal)
		s = s.replace(/^[^@]*@/, '');
	}

	// 4. Strip trailing .git
	s = s.replace(/\.git$/, '');

	// 5. Collapse multiple consecutive slashes
	s = s.replace(/\/+/g, '/');

	// 6. Trim trailing slash
	s = s.replace(/\/$/, '');

	return s;
}

// ── UUIDv5 implementation (no external deps) ──────────────────────────────────

/**
 * Compute a UUIDv5 from a namespace UUID string and a name string.
 * Implements RFC 4122 §4.3 using SHA-1.
 */
function uuidv5(namespaceUuid: string, name: string): string {
	// Convert namespace UUID string to bytes (strip hyphens, parse as hex)
	const nsHex = namespaceUuid.replace(/-/g, '');
	const nsBytes = Buffer.from(nsHex, 'hex');
	const nameBytes = Buffer.from(name, 'utf8');

	const hash = createHash('sha1')
		.update(nsBytes)
		.update(nameBytes)
		.digest();

	// Set version (5) and variant bits per RFC 4122
	hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
	hash[8] = (hash[8] & 0x3f) | 0x80; // variant 10xx

	const h = hash.toString('hex');
	return [
		h.slice(0, 8),
		h.slice(8, 12),
		h.slice(12, 16),
		h.slice(16, 20),
		h.slice(20, 32),
	].join('-');
}

/** Generate a UUIDv4 (random). Used only as last-resort for non-git, no-path cases. */
function uuidv4(): string {
	const bytes = Buffer.allocUnsafe(16);
	for (let i = 0; i < 16; i++) { bytes[i] = Math.floor(Math.random() * 256); }
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const h = bytes.toString('hex');
	return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Derive a stable `ProjectIdentity` for the given workspace directory.
 *
 * Never throws: all I/O errors degrade to the next-priority signal.
 */
export async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentity> {
	// Resolve to an absolute real path first (handles symlinks, \\?\ prefixes on Windows)
	let resolvedCwd: string;
	try {
		resolvedCwd = await realpath(cwd);
	} catch {
		resolvedCwd = cwd;
	}

	// Determine the git root (or fall back to cwd)
	const root = await gitRoot(resolvedCwd);
	const repoPath = root || resolvedCwd;
	const workspaceName = path.basename(repoPath);

	// HEAD sha (informational)
	const headSha = root ? await gitHeadSha(repoPath) : '';

	// Signal 1: Git remote URL
	if (root) {
		const remotes = await gitRemotes(repoPath);
		if (remotes.size > 0) {
			// Prefer 'origin'; else take alphabetically-first remote name
			const remoteName = remotes.has('origin')
				? 'origin'
				: [...remotes.keys()].sort()[0];
			const rawRemote = remotes.get(remoteName)!;
			const normalised = normaliseRemoteUrl(rawRemote);
			if (normalised) {
				return {
					projectId: uuidv5(PPB_NAMESPACE_UUID, normalised),
					primarySignal: normalised,
					signalKind: 'git-remote',
					repoPath,
					gitRemote: rawRemote,
					gitHeadSha: headSha || undefined,
					workspaceName,
				};
			}
		}

		// Signal 2: First commit hash (repo exists but has no remote)
		const firstCommit = await gitFirstCommitHash(repoPath);
		if (firstCommit) {
			return {
				projectId: uuidv5(PPB_NAMESPACE_UUID, firstCommit),
				primarySignal: firstCommit,
				signalKind: 'first-commit',
				repoPath,
				gitHeadSha: headSha || undefined,
				workspaceName,
			};
		}
	}

	// Signal 3: realpath (non-git folder or empty repo with no commits)
	const signal = repoPath || resolvedCwd || uuidv4();
	return {
		projectId: uuidv5(PPB_NAMESPACE_UUID, signal),
		primarySignal: signal,
		signalKind: 'path',
		repoPath,
		gitHeadSha: headSha || undefined,
		workspaceName,
	};
}
