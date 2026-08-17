/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'fs/promises';
import { join } from 'path';
import { ToolAdapter, OrchestrationRequest, ToolOutput, IntentClassification, SelectionContext, DeveloperIntent } from '../types.js';

/**
 * dependencyAdapter (Section 8.4)
 * Reads package.json (or equivalent) and filters by intent signals when possible.
 */

export const dependencyAdapter: ToolAdapter = {
    id: 'dependencyAdapter',
    name: 'Dependencies',
    TIMEOUT_MS: 300,
    async execute(request: OrchestrationRequest): Promise<ToolOutput> {
        const start = Date.now();
        const cwd = request.workspaceFolder;
        const pkgPath = join(cwd, 'package.json');

        try {
            const raw = await readFile(pkgPath, 'utf8');
            const pkg = JSON.parse(raw);
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            const entries = Object.entries(deps).map(([name, version]) => ({ name, version: String(version) }));

            // Filter by intent signals if present
            const signals = request.userPrompt.toLowerCase();
            const filtered = signals
                ? entries.filter(e => signals.includes(e.name.toLowerCase().split('/').pop()!))
                : entries;

            const final = (filtered.length ? filtered : entries).slice(0, 30);

            return {
                adapterId: 'dependencyAdapter',
                status: 'success',
                durationMs: Date.now() - start,
                outputSummary: `packages:${final.length}`,
                outputTokenEstimate: 40,
                dependencies: {
                    projectType: 'node',
                    packages: final,
                },
            };
        } catch {
            return {
                adapterId: 'dependencyAdapter',
                status: 'success',
                durationMs: Date.now() - start,
                outputSummary: 'no package.json or non-Node project',
                outputTokenEstimate: 5,
                dependencies: { projectType: 'unknown', packages: [] },
            };
        }
    },
    shouldRun(intent: IntentClassification, context: SelectionContext): boolean {
        return intent.intent === DeveloperIntent.CODE_GENERATION ||
               intent.intent === DeveloperIntent.DEBUGGING ||
               intent.intent === DeveloperIntent.TESTING ||
               intent.intent === DeveloperIntent.PROJECT_ANALYSIS;
    },
};
