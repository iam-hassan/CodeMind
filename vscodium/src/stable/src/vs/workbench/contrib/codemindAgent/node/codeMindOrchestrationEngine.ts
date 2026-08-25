/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { classifyIntent } from './orchestration/intentDetector.js';
import {
    OrchestrationRequest,
    OrchestrationResult,
    ToolAdapterRegistry,
    DeveloperIntent,
    IntentClassification,
} from './orchestration/types.js';

/**
 * Main Orchestration Coordinator (Phase-2, post shadow-adapter removal).
 *
 * The pipeline used to run six "shadow adapters" that reimplemented repository / file /
 * dependency / git / web / terminal context inside this worker, aggregate them, optimize
 * them, and compress the result. That parallel implementation could drift from what the
 * model actually did, so it was removed. orchestrate() now does exactly two honest things:
 *
 *   1. classify the developer's intent (Layer 1), and
 *   2. return a MINIMAL intent-hint suffix that nudges the model to gather context with
 *      its own real tools (Read / Grep / Glob / Bash / WebSearch …).
 *
 * The real context gathering, and therefore the real Layer-3 tool list and Layer-6 Headroom
 * compression, are observed downstream by a per-query TraceCollector in the engine main
 * against the live Claude Agent SDK stream — never reconstructed here. No adapters are run,
 * no context is aggregated, and nothing is cached (there is no aggregated context to cache).
 */

// A.9 – Performance telemetry (module scope). Retained so `/orchestration` keeps working.
const _perfHistory: number[] = [];
const _perfStats = {
    averagePipelineMs: 0,
    p95PipelineMs: 0,
    cacheHitRate: 0,     // no result cache anymore — always 0
    adapterTimeouts: 0,  // no adapters run here anymore — always 0
    headroomAvailable: false,
    totalQueries: 0,
};

export function getOrchestrationPerf() {
    return { ..._perfStats };
}

// B.3 – Dev-mode flag mirror. The 7-layer trace itself is built by the engine main's
// TraceCollector from the real SDK stream; this flag is kept so setDevMode()/getTraceBuffer()
// stay valid exports for the IPC surface. The buffer is unused here (traces are emitted live).
let _devModeEnabled = false;
const _traceBuffer: any[] = [];

export function setDevMode(enabled: boolean): void {
    _devModeEnabled = enabled;
}

/** Whether dev mode is on. The live 7-layer trace is emitted by the engine main's
 *  TraceCollector; this mirror exists so the IPC surface can report the toggle state. */
export function isDevModeEnabled(): boolean {
    return _devModeEnabled;
}

export function getTraceBuffer() {
    return [..._traceBuffer];
}

/**
 * The MINIMAL system-prompt suffix. It is deliberately tiny: it states the detected intent
 * and tells the model to gather any missing context with its own tools rather than asking
 * the user. Whatever bulk the caller already supplied is prepended and compressed by Layer 6
 * (Headroom) in the engine main; this hint alone stays under the compression threshold.
 */
function buildIntentHintSuffix(intent: IntentClassification): string {
    const caps = intent.requiredCapabilities?.length
        ? intent.requiredCapabilities.join(', ')
        : '(model decides)';
    return `\n\n[CODEMIND ORCHESTRATION]\n` +
        `Detected intent: ${intent.intent} (confidence ${intent.confidence.toFixed(2)})\n` +
        `Likely needs: ${caps}\n` +
        `Gather any missing context with your own tools (Read, Grep, Glob, Bash, WebSearch); ` +
        `do not ask for information you can look up yourself.`;
}

export async function orchestrate(
    request: OrchestrationRequest,
    _registry: ToolAdapterRegistry,
    onProgress: (event: any) => void
): Promise<OrchestrationResult> {
    const t0 = Date.now();

    // A.7 – Intent fast path: very short prompts skip classification entirely and emit no
    // progress (there is nothing to report and the model answers directly).
    if (request.userPrompt.trim().length < 20) {
        return {
            enrichedPrompt: request.userPrompt,
            systemPromptSuffix: '',
            orchestrationMetadata: {
                intent: DeveloperIntent.CODE_GENERATION,
                confidence: 0.5,
                toolsExecuted: [],
                toolsFailed: [],
                originalTokenEstimate: 0,
                finalTokenEstimate: 0,
                compressionMode: 'none',
                headroomAvailable: false,
                totalDurationMs: 0,
            },
        };
    }

    // Layer 1 — intent classification (the only real work orchestrate() does now).
    onProgress({ type: 'orchestration_progress', queryId: request.queryId, phase: 'intent_detection', status: 'running' });
    const intent = classifyIntent(request.userPrompt);
    onProgress({ type: 'orchestration_progress', queryId: request.queryId, phase: 'intent_detection', status: 'complete', intent: intent.intent });

    // The user turn stays pristine; the tiny intent hint rides in the system-prompt suffix.
    // Headroom (Layer 6) compression of the COMBINED suffix happens in the engine main, so
    // metadata here reports the pre-compression, no-adapter state honestly.
    const enrichedPrompt = request.userPrompt;
    const systemPromptSuffix = buildIntentHintSuffix(intent);

    // A.9 – Rolling performance stats (classification is sub-millisecond, but keep the shape).
    _perfHistory.push(Date.now() - t0);
    if (_perfHistory.length > 20) { _perfHistory.shift(); }
    _perfStats.totalQueries++;
    if (_perfHistory.length >= 5) {
        const sorted = [..._perfHistory].sort((a, b) => a - b);
        _perfStats.averagePipelineMs = sorted.reduce((s, v) => s + v, 0) / sorted.length;
        _perfStats.p95PipelineMs = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
    }

    return {
        enrichedPrompt,
        systemPromptSuffix,
        orchestrationMetadata: {
            intent: intent.intent,
            confidence: intent.confidence,
            toolsExecuted: [],
            toolsFailed: [],
            originalTokenEstimate: Math.ceil(systemPromptSuffix.length / 4),
            finalTokenEstimate: Math.ceil(systemPromptSuffix.length / 4),
            compressionMode: 'none',
            headroomAvailable: false,
            totalDurationMs: Date.now() - t0,
        },
    };
}
