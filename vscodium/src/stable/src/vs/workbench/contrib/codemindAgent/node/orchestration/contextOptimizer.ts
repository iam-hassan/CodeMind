/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { OptimizedContext, AggregatedContext, DeveloperIntent } from './types.js';

/**
 * Context Optimization Engine (Section 6)
 * Deduplication, relevance pruning, file trimming, history condensing.
 */

function deduplicate(serialized: string): { text: string; removed: number } {
    const lines = serialized.split('\n');
    const seen = new Set<string>();
    const out: string[] = [];
    let removed = 0;
    for (const line of lines) {
        const key = line.toLowerCase().trim();
        if (key && seen.has(key)) { removed++; continue; }
        if (key) seen.add(key);
        out.push(line);
    }
    return { text: out.join('\n'), removed };
}

function pruneByIntent(serialized: string, intent: DeveloperIntent): { text: string; removedSections: string[] } {
    const sections = serialized.split(/\n=== /);
    const keep: string[] = [];
    const removed: string[] = [];

    for (const sec of sections) {
        const header = sec.split('\n')[0].toUpperCase();
        if (intent === DeveloperIntent.TERMINAL_EXECUTION && /REPOSITORY|DEPENDENC|GIT/.test(header)) { removed.push(header); continue; }
        if (intent === DeveloperIntent.MEMORY_RETRIEVAL && /REPOSITORY|DEPENDENC|GIT|WEB/.test(header)) { removed.push(header); continue; }
        if (intent === DeveloperIntent.WEB_SEARCH && /REPOSITORY|DEPENDENC|GIT/.test(header)) { removed.push(header); continue; }
        keep.push(sec);
    }
    return { text: keep.join('\n=== '), removedSections: removed };
}

function trimFileContext(serialized: string): string {
    // Already trimmed inside fileContextAdapter; this pass is a safety net
    return serialized.replace(/(\n.{200,}\n)/g, (m) => m.slice(0, 200) + '\n[... trimmed ...]\n');
}

export function optimizeContext(
    aggregated: AggregatedContext,
    userPrompt: string,
    intent: DeveloperIntent
): OptimizedContext {
    const start = Date.now();

    // 1. Serialize (compact format)
    let serialized = '';
    if (aggregated.projectBrain?.available) {
        serialized += `=== PROJECT CONTEXT ===\n${aggregated.projectBrain.facts.join('\n')}\n`;
    }
    if (aggregated.repository) {
        serialized += `=== REPOSITORY ===\nCurrent: ${aggregated.repository.openFile}\nRelated: ${aggregated.repository.relatedFiles.slice(0, 8).join(', ')}\n`;
    }
    if (aggregated.currentFiles.length) {
        for (const f of aggregated.currentFiles) {
            serialized += `=== FILE: ${f.path} ===\n${f.content}\n`;
        }
    }
    if (aggregated.dependencies?.packages.length) {
        serialized += `=== DEPENDENCIES ===\n${aggregated.dependencies.packages.map(p => `${p.name}:${p.version}`).join(', ')}\n`;
    }
    if (aggregated.gitState?.available) {
        serialized += `=== GIT ===\nBranch: ${aggregated.gitState.branch}\nCommits: ${aggregated.gitState.recentCommits?.slice(0, 3).join(' | ')}\n`;
    }
    if (aggregated.webResults.length) {
        serialized += `=== WEB ===\n${aggregated.webResults.map(w => w.injectedDirective).join(' ')}\n`;
    }

    // 2. Deduplicate
    const dedup = deduplicate(serialized);

    // 3. Prune by intent
    const pruned = pruneByIntent(dedup.text, intent);

    // 4. Trim file context (safety)
    const trimmed = trimFileContext(pruned.text);

    const tokenEst = Math.floor(trimmed.length / 4);

    return {
        serializedContext: trimmed,
        estimatedTokens: tokenEst,
        sectionsIncluded: Object.keys(aggregated).filter(k => (aggregated as any)[k]),
        sectionsRemoved: pruned.removedSections,
        optimizationDurationMs: Date.now() - start,
    };
}
