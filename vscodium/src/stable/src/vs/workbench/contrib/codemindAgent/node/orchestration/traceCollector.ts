/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { HeadroomResult } from './headroomLayer.js';
import {
    HeadroomLayerMeta,
    IntentClassification,
    LayerTrace,
    OrchestrationTrace,
} from './types.js';

/**
 * TraceCollector — Layer-3 truth comes from the REAL Claude Agent SDK tool stream.
 *
 * Phase-2's original design ran six "shadow adapters" (repository / fileContext /
 * dependency / git / webSearch / terminal) that reimplemented, inside the orchestration
 * worker, work the SDK's own tools already do. That parallel implementation could drift
 * from reality and made the dev-mode trace fictional. Those adapters have been removed.
 *
 * Instead, one TraceCollector per query OBSERVES the SDK message stream:
 *   - assistant `tool_use` blocks   → recordToolCall()
 *   - user `tool_result` blocks     → recordToolResult()
 *   - the terminal `result` message → finalize()
 *
 * So Layer 3 of the trace lists the tools the model ACTUALLY invoked this turn
 * (Read, Write, Edit, Bash, Glob, Grep, WebSearch, …) with their real inputs,
 * outcomes, and durations — never adapter names. Layer 6 carries the ACTUAL
 * HeadroomResult from the local compression proxy.
 *
 * Pure data collection: no vscode/electron imports; safe in the Node worker.
 */

const PREVIEW_CAP = 500;

/** JSON-safe, size-capped rendering of an arbitrary value for a trace row. */
function preview(value: unknown): string {
    let text: string;
    try {
        text = typeof value === 'string' ? value : (JSON.stringify(value ?? null) ?? String(value));
    } catch {
        text = String(value); // circular / unserializable
    }
    return text.length > PREVIEW_CAP ? `${text.slice(0, PREVIEW_CAP)}…` : text;
}

/** chars/4 — the same cheap heuristic the optimizer and headroom layer use. */
function estimateTokens(text: string): number {
    return Math.ceil((text?.length ?? 0) / 4);
}

/** A single observed SDK tool invocation and its result. */
interface ToolCallRecord {
    toolName: string;
    toolId: string;
    input: unknown;
    startMs: number;
    content?: unknown;
    isError: boolean;
    durationMs: number;
    ended: boolean;
}

/**
 * Structural view of the SDK's terminal `result` message. We read only what the trace
 * needs and stay tolerant of extra/missing fields (the SDK shape can evolve over time).
 */
export interface ResultMessageLike {
    model?: string;
    session_id?: string;
    duration_ms?: number;
    total_cost_usd?: number;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}

export class TraceCollector {
    private readonly _startMs = Date.now();
    private _intent: IntentClassification | null = null;
    private _toolRegistry: string[] = [];
    private _rawSuffix = '';
    private _headroom: HeadroomResult | null = null;
    private readonly _tools = new Map<string, ToolCallRecord>();
    private readonly _order: string[] = [];

    recordIntent(intent: IntentClassification): void {
        this._intent = intent;
    }

    /** The tool names the SDK made available this turn (for the Layer-2 view). */
    recordToolRegistry(names: string[]): void {
        this._toolRegistry = Array.isArray(names) ? names.slice() : [];
    }

    /** The raw system-prompt suffix (intent hint) fed into Layer 6, pre-compression. */
    recordSuffix(rawSuffix: string): void {
        this._rawSuffix = rawSuffix ?? '';
    }
    recordToolCall(call: { toolName: string; toolId: string; input: unknown; startMs: number }): void {
        if (!call?.toolId || this._tools.has(call.toolId)) { return; }
        this._tools.set(call.toolId, {
            toolName: call.toolName || 'unknown',
            toolId: call.toolId,
            input: call.input,
            startMs: call.startMs || Date.now(),
            isError: false,
            durationMs: 0,
            ended: false,
        });
        this._order.push(call.toolId);
    }

    recordToolResult(res: { toolId: string; content: unknown; isError: boolean; durationMs: number }): void {
        const rec = this._tools.get(res?.toolId);
        if (!rec) { return; }
        rec.content = res.content;
        rec.isError = res.isError === true;
        rec.durationMs = Math.max(0, res.durationMs || 0);
        rec.ended = true;
    }

    /** Start time of a recorded tool call, so the caller can compute a duration. */
    getToolStartMs(toolId: string): number {
        return this._tools.get(toolId)?.startMs ?? Date.now();
    }

    recordHeadroom(result: HeadroomResult): void {
        this._headroom = result;
    }

    /** Distinct tool names observed this turn, in first-seen order. */
    private _distinctToolNames(): string[] {
        const seen = new Set<string>();
        const names: string[] = [];
        for (const id of this._order) {
            const n = this._tools.get(id)?.toolName ?? 'unknown';
            if (!seen.has(n)) { seen.add(n); names.push(n); }
        }
        return names;
    }

    private _headroomMeta(h: HeadroomResult): HeadroomLayerMeta {
        return {
            library: 'headroom-ai',
            baseUrl: 'http://localhost:7878',
            mode: h.mode,
            originalTokens: h.originalTokens,
            compressedTokens: h.compressedTokens,
            tokensSaved: h.tokensSaved,
            compressionRatio: h.compressionRatio,
            headroomAvailable: h.headroomAvailable,
            proxyReachable: h.proxyReachable,
            durationMs: h.durationMs,
        };
    }

