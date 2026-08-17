/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createConnection } from 'net';
import { join } from 'path';
import { ToolAdapter, OrchestrationRequest, ToolOutput, IntentClassification, SelectionContext, DeveloperIntent } from '../types.js';

/**
 * terminalAdapter (Section 8.7)
 * Reads shell environment + checks for common dev-server ports.
 * Does NOT execute commands proactively.
 */

function checkPort(port: number, timeoutMs = 100): Promise<boolean> {
    return new Promise(resolve => {
        const socket = createConnection({ port, host: '127.0.0.1' });
        const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
        socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
        socket.on('error', () => { clearTimeout(timer); resolve(false); });
    });
}

export const terminalAdapter: ToolAdapter = {
    id: 'terminalAdapter',
    name: 'Terminal',
    TIMEOUT_MS: 300,
    async execute(request: OrchestrationRequest): Promise<ToolOutput> {
        const start = Date.now();
        const cwd = request.workspaceFolder;
        const shell = process.env.SHELL || process.env.ComSpec || 'unknown';

        // Check common dev ports
        const ports = [3000, 8080, 5173, 4200];
        const running = await Promise.all(ports.map(p => checkPort(p)));
        const devServerRunning = running.some(Boolean);

        // Try to read package.json scripts (best-effort)
        let scripts: string[] = [];
        try {
            const pkg = await import('fs/promises').then(fs => fs.readFile(join(cwd, 'package.json'), 'utf8'));
            const parsed = JSON.parse(pkg);
            scripts = Object.keys(parsed.scripts || {});
        } catch { /* ignore */ }

        return {
            adapterId: 'terminalAdapter',
            status: 'success',
            durationMs: Date.now() - start,
            outputSummary: `shell:${shell.split(/[\\/]/).pop()} dev:${devServerRunning}`,
            outputTokenEstimate: 20,
            terminalContext: {
                cwd,
                shell,
                devServerRunning,
                availableScripts: scripts,
            },
        };
    },
    shouldRun(intent: IntentClassification, _context: SelectionContext): boolean {
        return intent.intent === DeveloperIntent.TERMINAL_EXECUTION ||
               intent.intent === DeveloperIntent.DEBUGGING ||
               intent.intent === DeveloperIntent.TESTING;
    },
};
