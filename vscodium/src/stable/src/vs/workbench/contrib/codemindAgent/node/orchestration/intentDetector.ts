/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { DeveloperIntent, IntentClassification } from './types.js';

/**
 * Intent Detection Engine (Section 2)
 * Rule-based weighted keyword classifier. Must be < 50ms. No LLM calls.
 */

// Signal patterns with weights (positive = match boosts score)
interface SignalPattern {
    pattern: RegExp;
    weight: number;
}

const INTENT_SIGNALS: Record<DeveloperIntent, SignalPattern[]> = {
    [DeveloperIntent.CODE_GENERATION]: [
        { pattern: /^(implement|build|create|write a|add a|generate|make a|set up|integrate|develop)/i, weight: 3.0 },
        { pattern: /\b(implement|build|create|write|add|generate|make)\b/i, weight: 1.5 },
        { pattern: /\b(function|class|component|hook|service|controller|api|endpoint)\b/i, weight: 1.0 },
    ],
    [DeveloperIntent.MEMORY_RETRIEVAL]: [
        { pattern: /^(what|which|when|why|how|remind me)/i, weight: 2.0 },
        { pattern: /\b(what (database|framework|library|are we using|did we decide|is our)|which library|remind me|what was the reason)\b/i, weight: 3.0 },
        { pattern: /\b(our|we|the project|previously|earlier|last time)\b/i, weight: 1.0 },
    ],
    [DeveloperIntent.ARCHITECTURE]: [
        { pattern: /\b(architecture|design|structure|how (is|should) .* organized|folder layout|module structure)\b/i, weight: 3.0 },
        { pattern: /\b(high-level|overview|big picture|system design)\b/i, weight: 2.0 },
    ],
    [DeveloperIntent.WEB_SEARCH]: [
        { pattern: /^(search for|look up|find the latest|what is the current|fetch|get information about)/i, weight: 3.0 },
        { pattern: /\b(pricing|latest|current version|support|docs?|documentation|release notes)\b/i, weight: 2.0 },
    ],
    [DeveloperIntent.GIT_OPERATIONS]: [
        { pattern: /^(commit|push|pull|branch|merge|rebase|stash|git)/i, weight: 3.0 },
        { pattern: /\b(git|commit|branch|merge|rebase|diff|blame|history|PR|pull request)\b/i, weight: 2.0 },
    ],
    [DeveloperIntent.TERMINAL_EXECUTION]: [
        { pattern: /^(!|npm |yarn |bun |pnpm |pip |cargo |test |node |\.\/|bash |sh )/, weight: 4.0 },
        { pattern: /\b(run|execute|npm|yarn|bun|pnpm|pip|cargo|test)\b/i, weight: 2.0 },
        { pattern: /\b(&&|\|\||;)\b/, weight: 1.5 },
    ],
    [DeveloperIntent.DOCUMENTATION]: [
        { pattern: /\b(document|readme|comment|docs?|explain|how (do|does) .* work)\b/i, weight: 2.5 },
        { pattern: /^(document|write (docs|readme|comments?))/i, weight: 3.0 },
    ],
    [DeveloperIntent.DEBUGGING]: [
        { pattern: /^(error|bug|fix|broken|failing|exception|crash|why is|why does|help me understand this error)/i, weight: 3.0 },
        { pattern: /\b(error|bug|fix|broken|failing|exception|crash|stack trace|not working)\b/i, weight: 2.0 },
    ],
    [DeveloperIntent.CODE_REVIEW]: [
        { pattern: /^(review|check|is this correct|any issues|feedback|improve|optimize|refactor)/i, weight: 3.0 },
        { pattern: /\b(review|check|correct|issues?|feedback|improve|optimize|refactor|clean up)\b/i, weight: 2.0 },
    ],
    [DeveloperIntent.TESTING]: [
        { pattern: /^(test|write tests?|add (unit|integration) tests?|coverage)/i, weight: 3.0 },
        { pattern: /\b(test|spec|jest|vitest|mocha|coverage|unit test|integration test)\b/i, weight: 2.0 },
    ],
    [DeveloperIntent.PROJECT_ANALYSIS]: [
        { pattern: /\b(analyze|analysis|stats?|metrics?|dependencies|tech stack|what (tech|stack|frameworks?)|project overview)\b/i, weight: 2.5 },
        { pattern: /^(analyze|summarize|give me an overview of)/i, weight: 3.0 },
    ],
    [DeveloperIntent.MULTI_TOOL_WORKFLOW]: [
        // This is a composite intent detected after scoring — see classifyIntent()
        { pattern: /.*/, weight: 0 }, // placeholder, handled specially
    ],
};

