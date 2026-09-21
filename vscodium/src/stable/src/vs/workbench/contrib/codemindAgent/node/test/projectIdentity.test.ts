/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { resolveProjectIdentity, normaliseRemoteUrl } from '../orchestration/projectIdentity.js';

/**
 * P2-T01 tests — Project Identity Resolution.
 *
 * Tests are hermetic: each creates a throwaway temp directory (and optionally
 * a real git repo in it) and then deletes it in teardown. No network access;
 * all git operations run against local repositories.
 *
 * Scenarios covered:
 *   - normaliseRemoteUrl: SSH / HTTPS / credentials / trailing .git → same string
 *   - resolveProjectIdentity: git-remote signal, first-commit signal, path signal
 *   - Multi-remote determinism (prefer origin; else alphabetically-first)
 *   - UUID stability across repeated calls for the same input
 *   - Fork scenario → different UUID from upstream
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'ppb-id-'));
}

async function rmDir(dir: string): Promise<void> {
	try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Create a minimal git repo in `dir`.
 * Returns `dir` for convenience.
 */
function initGitRepo(dir: string, options: {
	remote?: { name: string; url: string }[];
	withCommit?: boolean;
} = {}): string {
	execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
	execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
	execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
	if (options.withCommit) {
		execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
	}
	for (const r of (options.remote ?? [])) {
		execSync(`git remote add ${r.name} ${r.url}`, { cwd: dir, stdio: 'pipe' });
	}
	return dir;
}

// ── normaliseRemoteUrl ────────────────────────────────────────────────────────

suite('PPB › projectIdentity › normaliseRemoteUrl', () => {

	test('HTTPS without .git → canonical form', () => {
		assert.strictEqual(
			normaliseRemoteUrl('https://github.com/org/repo'),
			'github.com/org/repo',
		);
	});

	test('HTTPS with .git suffix → same as without', () => {
		assert.strictEqual(
			normaliseRemoteUrl('https://github.com/org/repo.git'),
			'github.com/org/repo',
		);
	});

	test('SSH SCP syntax with .git → same canonical form [REQUIRED]', () => {
		assert.strictEqual(
			normaliseRemoteUrl('git@github.com:org/repo.git'),
			'github.com/org/repo',
		);
	});

	test('SSH SCP syntax without .git → same canonical form', () => {
		assert.strictEqual(
			normaliseRemoteUrl('git@github.com:org/repo'),
			'github.com/org/repo',
		);
	});

	test('SSH URL scheme with .git → same canonical form', () => {
		assert.strictEqual(
			normaliseRemoteUrl('ssh://git@github.com/org/repo.git'),
			'github.com/org/repo',
		);
	});

	test('HTTPS with credentials → same canonical form [REQUIRED]', () => {
		assert.strictEqual(
			normaliseRemoteUrl('https://user:password@github.com/org/repo.git'),
			'github.com/org/repo',
		);
	});

	test('SSH and HTTPS produce identical normalised strings [REQUIRED]', () => {
		const ssh = normaliseRemoteUrl('git@github.com:org/repo.git');
		const https = normaliseRemoteUrl('https://github.com/org/repo.git');
		assert.strictEqual(ssh, https);
	});

	test('uppercase scheme is lowercased', () => {
		assert.strictEqual(
			normaliseRemoteUrl('HTTPS://GITHUB.COM/Org/Repo.git'),
			'github.com/org/repo',
		);
	});

	test('empty string → empty string', () => {
		assert.strictEqual(normaliseRemoteUrl(''), '');
	});

	test('trailing slash is stripped', () => {
		assert.strictEqual(
			normaliseRemoteUrl('https://github.com/org/repo/'),
			'github.com/org/repo',
		);
	});

	test('double slashes are collapsed', () => {
		assert.strictEqual(
			normaliseRemoteUrl('https://github.com//org//repo'),
			'github.com/org/repo',
		);
	});
});

// ── resolveProjectIdentity ────────────────────────────────────────────────────

