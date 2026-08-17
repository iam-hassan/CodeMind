/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ToolAdapter, OrchestrationRequest, ToolOutput } from './types.js';

/**
 * Tool Execution Layer (Section 4)
 * Runs all selected adapters in parallel with per-adapter timeouts.
 * Emits progress events via the provided callback.
 */

// A.6 – Streaming context injection helper
async function* settleAsCompleted<T>(promises: Map<string, Promise<T>>): AsyncIterable<T> {
    const pending = new Map(promises);
    while (pending.size > 0) {
        const settled = await Promise.race(
            Array.from(pending.entries()).map(([id, p]) =>
                p.then((v) => ({ id, value: v, done: true }))
            )
        );
        if ((settled as any).done) {
            pending.delete((settled as any).id);
            yield (settled as any).value;
        }
    }
}

export async function raceForMinimumContext(
    toolPromises: Map<string, Promise<ToolOutput>>,
    minimumTools: number,
    deadlineMs: number
): Promise<ToolOutput[]> {
    const results: ToolOutput[] = [];
    const start = Date.now();
    for await (const result of settleAsCompleted(toolPromises)) {
        results.push(result);
        if (results.length >= minimumTools && Date.now() - start >= deadlineMs * 0.6) break;
        if (Date.now() - start >= deadlineMs) break;
    }
    return results;
}

export async function executeTools(
    tools: ToolAdapter[],
    request: OrchestrationRequest,
    onProgress: (event: any) => void,
    token: any // CancellationToken
): Promise<ToolOutput[]> {
    // A.6 – Use partial results for workflows with 3+ tools
    if (tools.length >= 3) {
        const promiseMap = new Map<string, Promise<ToolOutput>>();
        for (const adapter of tools) {
            const p = (async () => {
                const start = Date.now();
                onProgress({ type: 'orchestration_progress', queryId: request.queryId, phase: 'tool_execution', status: 'running', toolId: adapter.id });
                try {
                    const res = await Promise.race([
                        adapter.execute(request),
                        new Promise<ToolOutput>(r => setTimeout(() => r({ adapterId: adapter.id, status: 'timeout', durationMs: adapter.TIMEOUT_MS ?? 2000, outputSummary: 'timeout', outputTokenEstimate: 0 }), adapter.TIMEOUT_MS ?? 2000))
                    ]);
                    onProgress({ type: 'orchestration_progress', queryId: request.queryId, phase: 'tool_execution', status: res.status === 'timeout' ? 'failed' : 'complete', toolId: adapter.id, durationMs: res.durationMs });
                    return res;
                } catch (e: any) {
                    const errRes: ToolOutput = { adapterId: adapter.id, status: 'error', durationMs: Date.now() - start, outputSummary: String(e?.message || e).slice(0, 200), outputTokenEstimate: 0, error: String(e) };
                    onProgress({ type: 'orchestration_progress', queryId: request.queryId, phase: 'tool_execution', status: 'failed', toolId: adapter.id });
                    return errRes;
                }
            })();
            promiseMap.set(adapter.id, p);
        }
        const partial = await raceForMinimumContext(promiseMap, 2, 1500);
        // Continue the remaining promises in background (fire-and-forget)
        for (const [id, p] of promiseMap) {
            if (!partial.some(r => r.adapterId === id)) {
                p.then(r => { /* background completion – results dropped */ }).catch(() => {});
            }
        }
        return partial;
    }

    // Normal path (≤2 tools) – full wait
    const results = await Promise.allSettled(
        tools.map(async (adapter) => {
            const timeout = adapter.TIMEOUT_MS ?? 2000;
            const start = Date.now();

            onProgress({
                type: 'orchestration_progress',
                queryId: request.queryId,
                phase: 'tool_execution',
                status: 'running',
                toolId: adapter.id,
            });

            const timeoutPromise = new Promise<ToolOutput>((resolve) =>
                setTimeout(() => resolve({
                    adapterId: adapter.id,
                    status: 'timeout',
                    durationMs: timeout,
                    outputSummary: 'timeout',
                    outputTokenEstimate: 0,
                }), timeout)
            );

            const execPromise = adapter.execute(request).catch((err: any) => ({
                adapterId: adapter.id,
                status: 'error' as const,
                durationMs: Date.now() - start,
                outputSummary: String(err?.message || err).slice(0, 200),
                outputTokenEstimate: 0,
                error: String(err),
            }));

            const result = await Promise.race([execPromise, timeoutPromise]);

            onProgress({
                type: 'orchestration_progress',
                queryId: request.queryId,
                phase: 'tool_execution',
                status: result.status === 'timeout' ? 'failed' : 'complete',
                toolId: adapter.id,
                durationMs: result.durationMs,
            });

            return result;
        })
    );

    return results.map(r => r.status === 'fulfilled' ? r.value : ({
        adapterId: 'unknown',
        status: 'error',
        durationMs: 0,
        outputSummary: 'promise rejected',
        outputTokenEstimate: 0,
    }));
}
