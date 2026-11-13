/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project identity §1 edge matrix (P2-T01).
 *
 * The full set of identity rows the spec pins down:
 *  - the same repository at a different path → same projectId;
 *  - a renamed workspace folder → same projectId;
 *  - two unrelated workspaces that share a folder name → different projectIds;
 *  - no git repository → realpath identity;
 *  - a repository with zero commits → falls back without guessing;
 *  - a monorepo subfolder → the repository root's identity;
 *  - a symlinked/junction workspace → the target's identity.
 *
 * These use real throwaway git repositories under the OS temp directory (the resolver shells out
 * to git), and every directory is removed in `finally`. No Docker, no network, no model.
 */

import assert from 'assert';
import { mkdirSync } from 'fs';
import { cp, mkdir, mkdtemp, realpath, rename, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { resolveProjectIdentity } from '../../orchestration/projectIdentity.js';

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'ppb-id-edges-'));
}

async function rmDir(dir: string): Promise<void> {
	try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Minimal git repo (with an optional commit and optional remotes). */
function initGitRepo(dir: string, options: { remote?: string; withCommit?: boolean } = {}): string {
	// `git init` needs an existing working directory (its cwd), so create it first.
	mkdirSync(dir, { recursive: true });
	const run = (command: string) => execSync(command, { cwd: dir, stdio: 'pipe', timeout: 30_000 });
	run('git init -b main');
	run('git config user.email "test@test.com"');
	run('git config user.name "Test"');
	if (options.withCommit) {
		// `-c commit.gpgsign=false` matters on machines that globally enable commit signing:
		// without it git opens a pinentry prompt and the test blocks forever.
		run('git -c commit.gpgsign=false commit --allow-empty --no-verify -m "init"');
	}
	if (options.remote) {
		run(`git remote add origin ${options.remote}`);
	}
	return dir;
}

const REMOTE = 'https://github.com/org/edge-matrix.git';

suite('PPB project identity §1 edge matrix (P2-T01)', function () {
	// Real git repositories (init + commit + copy) are slower than the 2s default.
	this.timeout(15_000);

	test('the same repository at a different path keeps one identity', async () => {
		const root = await makeTempDir();
		const copy = join(root, 'relocated');
		try {
			const original = initGitRepo(join(root, 'original'), { remote: REMOTE, withCommit: true });
			await cp(original, copy, { recursive: true });

			const a = await resolveProjectIdentity(original);
			const b = await resolveProjectIdentity(copy);

			assert.strictEqual(a.signalKind, 'git-remote');
			assert.strictEqual(b.signalKind, 'git-remote');
			assert.strictEqual(a.projectId, b.projectId, 'path is not part of the identity');
			assert.notStrictEqual(a.repoPath, b.repoPath, 'the two checkouts really are different paths');
		} finally { await rmDir(root); }
	});

	test('a renamed workspace folder keeps its identity and adopts the new name', async () => {
		const root = await makeTempDir();
		try {
			const before = initGitRepo(join(root, 'before-name'), { remote: REMOTE, withCommit: true });
			const after = join(root, 'after-name');

			// Identity is captured before the move: the point is that the *same* workspace keeps
			// its id once the folder is renamed (a path-based identity would silently fork).
			const a = await resolveProjectIdentity(before);
			await rename(before, after);
			const b = await resolveProjectIdentity(after);

			assert.strictEqual(a.projectId, b.projectId, 'a rename must not fork the brain');
			assert.strictEqual(b.workspaceName, basename(after), 'the display name follows the folder');
		} finally { await rmDir(root); }
 	});

	test('two workspaces sharing a folder name get different identities', async () => {
		const root = await makeTempDir();
		try {
			// Same basename, unrelated locations, neither is a git repo → distinct realpaths.
			const apiA = join(root, 'team-a', 'api');
			const apiB = join(root, 'team-b', 'api');
			await mkdir(apiA, { recursive: true });
			await mkdir(apiB, { recursive: true });

			const a = await resolveProjectIdentity(apiA);
			const b = await resolveProjectIdentity(apiB);

			assert.strictEqual(a.workspaceName, 'api');
			assert.strictEqual(b.workspaceName, 'api');
			assert.strictEqual(a.signalKind, 'path');
			assert.strictEqual(b.signalKind, 'path');
			assert.notStrictEqual(a.projectId, b.projectId, 'a folder-name collision must not share a brain');
		} finally { await rmDir(root); }
	});

	test('a folder outside git is identified by its real path, stably', async () => {
		const dir = await makeTempDir();
		try {
			const first = await resolveProjectIdentity(dir);
			const second = await resolveProjectIdentity(dir);

			assert.strictEqual(first.signalKind, 'path');
			assert.strictEqual(first.projectId, second.projectId);
			assert.strictEqual(first.repoPath, await realpath(dir));
			assert.match(first.projectId, /^[0-9a-f-]{36}$/);
		} finally { await rmDir(dir); }
	});

	test('a repository with zero commits but a remote is still identified by the remote', async () => {
		const dir = await makeTempDir();
		try {
			initGitRepo(dir, { remote: REMOTE, withCommit: false });
			const id = await resolveProjectIdentity(dir);

			assert.strictEqual(id.signalKind, 'git-remote', 'the remote signal does not need a commit');
			assert.strictEqual(id.gitHeadSha, undefined, 'no HEAD sha exists yet');
			assert.strictEqual(id.projectId, (await resolveProjectIdentity(dir)).projectId);
		} finally { await rmDir(dir); }
	});

	test('a repository with zero commits and no remote degrades to its path', async () => {
		const dir = await makeTempDir();
		try {
			initGitRepo(dir, { withCommit: false });
			const id = await resolveProjectIdentity(dir);

			// No remote and no root commit → nothing to hash but the real path. The resolver must
			// never invent an identity (e.g. from an empty hash).
			assert.strictEqual(id.signalKind, 'path');
			assert.ok(id.primarySignal.length > 0, 'a signal is always present');
			assert.strictEqual(id.projectId, (await resolveProjectIdentity(dir)).projectId, 'and it is stable');
		} finally { await rmDir(dir); }
	});

	test('a monorepo subfolder resolves to the repository root identity', async () => {
		const dir = await makeTempDir();
		try {
			initGitRepo(dir, { remote: REMOTE, withCommit: true });
			const subfolder = join(dir, 'packages', 'web-client');
			await mkdir(subfolder, { recursive: true });

			const root = await resolveProjectIdentity(dir);
			const nested = await resolveProjectIdentity(subfolder);

			assert.strictEqual(nested.projectId, root.projectId, 'sub-packages share the repository brain');
			assert.strictEqual(nested.repoPath, root.repoPath, 'repoPath is the git top level, not the cwd');
			assert.strictEqual(nested.workspaceName, root.workspaceName);
		} finally { await rmDir(dir); }
 	});

	test('a symlinked/junction workspace resolves to the target identity', async function () {
		const root = await makeTempDir();
		const target = join(root, 'actual');
		const link = join(root, 'linked');
		try {
			initGitRepo(target, { remote: REMOTE, withCommit: true });
			try {
				// A directory junction works on Windows without elevation; on POSIX this is a
				// normal symlink. Either way `realpath` must collapse it to the target.
				await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
			} catch {
				this.skip(); // the environment disallows links (restricted Windows policy)
			}

			const direct = await resolveProjectIdentity(target);
			const throughLink = await resolveProjectIdentity(link);

			assert.strictEqual(throughLink.projectId, direct.projectId, 'a link is the same workspace');
			assert.strictEqual(throughLink.repoPath, direct.repoPath);
		} finally { await rmDir(root); }
	});
});
