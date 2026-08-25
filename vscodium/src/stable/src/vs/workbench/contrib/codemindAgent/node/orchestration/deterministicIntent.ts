/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CompoundObjective, DeveloperIntent, IntentClassification } from './types.js';

/**
 * Deterministic Stage-1 intent scorer (Phase-2 re-evaluation, Option 1 redesign).
 *
 * ROLE CHANGE: this layer is now a high-speed EVIDENCE / candidate-intent
 * generator, NOT an oracle. It produces weighted-keyword scores per intent plus a
 * clause-level compound analysis; the fusion layer (intentFusion.ts) combines that
 * evidence with the local model probability, the score margin, and semantic
 * consistency to reach the final decision. Nothing here returns a "confidence" —
 * `topScore`/`secondScore` are raw weighted sums (unbounded), never probabilities.
 *
 * The signal patterns are organized as SEMANTIC GROUPS (a strong imperative/lead
 * group, an action-verb group, and a topical-noun group per intent) rather than
 * hundreds of ad-hoc keywords, and were reviewed for the specific gaps the
 * re-evaluation flagged: DEBUGGING ("debug"/"crashes"/"segfault"/"diagnose"),
 * TERMINAL ("start/kill/launch server", "run the migration/seed"), DOCUMENTATION
 * ("docstring"/"usage guide"), ARCHITECTURE ("structured"/"organize"/"module
 * layout"), PROJECT_ANALYSIS ("lines of code"/"footprint"), and the CODE_REVIEW ↔
 * CODE_GENERATION overlap ("make it readable"/"refactor" ⇒ review, not codegen).
 */

interface SignalPattern {
    pattern: RegExp;
    weight: number;
}

const I = DeveloperIntent;

// A polite/interrogative prefix that must not defeat a leading imperative verb.
const LEAD = String.raw`^(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|kindly\s+)?`;

