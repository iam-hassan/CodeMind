/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { AggregatedContext, ToolOutput } from './types.js';

/**
 * Context Aggregation Engine (Section 5)
 * Merges outputs from all tool adapters into a single structured object.
 */

export function aggregateToolOutputs(outputs: ToolOutput[]): AggregatedContext {
    const agg: AggregatedContext = {
        projectBrain: null,
        repository: null,
        currentFiles: [],
        dependencies: null,
        gitState: null,
        webResults: [],
        terminalContext: null,
        collectionDurationMs: 0,
        toolsExecuted: [],
        toolsFailed: [],
    };

    for (const out of outputs) {
        agg.collectionDurationMs += out.durationMs;
        if (out.status === 'success') {
            agg.toolsExecuted.push(out.adapterId);
        } else {
            agg.toolsFailed.push(out.adapterId);
        }

        if (out.projectBrain) agg.projectBrain = out.projectBrain;
        if (out.repository) agg.repository = out.repository;
        if (out.currentFiles) agg.currentFiles.push(...out.currentFiles);
        if (out.dependencies) agg.dependencies = out.dependencies;
        if (out.gitState) agg.gitState = out.gitState;
        if (out.webResults) agg.webResults.push(...out.webResults);
        if (out.terminalContext) agg.terminalContext = out.terminalContext;
    }

    return agg;
}
