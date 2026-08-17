/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { DeveloperIntent, IntentClassification, SelectionContext, ToolAdapter, ToolAdapterRegistry } from './types.js';

/**
 * Tool Selection Engine (Section 3)
 * Dynamic selection based on intent + context. No intent has a hardcoded fixed set.
 */

export function selectTools(
    intent: IntentClassification,
    context: SelectionContext,
    registry: ToolAdapterRegistry
): ToolAdapter[] {
    const selected: ToolAdapter[] = [];
    const add = (id: string) => {
        const adapter = registry.get(id);
        if (adapter && adapter.shouldRun(intent, context)) {
            selected.push(adapter);
        }
    };

    switch (intent.intent) {
        case DeveloperIntent.MEMORY_RETRIEVAL:
            add('projectBrainAdapter');
            // Never webSearch or repository for pure memory questions
            break;

        case DeveloperIntent.CODE_GENERATION:
            if (intent.confidence >= 0.7) {
                add('projectBrainAdapter');
                add('repositoryAdapter');
                add('fileContextAdapter');
                if (intent.signals.some(s => /depend|package|npm|yarn|library/i.test(s))) {
                    add('dependencyAdapter');
                }
            } else {
                // Low confidence — minimal context
                add('projectBrainAdapter');
            }
            break;

        case DeveloperIntent.ARCHITECTURE:
            add('projectBrainAdapter');
            add('repositoryAdapter');
            if (context.isFollowUp) add('fileContextAdapter');
            break;

        case DeveloperIntent.WEB_SEARCH:
            add('webSearchAdapter');
            if (intent.signals.some(s => /project|our|we|codebase/i.test(s))) {
                add('projectBrainAdapter');
            }
            break;

        case DeveloperIntent.GIT_OPERATIONS:
            add('gitAdapter');
            if (intent.signals.some(s => /commit message|PR|pull request/i.test(s))) {
                add('fileContextAdapter');
            }
            break;

        case DeveloperIntent.TERMINAL_EXECUTION:
            add('terminalAdapter');
            // No other adapters — terminal commands need minimal context
            break;

        case DeveloperIntent.DEBUGGING:
            add('fileContextAdapter');
            add('repositoryAdapter');
            if (intent.signals.some(s => /\btest\b/i.test(s))) add('terminalAdapter');
            if (intent.signals.some(s => /depend|package|library/i.test(s))) add('dependencyAdapter');
            break;

        case DeveloperIntent.CODE_REVIEW:
            add('fileContextAdapter');
            add('repositoryAdapter');
            if (intent.signals.some(s => /latest|best practice|modern/i.test(s))) add('webSearchAdapter');
            break;

        case DeveloperIntent.TESTING:
            add('fileContextAdapter');
            add('dependencyAdapter');
            add('terminalAdapter');
            break;

        case DeveloperIntent.PROJECT_ANALYSIS:
            add('repositoryAdapter');
            add('gitAdapter');
            add('dependencyAdapter');
            add('projectBrainAdapter');
            break;

        case DeveloperIntent.MULTI_TOOL_WORKFLOW:
            // Union of tools from top two intents (caller already detected this)
            // For simplicity we re-run selection with the two strongest signals
            // In practice the orchestrator can call selectTools twice and merge.
            // Here we just add the most common useful set.
            add('projectBrainAdapter');
            add('repositoryAdapter');
            add('fileContextAdapter');
            add('webSearchAdapter');
            break;

        default:
            // Fallback: safe minimal set
            add('projectBrainAdapter');
            add('fileContextAdapter');
    }

    // Deduplicate while preserving order
    const seen = new Set<string>();
    return selected.filter(a => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
    });
}