const INTENT_SIGNALS: Partial<Record<DeveloperIntent, SignalPattern[]>> = {
    [I.CODE_GENERATION]: [
        { pattern: new RegExp(LEAD + String.raw`(implement|build|create|write|add|generate|make|set\s?up|integrate|develop|scaffold|wire|update|modify|upgrade)\b`, 'i'), weight: 3.0 },
        { pattern: /\b(implement|build|create|generate|scaffold|integrate|wire\s?up|set\s?up)\b/i, weight: 1.5 },
        { pattern: /\b(function|class|component|hook|service|controller|api|endpoint|form|page|screen|feature|module|handler|interface|toggle|migration|schema)\b/i, weight: 1.0 },
    ],
    [I.MEMORY_RETRIEVAL]: [
        { pattern: /\b(remind me|do you remember|what did we|what was (our|the) (reason|decision|rationale)|which .* did (we|the team)|what .*(are we (using|on|standardi[sz]ed)|did we (decide|choose|pick|settle|agree|drop|standardi[sz]e)))\b/i, weight: 3.0 },
        { pattern: new RegExp(LEAD + String.raw`(what|which|when|why|remind me|do you remember)\b`, 'i'), weight: 1.0 },
        { pattern: /\b(we|our|the team|previously|earlier|last time|again|settled|decided|agreed|chose|picked|standardi[sz]ed)\b/i, weight: 1.0 },
    ],
    [I.ARCHITECTURE]: [
        { pattern: /\b(architecture|system design|folder (layout|structure)|module (layout|structure)|high[- ]level (design|overview)|overall (architecture|design)|big picture)\b/i, weight: 3.0 },
        { pattern: /\bhow (is|are|should) .*(structured|organi[sz]ed?|organi[sz]e|laid out|arranged|set up|talk)\b/i, weight: 3.0 },
        { pattern: /\b(structured|organi[sz]e|organi[sz]ed|lay out|module layout|design the (folder|module|structure|system)|walk me through the (module|design)|describe the (system|design))\b/i, weight: 2.0 },
        { pattern: /\b(structure|design|overview|layout|modules|components)\b/i, weight: 1.0 },
    ],
    [I.WEB_SEARCH]: [
        { pattern: new RegExp(LEAD + String.raw`(search|look up|find|fetch|google)\b`, 'i'), weight: 3.0 },
        { pattern: /\b(search (for|the)|look up|find the (latest|current|newest)|fetch the|get information about)\b/i, weight: 3.0 },
        { pattern: /\b(pricing|latest|current (version|price|documentation|lts)|newest|release notes|changelog|advisor(y|ies)|stable .* release|version of)\b/i, weight: 2.0 },
    ],
    [I.GIT_OPERATIONS]: [
        { pattern: new RegExp(LEAD + String.raw`(commit|push|pull|merge|rebase|stash|cherry[- ]?pick|revert|git)\b`, 'i'), weight: 3.0 },
        { pattern: /\b((what|show) .* changed|changed since|since the (previous|last) commit)\b/i, weight: 3.0 },
        { pattern: /\b(git|commit|push|branch|merge|rebase|diff|origin|upstream|staged?|stash|cherry[- ]?pick|revert|pull request|\bpr\b)\b/i, weight: 2.0 },
    ],
    [I.TERMINAL_EXECUTION]: [
        { pattern: /^\s*(!|npm |yarn |bun |pnpm |pip |cargo |node |\.\/|bash |sh |docker )/i, weight: 4.0 },
        { pattern: /\b(run|execute|start|launch|kill)\b/i, weight: 2.0 },
        { pattern: /\b(dev server|docker|containers?|migration script|seed( command)?|build script|deployment script|deploy|on port|process on port|npm|yarn|pnpm|bun|cargo|pip)\b/i, weight: 2.0 },
    ],
    [I.DOCUMENTATION]: [
        { pattern: new RegExp(LEAD + String.raw`(document|add comments?|add (a |an |inline )?docstrings?|write (docs|documentation|a usage guide|jsdoc))\b`, 'i'), weight: 3.0 },
        { pattern: /\b(document (this|the)|add (jsdoc|inline )?comments?|add (a |an )?docstrings?|write (the )?(docs?|documentation|readme|api documentation|usage guide)|explain how .* works?|update the readme|readme section)\b/i, weight: 3.0 },
        { pattern: /\b(document|documentation|readme|docstrings?|jsdoc|comments?|usage guide|api docs?)\b/i, weight: 2.0 },
    ],
    [I.DEBUGGING]: [
        { pattern: new RegExp(LEAD + String.raw`(why (is|does|am|are|do)|fix|debug|diagnose)\b`, 'i'), weight: 3.0 },
        { pattern: /\b(fix (it|this|the)|debug (it|this|the)|diagnose|track (it )?down|why (is|does|am|are|do) .*(fail|error|crash|500|undefined|broken|wrong|not (work|render)))\b/i, weight: 3.0 },
        { pattern: /\b(bug|crash(es|ing)?|error|exception|segfault|null pointer|stack trace|memory leak|broken|failing|fails|not (working|re-?render(ing)?)|500|cors|undefined)\b/i, weight: 2.0 },
    ],
    [I.CODE_REVIEW]: [
        { pattern: new RegExp(LEAD + String.raw`(review|refactor|optimi[sz]e|improve|simplify|clean up)\b`, 'i'), weight: 3.0 },
        { pattern: /\b(review (this|the)|refactor (this|the)|optimi[sz]e (this|the)|clean up (this|the)|simplify (this|the)|make (this|it) .*(cleaner|readable|simpler)|any issues|feedback on|is this (the )?(right|correct))\b/i, weight: 3.0 },
        { pattern: /\b(review|refactor|optimi[sz]e|simplify|readable|cleaner|clean up|correctness|issues?|feedback|pull request)\b/i, weight: 2.0 },
    ],
    [I.TESTING]: [
        { pattern: /\b(run (the )?tests?|write (unit |integration |e2e |end[- ]to[- ]end |snapshot |regression )?tests?|add (unit |integration |snapshot )?tests?|test coverage|increase .* coverage|cover .* (with )?(unit )?tests?|write .* test case|regression test)\b/i, weight: 3.0 },
        { pattern: /\b(unit test|integration test|test case|coverage|spec|jest|vitest|mocha|snapshot test|regression test|e2e|end[- ]to[- ]end|tests?)\b/i, weight: 2.0 },
    ],
    [I.PROJECT_ANALYSIS]: [
        { pattern: new RegExp(LEAD + String.raw`(analy[sz]e|summari[sz]e|break down)\b`, 'i'), weight: 3.0 },
        { pattern: /\b(analy[sz]e the|tech stack|lines of code|dependency footprint|outdated dependencies|break down the codebase|break down .* by language|project (overview|metrics|size)|give me (stats|metrics))\b/i, weight: 3.0 },
        { pattern: /\b(analy[sz]e|analysis|stats?|metrics?|dependencies|tech stack|codebase|frameworks?|libraries|footprint|outdated)\b/i, weight: 2.0 },
    ],
};

export interface DeterministicScore {
    /** Highest-scoring single intent (MULTI_TOOL_WORKFLOW is never a candidate here). */
    topIntent: DeveloperIntent;
    topScore: number;
    topSignals: string[];
    secondIntent: DeveloperIntent;
    secondScore: number;
    /** Normalized top-vs-second gap in [0,1] (0 = tie, 1 = uncontested). */
    margin: number;
    /** Sorted (intent, score, signals) descending — for margin/secondary intents. */
    ranked: Array<{ intent: DeveloperIntent; score: number; signals: string[] }>;
}

