/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { classifyIntent } from './orchestration/intentDetector.js';
import { selectTools } from './orchestration/toolSelector.js';
import { executeTools } from './orchestration/toolExecutor.js';
import { aggregateToolOutputs } from './orchestration/contextAggregator.js';
import { optimizeContext } from './orchestration/contextOptimizer.js';
import { compressContext } from './orchestration/headroomLayer.js';
import {
    OrchestrationRequest,
    OrchestrationResult,
    ToolAdapterRegistry,
    DeveloperIntent,
    AggregatedContext,
} from './orchestration/types.js';

// A.5 – Result cache (module scope, survives across queries in the same worker)
interface CacheEntry {
    context: AggregatedContext;
    expiresAt: number;
}
const _contextCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;
let _cacheHits = 0;
let _cacheLookups = 0;
let _lastIntent: DeveloperIntent = DeveloperIntent.CODE_GENERATION;

// A.9 – Performance telemetry (module scope)
const _perfHistory: number[] = [];
const _perfStats = {
    averagePipelineMs: 0,
    p95PipelineMs: 0,
    cacheHitRate: 0,
    adapterTimeouts: 0,
    headroomAvailable: false,
    totalQueries: 0,
};

export function getOrchestrationPerf() {
    return { ..._perfStats };
}

// B.2 – Dev mode trace collection (module scope, zero overhead when disabled)
let _devModeEnabled = false;
const _traceBuffer: any[] = []; // max 20 entries

export function setDevMode(enabled: boolean) {
    _devModeEnabled = enabled;
}

export function getTraceBuffer() {
    return [..._traceBuffer];
}

/** JSON-safe, size-capped rendering of an arbitrary value for the dev-mode trace. */
function preview(value: unknown): string {
    let text: string;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value ?? null) ?? String(value);
    } catch {
        text = String(value); // circular or otherwise unserializable
    }
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function buildCacheKey(req: OrchestrationRequest): string {
    return createHash('sha256')
        .update(req.workspaceFolder + _lastIntent + req.openFiles.join(':'))
        .digest('hex')
        .slice(0, 16);
}

/**
 * Main Orchestration Coordinator (Section 9)
 * Wires Steps 1–6 together and returns the final enriched prompt + metadata.
 */

function buildSystemPromptSuffix(intent: any, aggregated: any): string {
    const sections = Object.keys(aggregated).filter(k => (aggregated as any)[k] && k !== 'collectionDurationMs');
    return `\n\n[CODEMIND ORCHESTRATION]\nDetected intent: ${intent.intent}\nPre-fetched context: ${sections.join(', ')}\nProject Brain: ${aggregated.projectBrain?.available ? 'available' : 'stub'}\nDo not ask for information already in the context above.`;
}

