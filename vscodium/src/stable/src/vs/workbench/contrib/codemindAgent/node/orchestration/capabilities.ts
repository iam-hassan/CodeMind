/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Capability, DeveloperIntent, IntentClassification, SelectionContext } from './types.js';

/**
 * Capability taxonomy + intent→capability resolution (Phase-2 re-evaluation).
 *
 * This module is the ONLY place developer-intent semantics influence which tools
 * run. It produces an ORDERED list of the capabilities an intent needs; the
 * selector (toolSelector.ts) then resolves each capability to whatever adapter
 * advertises it. There is deliberately no adapter-id switch anywhere in the
 * selection path — adding a new adapter that advertises, say, `web_search` makes
 * it eligible for every web-search-needing intent with no code change here.
 */

/** Every capability the taxonomy defines (stable order, for docs/tests). */
export const ALL_CAPABILITIES: readonly Capability[] = [
    'project_memory', 'architecture_history', 'decision_history',
    'repository_context', 'project_structure', 'dependency_context',
    'current_file_context', 'git_context', 'git_operations',
    'terminal_execution', 'testing', 'web_search', 'external_information',
];

/**
 * Canonical capability advertisement per real adapter id. The REAL adapters
 * import their row from here and declare it on themselves, and the test fakes
 * reuse it, so capability-based selection behaves identically against fake and
 * real registries. This is a documentation/DRY aid — the selector still reads
 * `adapter.capabilities`, never this map.
 */
export const CANONICAL_ADAPTER_CAPABILITIES: Readonly<Record<string, Capability[]>> = {
    projectBrainAdapter: ['project_memory', 'architecture_history', 'decision_history'],
    repositoryAdapter: ['repository_context', 'project_structure'],
    dependencyAdapter: ['dependency_context'],
    fileContextAdapter: ['current_file_context'],
    gitAdapter: ['git_context', 'git_operations'],
    terminalAdapter: ['terminal_execution', 'testing'],
    webSearchAdapter: ['web_search', 'external_information'],
};

function sig(intent: IntentClassification, re: RegExp): boolean {
    return intent.signals.some(s => re.test(s));
}

/**
 * Ordered list of capabilities an intent needs GIVEN its signals + selection
 * context. Order is significant: it fixes the order selected adapters appear in.
 * The context/signal augmentation here mirrors, one-for-one, what a developer
 * would reason about ("a code-gen prompt that mentions a package also needs
 * dependency context") — it is NOT a fixed per-intent tool list.
 */
export function resolveRequiredCapabilities(
    intent: IntentClassification,
    context: SelectionContext,
): Capability[] {
    const caps: Capability[] = [];
    switch (intent.intent) {
        case DeveloperIntent.MEMORY_RETRIEVAL:
            caps.push('project_memory');
            break;
        case DeveloperIntent.CODE_GENERATION:
            if (intent.confidence >= 0.7) {
                caps.push('project_memory', 'repository_context', 'current_file_context');
                if (sig(intent, /depend|package|npm|yarn|library/i)) { caps.push('dependency_context'); }
            } else {
                caps.push('project_memory');
            }
            break;
        case DeveloperIntent.ARCHITECTURE:
            caps.push('project_memory', 'repository_context');
            if (context.isFollowUp) { caps.push('current_file_context'); }
            break;
        case DeveloperIntent.WEB_SEARCH:
            caps.push('web_search');
            if (sig(intent, /project|our|we|codebase/i)) { caps.push('project_memory'); }
            break;
        case DeveloperIntent.GIT_OPERATIONS:
            caps.push('git_operations');
            if (sig(intent, /commit message|PR|pull request/i)) { caps.push('current_file_context'); }
            break;
        case DeveloperIntent.TERMINAL_EXECUTION:
            caps.push('terminal_execution');
            break;
        case DeveloperIntent.DEBUGGING:
            caps.push('current_file_context', 'repository_context');
            if (sig(intent, /\btest\b/i)) { caps.push('testing'); }
            if (sig(intent, /depend|package|library/i)) { caps.push('dependency_context'); }
            break;
        case DeveloperIntent.CODE_REVIEW:
            caps.push('current_file_context', 'repository_context');
            if (sig(intent, /latest|best practice|modern/i)) { caps.push('web_search'); }
            break;
        case DeveloperIntent.TESTING:
            caps.push('current_file_context', 'dependency_context', 'testing');
            break;
        case DeveloperIntent.PROJECT_ANALYSIS:
            caps.push('repository_context', 'git_context', 'dependency_context', 'project_memory');
            break;
        case DeveloperIntent.MULTI_TOOL_WORKFLOW:
            caps.push('project_memory', 'repository_context', 'current_file_context', 'web_search');
            break;
        case DeveloperIntent.DOCUMENTATION:
        default:
            caps.push('project_memory', 'current_file_context');
            break;
    }
    // De-dupe while preserving first-seen order.
    return caps.filter((c, i) => caps.indexOf(c) === i);
}

/**
 * Context-free base capabilities for an intent — the set the classifier records
 * on `IntentClassification.requiredCapabilities` for the trace, before selection
 * context (open files, follow-up) is known. Uses a neutral high-confidence,
 * no-signal, not-a-follow-up context so it reflects the intent alone.
 */
export function baseCapabilitiesForIntent(intent: DeveloperIntent): Capability[] {
    return resolveRequiredCapabilities(
        { intent, confidence: 1, signals: [] },
        { hasOpenFiles: false, workspaceFolder: '', promptLength: 0, hasImageAttachments: false, isFollowUp: false },
    );
}

