/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'fs/promises';
import { extname } from 'path';
import { ToolAdapter, OrchestrationRequest, ToolOutput, IntentClassification, SelectionContext, FileContext } from '../types.js';

/**
 * fileContextAdapter (Section 8.3)
 * Reads currently open files (from request.openFiles) with 200-line trimming.
 */

function trimFile(content: string, maxLines = 200): { content: string; trimmed: boolean } {
    const lines = content.split('\n');
    if (lines.length <= maxLines) return { content, trimmed: false };
    const head = lines.slice(0, 100).join('\n');
    const tail = lines.slice(-50).join('\n');
    return {
        content: head + `\n\n[... ${lines.length - 150} lines omitted ...]\n\n` + tail,
        trimmed: true,
    };
}

function detectLanguage(path: string): string {
    const ext = extname(path).toLowerCase();
    const map: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescriptreact',
        '.js': 'javascript', '.jsx': 'javascriptreact',
        '.py': 'python', '.go': 'go', '.rs': 'rust',
        '.java': 'java', '.cpp': 'cpp', '.c': 'c',
        '.md': 'markdown', '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml',
    };
    return map[ext] || 'text';
}

export const fileContextAdapter: ToolAdapter = {
    id: 'fileContextAdapter',
    name: 'File Context',
    TIMEOUT_MS: 400,
    async execute(request: OrchestrationRequest): Promise<ToolOutput> {
        const start = Date.now();
        const files: FileContext[] = [];

        for (const path of request.openFiles.slice(0, 5)) {
            try {
                const raw = await readFile(path, 'utf8');
                const { content, trimmed } = trimFile(raw);
                files.push({
                    path,
                    language: detectLanguage(path),
                    content,
                    trimmed,
                });
            } catch {
                // skip unreadable files
            }
        }

        return {
            adapterId: 'fileContextAdapter',
            status: 'success',
            durationMs: Date.now() - start,
            outputSummary: `files:${files.length}`,
            outputTokenEstimate: files.reduce((sum, f) => sum + Math.floor(f.content.length / 4), 0),
            currentFiles: files,
        };
    },
    shouldRun(_intent: IntentClassification, _context: SelectionContext): boolean {
        return _context.hasOpenFiles;
    },
};