export async function orchestrate(
    request: OrchestrationRequest,
    registry: ToolAdapterRegistry,
    onProgress: (event: any) => void
): Promise<OrchestrationResult> {
    const t0 = Date.now();

    // A.7 – Intent fast path: very short prompts
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

    // A.5 – Result cache check
    const cacheKey = buildCacheKey(request);
    const cached = _contextCache.get(cacheKey);
    _cacheLookups++;
    if (cached && cached.expiresAt > Date.now()) {
        _cacheHits++;
        _perfStats.cacheHitRate = _cacheHits / _cacheLookups;
        onProgress({
            type: 'orchestration_progress',
            queryId: request.queryId,
            phase: 'cache_hit',
            status: 'cache_hit',
        });
        // Skip tool execution – jump to optimization + headroom using cached context
        const aggregated = cached.context;
        const optimized = optimizeContext(aggregated, request.userPrompt, _lastIntent);
        const compressed = await compressContext(optimized, request.model, request.token);
        const enrichedPrompt = compressed.context
            ? `${compressed.context}\n\n---\n\n${request.userPrompt}`
            : request.userPrompt;
        return {
            enrichedPrompt,
            systemPromptSuffix: buildSystemPromptSuffix({ intent: _lastIntent }, aggregated),
            orchestrationMetadata: {
                intent: _lastIntent,
                confidence: 0.9,
                toolsExecuted: aggregated.toolsExecuted,
                toolsFailed: aggregated.toolsFailed,
                originalTokenEstimate: optimized.estimatedTokens,
                finalTokenEstimate: compressed.estimatedTokens,
                compressionMode: compressed.mode,
                headroomAvailable: compressed.headroomAvailable,
                totalDurationMs: Date.now() - t0,
            },
        };
    }

    // B.2 – Start collecting trace if dev mode is enabled
    const layers: any[] = [];
    const pushLayer = (name: string, index: number, input: any, output: any, status: string, duration: number, notes: string[] = []) => {
        if (!_devModeEnabled) return;
        layers.push({
            layerName: name,
            layerIndex: index,
            durationMs: duration,
            status,
            // Previews are truncated strings, not objects: slicing serialized JSON and
            // re-parsing it throws on anything longer than the cut.
            input: preview(input),
            output: preview(output),
            inputTokenEstimate: 0,
            outputTokenEstimate: 0,
            notes,
        });
    };

    // Step 1: Intent
    const tIntent = Date.now();
    onProgress({ type: 'orchestration_progress', queryId: request.queryId, phase: 'intent_detection', status: 'running' });
    const intent = classifyIntent(request.userPrompt);
    _lastIntent = intent.intent; // update for next cache key
    onProgress({ type: 'orchestration_progress', queryId: request.queryId, phase: 'intent_detection', status: 'complete', intent: intent.intent });
    pushLayer('intentDetection', 1, { prompt: request.userPrompt }, intent, 'pass', Date.now() - tIntent, intent.signals);

    // Step 2: Tool selection
    const tSelect = Date.now();
    const selectionContext = {
        hasOpenFiles: request.openFiles.length > 0,
        workspaceFolder: request.workspaceFolder,
        promptLength: request.userPrompt.length,
        hasImageAttachments: false,
        isFollowUp: request.isFollowUp,
    };
    const selectedTools = selectTools(intent, selectionContext, registry);
    pushLayer('toolSelection', 2, selectionContext, selectedTools.map(t => t.id), 'pass', Date.now() - tSelect);

    // Step 3: Parallel execution
    const tExec = Date.now();
    onProgress({ type: 'orchestration_progress', queryId: request.queryId, phase: 'tool_execution', status: 'running', toolId: selectedTools.map(t => t.id).join(',') });
    const toolOutputs = await executeTools(selectedTools, request, onProgress, request.token);
    onProgress({ type: 'orchestration_progress', queryId: request.queryId, phase: 'tool_execution', status: 'complete' });
    const timedOutTools = toolOutputs.filter(o => o.status === 'timeout').map(o => o.adapterId);
    _perfStats.adapterTimeouts += timedOutTools.length;
    pushLayer('toolExecution', 3, selectedTools.map(t => t.id), toolOutputs.map(o => `${o.adapterId}:${o.status}`),
        timedOutTools.length ? 'timeout' : 'pass', Date.now() - tExec, timedOutTools);

    // Step 4: Aggregation
    const tAgg = Date.now();
    const aggregated = aggregateToolOutputs(toolOutputs);
    _perfStats.cacheHitRate = _cacheHits / _cacheLookups;
    _contextCache.set(cacheKey, { context: aggregated, expiresAt: Date.now() + CACHE_TTL_MS });
    pushLayer('contextAggregation', 4, toolOutputs.length, aggregated.toolsExecuted, 'pass', Date.now() - tAgg);

    // Step 5: Optimization
    const tOpt = Date.now();
    const optimized = optimizeContext(aggregated, request.userPrompt, intent.intent);
    pushLayer('contextOptimization', 5, aggregated.toolsExecuted, optimized.sectionsIncluded, 'pass', Date.now() - tOpt, optimized.sectionsRemoved);

    // Step 6: Headroom
    const tHead = Date.now();
    const compressed = await compressContext(optimized, request.model, request.token);
    _perfStats.headroomAvailable = compressed.headroomAvailable;
    pushLayer('headroomCompression', 6, optimized.estimatedTokens, compressed.estimatedTokens, 'pass', Date.now() - tHead, [compressed.mode]);

    const enrichedPrompt = compressed.context
        ? `${compressed.context}\n\n---\n\n${request.userPrompt}`
        : request.userPrompt;

    const systemPromptSuffix = buildSystemPromptSuffix(intent, aggregated);

    const result = {
        enrichedPrompt,
        systemPromptSuffix,
        orchestrationMetadata: {
            intent: intent.intent,
            confidence: intent.confidence,
            toolsExecuted: aggregated.toolsExecuted,
            toolsFailed: aggregated.toolsFailed,
            originalTokenEstimate: optimized.estimatedTokens,
            finalTokenEstimate: compressed.estimatedTokens,
            compressionMode: compressed.mode,
            headroomAvailable: compressed.headroomAvailable,
            totalDurationMs: Date.now() - t0,
        },
    };

    // B.2 – Publish the trace so getTraceBuffer()/getTraceHistory() can serve it
    if (_devModeEnabled) {
        _traceBuffer.push({
            queryId: request.queryId,
            timestamp: t0,
            totalDurationMs: Date.now() - t0,
            cacheHit: false,
            timedOut: false,
            layers,
        });
        while (_traceBuffer.length > 20) { _traceBuffer.shift(); }

	        // B.3 – Emit the event so agent.js can render the trace card
	        onProgress({
	            type: 'orchestration_trace',
	            queryId: request.queryId,
	            trace,
	        } as any);
	    }

    // A.9 – Update rolling performance stats
    _perfHistory.push(Date.now() - t0);
    if (_perfHistory.length > 20) _perfHistory.shift();
    _perfStats.totalQueries++;
    if (_perfHistory.length >= 5) {
        const sorted = [..._perfHistory].sort((a, b) => a - b);
        _perfStats.averagePipelineMs = sorted.reduce((s, v) => s + v, 0) / sorted.length;
        _perfStats.p95PipelineMs = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
    }
    if (_perfStats.averagePipelineMs > 2000 && _perfStats.totalQueries >= 10) {
        (result.orchestrationMetadata as any).performanceWarning =
            'Pipeline running slowly — check /orchestration';
    }

    return result;
}
