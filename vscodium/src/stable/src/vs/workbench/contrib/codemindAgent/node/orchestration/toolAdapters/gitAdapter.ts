/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promisify } from 'util';
import { ToolAdapter, OrchestrationRequest, ToolOutput, IntentClassification, SelectionContext } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * gitAdapter (Section 8.5)
 * Runs git commands via execFile (never exec). 3000ms timeout per command.
 */
export const gitAdapter: ToolAdapter = {
    id: 'gitAdapter',
    name: 'Git',
    TIMEOUT_MS: 3000,
    async execute(request: OrchestrationRequest): Promise<ToolOutput> {
        const cwd = request.workspaceFolder;
        const start = Date.now();
        try {
            const [branch, log, diff, status] = await Promise.allSettled([
                execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 2000 }),
                execFileAsync('git', ['log', '--oneline', '-5'], { cwd, timeout: 2000 }),
                execFileAsync('git', ['diff', '--stat', 'HEAD'], { cwd, timeout: 2000 }),
                execFileAsync('git', ['status', '--short'], { cwd, timeout: 2000 }),
            ]);

            const branchName = branch.status === 'fulfilled' ? branch.value.stdout.trim() : undefined;
            const commits = log.status === 'fulfilled' ? log.value.stdout.trim().split('\n').filter(Boolean) : undefined;
            const modified = diff.status === 'fulfilled' ? diff.value.stdout.trim().split('\n').filter(Boolean) : undefined;
            const stat = status.status === 'fulfilled' ? status.value.stdout.trim() : undefined;

            return {
                adapterId: 'gitAdapter',
                status: 'success',
                durationMs: Date.now() - start,
                outputSummary: `branch:${branchName ?? 'unknown'} commits:${commits?.length ?? 0}`,
                outputTokenEstimate: 80,
                gitState: {
                    available: true,
                    branch: branchName,
                    recentCommits: commits,
                    modifiedFiles: modified,
                    status: stat,
                },
            };
        } catch {
            return {
                adapterId: 'gitAdapter',
                status: 'error',
                durationMs: Date.now() - start,
                outputSummary: 'git not available or not a repo',
                outputTokenEstimate: 10,
                gitState: { available: false },
            };
        }
    },
    shouldRun(_intent: IntentClassification, _context: SelectionContext): boolean {
        return true;
    },
};
