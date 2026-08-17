/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ToolAdapter, OrchestrationRequest, ToolOutput, IntentClassification, SelectionContext, DeveloperIntent } from '../types.js';

/**
 * webSearchAdapter (Section 8.6)
 * Does NOT call an external search API. Instead it injects a directive that tells
 * the Claude Agent SDK's own WebSearchTool to run. This matches the spec exactly.
 */

function extractSearchTerms(prompt: string): string {
    const stop = new Set(['the', 'a', 'an', 'is', 'are', 'what', 'how', 'why', 'when', 'where', 'for', 'of', 'to', 'in', 'on', 'and', 'or']);
    const words = prompt.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stop.has(w));
    return words.slice(0, 5).join(' ');
}

export const webSearchAdapter: ToolAdapter = {
    id: 'webSearchAdapter',
    name: 'Web Search',
    TIMEOUT_MS: 100,
    async execute(request: OrchestrationRequest): Promise<ToolOutput> {
        const terms = extractSearchTerms(request.userPrompt);
        const directive = terms ? `[Search: ${terms}]` : '[Search: latest information]';

        return {
            adapterId: 'webSearchAdapter',
            status: 'success',
            durationMs: 0,
            outputSummary: `directive:${directive}`,
            outputTokenEstimate: 8,
            webResults: [{ injectedDirective: directive }],
        };
    },
    shouldRun(intent: IntentClassification, _context: SelectionContext): boolean {
        return intent.intent === DeveloperIntent.WEB_SEARCH ||
               intent.intent === DeveloperIntent.CODE_REVIEW; // best-practice searches
    },
};
