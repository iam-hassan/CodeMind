/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ToolAdapter, OrchestrationRequest, ToolOutput, IntentClassification, SelectionContext } from '../types.js';

/**
 * projectBrainAdapter (Section 8.1) — STUB
 * Returns a hard-coded "not yet available" response.
 * This stub is replaced when Phase 1 (Project Brain) is implemented.
 */
export const projectBrainAdapter: ToolAdapter = {
    id: 'projectBrainAdapter',
    name: 'Project Brain',
    TIMEOUT_MS: 50,
    // Self-declared capabilities — the selector matches these; it never keys off
    // the id. Mirrored by CANONICAL_ADAPTER_CAPABILITIES (drift-guarded by test).
    capabilities: ['project_memory', 'architecture_history', 'decision_history'],
    cost: 'low',
    latency: 'fast',
    external: false,
    supportsParallel: true,
    async execute(_request: OrchestrationRequest): Promise<ToolOutput> {
        return {
            adapterId: 'projectBrainAdapter',
            status: 'success',
            durationMs: 0,
            outputSummary: 'Project Brain not yet initialized (Phase 1)',
            outputTokenEstimate: 0,
            projectBrain: {
                available: false,
                reason: 'Project Brain not yet initialized (Phase 1)',
                facts: [],
                decisions: [],
            },
        };
    },
    shouldRun(_intent: IntentClassification, _context: SelectionContext): boolean {
        // Always available as a stub; real implementation may gate on projectBrainEnabled setting
        return true;
    },
};