/**
 * Fast path: slash commands and very short prompts.
 */
function fastPathClassify(prompt: string): IntentClassification | null {
    const trimmed = prompt.trim();
    if (trimmed.startsWith('/')) {
        return { intent: DeveloperIntent.TERMINAL_EXECUTION, confidence: 1.0, signals: ['slash_command'] };
    }
    if (trimmed.length < 5) {
        return { intent: DeveloperIntent.CODE_GENERATION, confidence: 0.5, signals: ['short_prompt_fallback'] };
    }
    return null;
}

/**
 * Main intent classifier.
 */
export function classifyIntent(prompt: string): IntentClassification {
    // Fast paths first
    const fast = fastPathClassify(prompt);
    if (fast) return fast;

    const scores = new Map<DeveloperIntent, { score: number; signals: string[] }>();

    // Initialize scores
    for (const intent of Object.values(DeveloperIntent)) {
        scores.set(intent, { score: 0, signals: [] });
    }

    // Score each intent
    for (const [intent, patterns] of Object.entries(INTENT_SIGNALS) as [DeveloperIntent, SignalPattern[]][]) {
        const entry = scores.get(intent)!;
        for (const { pattern, weight } of patterns) {
            const matches = prompt.match(pattern);
            if (matches) {
                entry.score += weight;
                // Record first 40 chars of matched text as signal
                const signal = matches[0].slice(0, 40);
                if (!entry.signals.includes(signal)) entry.signals.push(signal);
            }
        }
    }

    // Find top two intents (for MULTI_TOOL detection)
    const sorted = Array.from(scores.entries()).sort((a, b) => b[1].score - a[1].score);
    const [top, second] = sorted;

    // MULTI_TOOL_WORKFLOW if top two both exceed threshold and are meaningfully different
    if (top[1].score > 2.0 && second[1].score > 1.5 && top[0] !== second[0]) {
        return {
            intent: DeveloperIntent.MULTI_TOOL_WORKFLOW,
            confidence: Math.min(0.95, (top[1].score + second[1].score) / 10),
            signals: [...top[1].signals, ...second[1].signals].slice(0, 8),
        };
    }

    // Otherwise return top intent (or CODE_GENERATION fallback)
    const winner = top[0] === DeveloperIntent.MULTI_TOOL_WORKFLOW ? DeveloperIntent.CODE_GENERATION : top[0];
    const winnerEntry = scores.get(winner)!;

    return {
        intent: winner,
        confidence: Math.min(0.98, Math.max(0.3, winnerEntry.score / 6)),
        signals: winnerEntry.signals.length ? winnerEntry.signals : ['no_strong_signals'],
    };
}

// --- DEBUG SELF-TEST (commented out, enable only during development) ---
// if (process.env.DEBUG_INTENT) {
//   const tests = [
//     'Implement a login screen using Clerk',
//     'What database are we using?',
//     'Search for the latest Next.js pricing',
//     'Run npm test',
//     'Why is my auth failing? Check the error',
//     'Build auth using Clerk and also check latest Clerk pricing',
//   ];
//   for (const t of tests) console.log(t, '→', classifyIntent(t));
// }