/** Slash-command / very-short fast path. Identical to the original. */
export function fastPathClassify(prompt: string): IntentClassification | null {
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
 * Weighted-keyword scoring over the RAW prompt. Returns raw evidence only;
 * MULTI_TOOL_WORKFLOW is intentionally NOT scored here (it is decided from clause
 * structure by analyzeCompound + the fusion layer, not from keyword co-occurrence).
 */
export function scoreDeterministic(prompt: string): DeterministicScore {
    const scores = new Map<DeveloperIntent, { score: number; signals: string[] }>();
    for (const [intent, patterns] of Object.entries(INTENT_SIGNALS) as [DeveloperIntent, SignalPattern[]][]) {
        const entry = { score: 0, signals: [] as string[] };
        for (const { pattern, weight } of patterns) {
            const matches = prompt.match(pattern);
            if (matches) {
                entry.score += weight;
                const signal = matches[0].trim().slice(0, 40);
                if (signal && !entry.signals.includes(signal)) { entry.signals.push(signal); }
            }
        }
        scores.set(intent, entry);
    }
    const sorted = Array.from(scores.entries()).sort((a, b) => b[1].score - a[1].score);
    const [top, second] = sorted;
    const topScore = top[1].score;
    const secondScore = second ? second[1].score : 0;
    const margin = topScore > 0 ? Math.max(0, Math.min(1, (topScore - secondScore) / topScore)) : 0;
    return {
        topIntent: top[0],
        topScore,
        topSignals: top[1].signals,
        secondIntent: second ? second[0] : top[0],
        secondScore,
        margin,
        ranked: sorted.map(([intent, v]) => ({ intent, score: v.score, signals: v.signals })),
    };
}

/** A clause must clear this raw score to count as a genuine actionable objective. */
export const MIN_OBJECTIVE_SCORE = 2.5;

/** Coordinating conjunctions that separate two independent clauses/objectives. */
const CLAUSE_SPLIT = /\s+and\s+then\s+|\s+and\s+also\s+|\s+and\s+|\s+then\s+|\s+also\s+|\s+plus\s+|\s*;\s*|\s*&&\s*/i;

export interface CompoundAnalysis {
    /** True only when ≥2 clauses each resolve to a DISTINCT actionable intent. */
    isCompound: boolean;
    /** The distinct objectives found (length ≥2 when isCompound). */
    objectives: CompoundObjective[];
}

/**
 * Semantic compound-task analysis. A prompt is MULTI_TOOL_WORKFLOW only when it
 * expresses ≥2 DISTINCT actionable objectives — i.e. it splits on a coordinating
 * conjunction into clauses that INDEPENDENTLY score as different intents. Merely
 * matching two keyword families in one clause is NOT compound: "Why is this
 * middleware failing?" has no clause boundary and stays DEBUGGING; "Search the
 * latest Clerk pricing and update the auth module" splits into WEB_SEARCH +
 * CODE_GENERATION and is genuinely MULTI.
 */
export function analyzeCompound(prompt: string): CompoundAnalysis {
    const parts = prompt.split(CLAUSE_SPLIT).map(p => p.trim()).filter(p => p.length >= 3);
    if (parts.length < 2) { return { isCompound: false, objectives: [] }; }

    const objectives: CompoundObjective[] = [];
    const seenIntents = new Set<DeveloperIntent>();
    for (const clause of parts) {
        const s = scoreDeterministic(clause);
        if (s.topScore >= MIN_OBJECTIVE_SCORE && !seenIntents.has(s.topIntent)) {
            seenIntents.add(s.topIntent);
            objectives.push({ clause, intent: s.topIntent, score: s.topScore });
        }
    }
    return { isCompound: objectives.length >= 2, objectives };
}

/**
 * Deterministic-ONLY single-intent candidate (no fusion, no compound promotion).
 * Kept for the trainer's deterministic baseline and any standalone caller; the
 * runtime path uses fuseIntent, which treats this only as one input.
 */
export function classifyDeterministic(prompt: string): IntentClassification {
    const fast = fastPathClassify(prompt);
    if (fast) { return fast; }

    const s = scoreDeterministic(prompt);
    if (s.topScore === 0) {
        return { intent: DeveloperIntent.CODE_GENERATION, confidence: 0.3, signals: ['no_strong_signals'] };
    }
    return {
        intent: s.topIntent,
        confidence: Math.min(0.98, Math.max(0.3, s.topScore / 6)),
        signals: s.topSignals.length ? s.topSignals : ['no_strong_signals'],
    };
}