    private _headroomNotes(h: HeadroomResult): string[] {
        const notes = [`mode: ${h.mode}`, `${h.originalTokens}→${h.compressedTokens} tok`];
        if (h.mode === 'none') { return notes; }
        if (!h.headroomAvailable) { notes.push('headroom-ai not installed — passthrough'); }
        else if (!h.proxyReachable) { notes.push('proxy unreachable — fallback passthrough'); }
        else { notes.push(`saved ${h.tokensSaved} tok`); }
        return notes;
    }
    /**
     * Build the 7-layer trace once the turn's `result` message has arrived. Returns
     * null when dev mode is off (zero-overhead: the caller simply discards the collector).
     */
    finalize(resultMsg: ResultMessageLike | null, queryId: string, devMode: boolean): OrchestrationTrace | null {
        if (!devMode) { return null; }
        const now = Date.now();
        const intent = this._intent;
        const calls = this._order.map(id => this._tools.get(id)!).filter(Boolean);
        const distinct = this._distinctToolNames();
        const h = this._headroom;
        const layers: LayerTrace[] = [];

        // --- Layer 1: intentDetection ---
        const l1Out = intent
            ? { intent: intent.intent, confidence: intent.confidence, stage: intent.classifierStage }
            : { intent: 'unknown' };
        layers.push(this._layer(1, 'intentDetection',
            { prompt: '(user turn)' }, l1Out, 'pass', 0,
            intent?.signals?.length ? intent.signals : ['no signals']));

        // --- Layer 2: toolSelection (intent capabilities + available SDK tools) ---
        const required = intent?.requiredCapabilities ?? [];
        layers.push(this._layer(2, 'toolSelection',
            { requiredCapabilities: required },
            { availableTools: this._toolRegistry.length ? this._toolRegistry : '(sdk defaults)' },
            'pass', 0,
            [`intent requires: ${required.length ? required.join(', ') : '(none — SDK decides)'}`]));

        // --- Layer 3: toolExecution — REAL SDK tool calls (the key layer) ---
        const l3Rows = calls.map(c => ({ tool: c.toolName, input: c.input, ok: !c.isError, ms: c.durationMs }));
        const anyError = calls.some(c => c.isError);
        const l3Notes = calls.length
            ? [`${calls.length} tool call(s): ${distinct.join(', ')}`, ...(anyError ? ['≥1 tool reported an error'] : [])]
            : ['no tool calls this turn (model answered directly)'];
        layers.push(this._layer(3, 'toolExecution',
            { availableTools: distinct }, l3Rows,
            anyError ? 'error' : 'pass',
            calls.reduce((s, c) => s + (c.durationMs || 0), 0), l3Notes));

        // --- Layer 4: contextAggregation — what the tool results carried back ---
        const filesTouched = calls
            .filter(c => /read|write|edit/i.test(c.toolName))
            .map(c => {
                const input = c.input as { file_path?: unknown; path?: unknown } | null;
                if (typeof input?.file_path === 'string') { return input.file_path; }
                if (typeof input?.path === 'string') { return input.path; }
                return undefined;
            })
            .filter((p): p is string => typeof p === 'string');
        layers.push(this._layer(4, 'contextAggregation',
            l3Rows.map(r => `${r.tool}:${r.ok ? 'ok' : 'err'}`),
            { toolResults: calls.length, filesTouched: Array.from(new Set(filesTouched)) },
            'pass', 0, [`${calls.length} result(s) observed from the SDK stream`]));

        // --- Layer 5: contextOptimization — the minimal intent-hint suffix ---
        layers.push(this._layer(5, 'contextOptimization',
            { intent: intent?.intent }, this._rawSuffix || '(empty suffix)',
            'pass', 0,
            ['minimal intent-hint suffix; context gathering delegated to SDK tools (Layer 3)']));

        // --- Layer 6: headroomCompression — the ACTUAL HeadroomResult (local proxy only) ---
        if (h) {
            const l6 = this._layer(6, 'headroomCompression',
                this._rawSuffix || '(empty suffix)', h.compressedSuffix,
                'pass', h.durationMs, this._headroomNotes(h));
            l6.inputTokenEstimate = h.originalTokens;
            l6.outputTokenEstimate = h.compressedTokens;
            l6.headroom = this._headroomMeta(h);
            layers.push(l6);
        } else {
            layers.push(this._layer(6, 'headroomCompression',
                '(no suffix compressed)', '(no suffix compressed)',
                'skipped', 0, ['headroom not engaged this turn']));
        }

        // --- Layer 7: claudeAgentSDK — the terminal result message ---
        layers.push(this._layer(7, 'claudeAgentSDK',
            { model: resultMsg?.model, suffixTokens: h?.compressedTokens ?? 0 },
            {
                model: resultMsg?.model,
                inputTokens: resultMsg?.usage?.input_tokens,
                outputTokens: resultMsg?.usage?.output_tokens,
                durationMs: resultMsg?.duration_ms,
                costUsd: resultMsg?.total_cost_usd,
            },
            'pass', resultMsg?.duration_ms ?? 0,
            [resultMsg ? `model: ${resultMsg.model ?? 'unknown'}` : 'no result message']));

        return {
            queryId,
            timestamp: this._startMs,
            intent: intent?.intent,
            totalDurationMs: now - this._startMs,
            cacheHit: false,
            timedOut: false,
            originalTokens: h?.originalTokens ?? 0,
            finalTokens: h?.compressedTokens ?? 0,
            layers,
        };
    }

    private _layer(
        index: number, name: string, input: unknown, output: unknown,
        status: LayerTrace['status'], durationMs: number, notes: string[]
    ): LayerTrace {
        const inPrev = preview(input);
        const outPrev = preview(output);
        return {
            layerName: name,
            layerIndex: index,
            durationMs: Math.max(0, durationMs || 0),
            status,
            input: inPrev,
            output: outPrev,
            inputTokenEstimate: estimateTokens(inPrev),
            outputTokenEstimate: estimateTokens(outPrev),
            notes,
        };
    }
}
