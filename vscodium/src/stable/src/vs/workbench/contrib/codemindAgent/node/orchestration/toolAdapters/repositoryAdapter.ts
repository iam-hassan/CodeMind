/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { ToolAdapter, OrchestrationRequest, ToolOutput, IntentClassification, SelectionContext } from '../types.js';

/**
 * repositoryAdapter (Section 8.2)
 * Collects file paths (not full content) for context.
 * Uses Node fs/promises + simple glob patterns. Max 50 paths.
 */

const INTERESTING_DIRS = ['auth', 'api', 'lib', 'utils', 'services', 'components', 'hooks', 'store', 'routes'];

async function safeReaddir(dir: string): Promise<string[]> {
    try {
        return await readdir(dir);
    } catch {
        return [];
    }
}

async function isDir(p: string): Promise<boolean> {
    try {
        const s = await stat(p);
        return s.isDirectory();
    } catch {
        return false;
    }
}

export const repositoryAdapter: ToolAdapter = {
    id: 'repositoryAdapter',
    name: 'Repository',
    TIMEOUT_MS: 600,
    async execute(request: OrchestrationRequest): Promise<ToolOutput> {
        const start = Date.now();
        const cwd = request.workspaceFolder;
        const openFile = request.openFiles[0] || '';
        const openDir = openFile ? openFile.split(/[\\/]/).slice(0, -1).join('/') : cwd;

        const paths: string[] = [];

        // 1. Open file's own directory
        const siblings = await safeReaddir(openDir);
        for (const f of siblings.slice(0, 20)) {
            const full = join(openDir, f);
            if (!(await isDir(full)) && !f.startsWith('.')) paths.push(full);
        }

        // 2. Interesting directories anywhere under cwd (one level deep)
        const topLevel = await safeReaddir(cwd);
        for (const dir of topLevel) {
            if (INTERESTING_DIRS.includes(dir.toLowerCase())) {
                const sub = await safeReaddir(join(cwd, dir));
                for (const f of sub.slice(0, 8)) {
                    const full = join(cwd, dir, f);
                    if (!(await isDir(full))) paths.push(full);
                }
            }
        }

        // 3. Project entry points (names only)
        const entryPoints = ['index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js', 'package.json']
            .map(e => join(cwd, e))
            .filter(async (p) => { try { await stat(p); return true; } catch { return false; } });

        const finalPaths = [...new Set([...paths, ...entryPoints])].slice(0, 50);

        return {
            adapterId: 'repositoryAdapter',
            status: 'success',
            durationMs: Date.now() - start,
            outputSummary: `open:${openFile.split(/[\\/]/).pop() || 'none'} related:${finalPaths.length}`,
            outputTokenEstimate: 60,
            repository: {
                openFile,
                relatedFiles: finalPaths,
                projectEntryPoints: entryPoints.map(p => p.split(/[\\/]/).pop()!),
            },
        };
    },
    shouldRun(_intent: IntentClassification, _context: SelectionContext): boolean {
        return true;
    },
};