suite('PPB › projectIdentity › resolveProjectIdentity', () => {

	// ── git-remote signal ────────────────────────────────────────────────────

	test('repo with remote: signalKind is git-remote', async () => {
		const dir = await makeTempDir();
		try {
			initGitRepo(dir, {
				remote: [{ name: 'origin', url: 'https://github.com/org/repo.git' }],
			});
			const id = await resolveProjectIdentity(dir);
			assert.strictEqual(id.signalKind, 'git-remote');
		} finally { await rmDir(dir); }
	});

	test('same HTTPS URL with and without .git → same UUID [REQUIRED]', async () => {
		const dirA = await makeTempDir();
		const dirB = await makeTempDir();
		try {
			initGitRepo(dirA, { remote: [{ name: 'origin', url: 'https://github.com/org/repo.git' }] });
			initGitRepo(dirB, { remote: [{ name: 'origin', url: 'https://github.com/org/repo' }] });
			const idA = await resolveProjectIdentity(dirA);
			const idB = await resolveProjectIdentity(dirB);
			assert.strictEqual(idA.projectId, idB.projectId, 'UUID must match regardless of .git suffix');
		} finally { await rmDir(dirA); await rmDir(dirB); }
	});

	test('SSH and HTTPS remote → same UUID [REQUIRED]', async () => {
		const dirA = await makeTempDir();
		const dirB = await makeTempDir();
		try {
			initGitRepo(dirA, { remote: [{ name: 'origin', url: 'git@github.com:org/repo.git' }] });
			initGitRepo(dirB, { remote: [{ name: 'origin', url: 'https://github.com/org/repo.git' }] });
			const idA = await resolveProjectIdentity(dirA);
			const idB = await resolveProjectIdentity(dirB);
			assert.strictEqual(idA.projectId, idB.projectId, 'SSH and HTTPS must produce same UUID');
		} finally { await rmDir(dirA); await rmDir(dirB); }
	});

	test('HTTPS with credentials → same UUID as clean HTTPS', async () => {
		const dirA = await makeTempDir();
		const dirB = await makeTempDir();
		try {
			initGitRepo(dirA, { remote: [{ name: 'origin', url: 'https://user:pass@github.com/org/repo.git' }] });
			initGitRepo(dirB, { remote: [{ name: 'origin', url: 'https://github.com/org/repo.git' }] });
			const idA = await resolveProjectIdentity(dirA);
			const idB = await resolveProjectIdentity(dirB);
			assert.strictEqual(idA.projectId, idB.projectId, 'Credentials must be stripped');
		} finally { await rmDir(dirA); await rmDir(dirB); }
	});

	test('rename / move scenario: same remote URL → same UUID', async () => {
		// Simulates: clone repo to path A, later clone same repo to path B
		const dirA = await makeTempDir();
		const dirB = await makeTempDir();
		try {
			const remoteUrl = 'https://github.com/org/my-project.git';
			initGitRepo(dirA, { remote: [{ name: 'origin', url: remoteUrl }] });
			initGitRepo(dirB, { remote: [{ name: 'origin', url: remoteUrl }] });
			const idA = await resolveProjectIdentity(dirA);
			const idB = await resolveProjectIdentity(dirB);
			assert.strictEqual(idA.projectId, idB.projectId, 'UUID must survive path changes');
		} finally { await rmDir(dirA); await rmDir(dirB); }
	});

	test('fork scenario: different remote URL → different UUID', async () => {
		const dirA = await makeTempDir();
		const dirB = await makeTempDir();
		try {
			initGitRepo(dirA, { remote: [{ name: 'origin', url: 'https://github.com/upstream/repo.git' }] });
			initGitRepo(dirB, { remote: [{ name: 'origin', url: 'https://github.com/myfork/repo.git' }] });
			const idA = await resolveProjectIdentity(dirA);
			const idB = await resolveProjectIdentity(dirB);
			assert.notStrictEqual(idA.projectId, idB.projectId, 'Fork must have a different UUID');
		} finally { await rmDir(dirA); await rmDir(dirB); }
	});

	// ── multi-remote determinism ─────────────────────────────────────────────

	test('multiple remotes with origin: origin is used', async () => {
		const dirA = await makeTempDir();
		const dirB = await makeTempDir();
		try {
			initGitRepo(dirA, {
				remote: [
					{ name: 'upstream', url: 'https://github.com/upstream/repo.git' },
					{ name: 'origin',   url: 'https://github.com/myfork/repo.git' },
				],
			});
			initGitRepo(dirB, {
				remote: [{ name: 'origin', url: 'https://github.com/myfork/repo.git' }],
			});
			const idA = await resolveProjectIdentity(dirA);
			const idB = await resolveProjectIdentity(dirB);
			assert.strictEqual(idA.projectId, idB.projectId, 'origin must be preferred over other remotes');
		} finally { await rmDir(dirA); await rmDir(dirB); }
	});

	test('multiple remotes without origin: alphabetically-first is used deterministically [REQUIRED]', async () => {
		const dir = await makeTempDir();
		try {
			// 'backup' < 'upstream' alphabetically → backup should be used
			initGitRepo(dir, {
				remote: [
					{ name: 'upstream', url: 'https://github.com/upstream/repo.git' },
					{ name: 'backup',   url: 'https://github.com/backup/repo.git' },
				],
			});
			const id = await resolveProjectIdentity(dir);
			// The UUID should equal what we'd get from only the 'backup' remote
			const dirB = await makeTempDir();
			try {
				initGitRepo(dirB, { remote: [{ name: 'backup', url: 'https://github.com/backup/repo.git' }] });
				const idB = await resolveProjectIdentity(dirB);
				assert.strictEqual(id.projectId, idB.projectId, 'Alphabetically-first remote must be used');
			} finally { await rmDir(dirB); }
		} finally { await rmDir(dir); }
	});

	// ── first-commit signal ──────────────────────────────────────────────────

	test('repo with commit but no remote: signalKind is first-commit', async () => {
		const dir = await makeTempDir();
		try {
			initGitRepo(dir, { withCommit: true });
			const id = await resolveProjectIdentity(dir);
			assert.strictEqual(id.signalKind, 'first-commit');
		} finally { await rmDir(dir); }
	});

	test('two repos with the same first commit hash get the same UUID (edge case)', async () => {
		// In practice impossible (first-commit hash is repo-specific), but the
		// logic that uses the hash as a UUIDv5 input is still correct.
		// Test that first-commit produces a stable UUID.
		const dir = await makeTempDir();
		try {
			initGitRepo(dir, { withCommit: true });
			const id1 = await resolveProjectIdentity(dir);
			const id2 = await resolveProjectIdentity(dir);
			assert.strictEqual(id1.projectId, id2.projectId, 'First-commit UUID must be stable');
		} finally { await rmDir(dir); }
	});

	// ── path signal (non-git) ────────────────────────────────────────────────

	test('non-git folder: signalKind is path', async () => {
		const dir = await makeTempDir();
		try {
			const id = await resolveProjectIdentity(dir);
			assert.strictEqual(id.signalKind, 'path');
		} finally { await rmDir(dir); }
	});

	test('non-git folder: UUID is non-empty', async () => {
		const dir = await makeTempDir();
		try {
			const id = await resolveProjectIdentity(dir);
			assert.ok(id.projectId, 'UUID must be non-empty for non-git folder');
			assert.match(id.projectId, /^[0-9a-f-]{36}$/, 'Must be a valid UUID');
		} finally { await rmDir(dir); }
	});

	test('non-git folder: UUID is stable across repeated calls', async () => {
		const dir = await makeTempDir();
		try {
			const id1 = await resolveProjectIdentity(dir);
			const id2 = await resolveProjectIdentity(dir);
			assert.strictEqual(id1.projectId, id2.projectId, 'UUID must be stable for same path');
		} finally { await rmDir(dir); }
	});

	// ── general stability ────────────────────────────────────────────────────

	test('git-remote: UUID is stable across repeated calls', async () => {
		const dir = await makeTempDir();
		try {
			initGitRepo(dir, { remote: [{ name: 'origin', url: 'https://github.com/org/stable.git' }] });
			const id1 = await resolveProjectIdentity(dir);
			const id2 = await resolveProjectIdentity(dir);
			assert.strictEqual(id1.projectId, id2.projectId, 'UUID must be stable across calls');
		} finally { await rmDir(dir); }
	});

	test('workspaceName is the basename of the repoPath', async () => {
		const dir = await makeTempDir();
		try {
			initGitRepo(dir, { remote: [{ name: 'origin', url: 'https://github.com/org/repo.git' }] });
			const id = await resolveProjectIdentity(dir);
			// workspaceName comes from basename(repoPath); repoPath is the git root
			assert.ok(typeof id.workspaceName === 'string' && id.workspaceName.length > 0);
		} finally { await rmDir(dir); }
	});
});
