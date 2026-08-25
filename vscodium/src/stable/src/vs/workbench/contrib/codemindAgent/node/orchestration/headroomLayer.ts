/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { get as httpGet } from 'http';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { CompressionMode } from './types.js';

/**
 * Headroom Compression Layer (Layer 6) — LOCAL PROXY ONLY.
 *
 * Compresses the system-prompt suffix that the orchestration engine builds (intent hint
 * + serialized pre-fetched context) before it is appended to the Claude Agent SDK's
 * system prompt. Compression runs against a *local* Headroom proxy (`headroom proxy
 * --port 7878`); nothing leaves the machine. `fallback: true` means that if the proxy is
 * not running the library returns the messages unchanged, so the pipeline degrades
 * gracefully and never stalls — CodeMind works with or without the proxy.
 *
 * The `headroom-ai` package is installed only in the sibling `claude-code/` tree, so we
 * resolve and dynamically import it at runtime; if it cannot be found the layer is a
 * lossless no-op.
 */

export const HEADROOM_PORT = 7878;
export const HEADROOM_BASE_URL = `http://localhost:${HEADROOM_PORT}`;
export const COMPRESS_THRESHOLD_LIGHT = 500;      // < this many tokens → mode 'none'
export const COMPRESS_THRESHOLD_AGGRESSIVE = 2000; // >= this many tokens → mode 'aggressive'
const COMPRESS_TIMEOUT_MS = 4000;                  // never let a slow/hung proxy stall a turn

export interface HeadroomResult {
    compressedSuffix: string;
    originalTokens: number;
    compressedTokens: number;
    tokensSaved: number;
    compressionRatio: number;    // compressedTokens / originalTokens (1 = unchanged)
    mode: CompressionMode;
    headroomAvailable: boolean;  // library resolved and loaded
    proxyReachable: boolean;     // proxy actually performed compression
    transformsApplied: string[];
    durationMs: number;
}

type CompressFn = (messages: any[], options?: any) => Promise<any>;
let _compress: CompressFn | null = null;
let _headroomAvailable: boolean | null = null; // null = not yet probed

/** chars/4 — the same cheap heuristic the context optimizer uses. */
export function estimateTokens(text: string): number {
    return Math.ceil((text?.length ?? 0) / 4);
}

export function decideMode(estimatedTokens: number): CompressionMode {
    if (estimatedTokens < COMPRESS_THRESHOLD_LIGHT) return 'none';
    if (estimatedTokens < COMPRESS_THRESHOLD_AGGRESSIVE) return 'light';
    return 'aggressive';
}

/**
 * Walk up from this module to find the sibling claude-code install of headroom-ai.
 * Robust to the various runtime layouts (dev out/, overlay copy, packaged app).
 */
function resolveHeadroomEntry(): string | null {
    let dir: string;
    try { dir = dirname(fileURLToPath(import.meta.url)); }
    catch { return null; }
    const rel = ['claude-code', 'node_modules', 'headroom-ai', 'dist', 'index.js'];
    for (let i = 0; i < 16; i++) {
        const candidate = resolve(dir, ...rel);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break; // filesystem root
        dir = parent;
    }
    return null;
}

export async function prewarmHeadroom(): Promise<void> {
    if (_headroomAvailable !== null) return;
    try {
        const entry = resolveHeadroomEntry();
        if (!entry) { _headroomAvailable = false; return; }
        const mod: any = await import(entry);
        const fn = mod.compress ?? mod.default?.compress;
        if (typeof fn === 'function') { _compress = fn; _headroomAvailable = true; }
        else { _headroomAvailable = false; }
    } catch {
        _headroomAvailable = false;
    }
}

async function ensureHeadroom(): Promise<boolean> {
    if (_headroomAvailable === null) await prewarmHeadroom();
    return _headroomAvailable ?? false;
}

/**
 * Compress the system-prompt suffix via the local Headroom proxy.
 * Always resolves — on any failure it returns the suffix unchanged.
 */
export async function compressSuffix(
    systemPromptSuffix: string,
    model: string,
    _intent: string
): Promise<HeadroomResult> {
    const started = Date.now();
    const suffix = systemPromptSuffix ?? '';
    const originalTokens = estimateTokens(suffix);
    const mode = decideMode(originalTokens);

    const passthrough = (headroomAvailable: boolean, proxyReachable: boolean): HeadroomResult => ({
        compressedSuffix: suffix,
        originalTokens,
        compressedTokens: originalTokens,
        tokensSaved: 0,
        compressionRatio: 1,
        mode,
        headroomAvailable,
        proxyReachable,
        transformsApplied: [],
        durationMs: Date.now() - started,
    });

    // Small suffix (or empty): nothing worth compressing. Headroom is not engaged, so we
    // report it as unavailable regardless of whether the library happens to be installed —
    // this keeps the "mode none" result deterministic and the trace dot grey.
    if (mode === 'none' || suffix.length === 0) {
        return passthrough(false, false);
    }

    const available = await ensureHeadroom();
    if (!available || !_compress) {
        return passthrough(false, false);
    }

    // Light mode preserves the LAST '=== SECTION ===' block verbatim and compresses the
    // rest; aggressive mode compresses the whole suffix.
    let toCompress = suffix;
    let preserved = '';
    if (mode === 'light') {
        const idx = suffix.lastIndexOf('\n===');
        if (idx > 0) {
            toCompress = suffix.slice(0, idx);
            preserved = suffix.slice(idx);
        }
    }

    try {
        const result: any = await _compress(
            [{ role: 'user', content: toCompress }],
            { model, baseUrl: HEADROOM_BASE_URL, fallback: true, timeout: COMPRESS_TIMEOUT_MS }
        );
        // Real API returns a CompressResult object ({ messages, tokensBefore, ... }).
        // Stay defensive about a bare-array shape too.
        const compressedContent: string =
            result?.messages?.[0]?.content ??
            (Array.isArray(result) ? result?.[0]?.content : undefined) ??
            toCompress;
        const proxyReachable = result?.compressed === true;
        const compressedSuffix = compressedContent + preserved;
        const compressedTokens = estimateTokens(compressedSuffix);
        const tokensSaved = Math.max(0, originalTokens - compressedTokens);
        const compressionRatio = originalTokens > 0 ? compressedTokens / originalTokens : 1;
        const transformsApplied: string[] = Array.isArray(result?.transformsApplied) ? result.transformsApplied : [];
        return {
            compressedSuffix,
            originalTokens,
            compressedTokens,
            tokensSaved,
            compressionRatio,
            mode,
            headroomAvailable: true,
            proxyReachable,
            transformsApplied,
            durationMs: Date.now() - started,
        };
    } catch {
        // Proxy unreachable / any error → graceful fallback, suffix unchanged.
        return passthrough(true, false);
    }
}

/**
 * Probe the local Headroom proxy's health route. Any HTTP response (even a 404 from a
 * proxy without an explicit /health route) proves something is listening on the port;
 * a connection error or timeout means it is not. Never throws — resolves to a verdict.
 */
export function pingHeadroomProxy(timeoutMs = 1000): Promise<{ reachable: boolean; status?: number }> {
    return new Promise((resolvePromise) => {
        let settled = false;
        const done = (v: { reachable: boolean; status?: number }) => {
            if (settled) { return; }
            settled = true;
            resolvePromise(v);
        };
        try {
            const req = httpGet(`${HEADROOM_BASE_URL}/health`, (res) => {
                const status = res.statusCode;
                res.resume(); // drain so the socket can close
                done({ reachable: true, status });
            });
            req.setTimeout(timeoutMs, () => { req.destroy(); done({ reachable: false }); });
            req.on('error', () => done({ reachable: false }));
        } catch {
            done({ reachable: false });
        }
    });
}

/**
 * One-shot health summary for /doctor: is the library installed, and is the proxy up.
 * Both are optional — CodeMind compresses when the proxy runs and passes through when
 * it does not — so callers report this as informational, never as a hard failure.
 */
export async function probeHeadroom(): Promise<{ installed: boolean; proxyReachable: boolean; status?: number; baseUrl: string }> {
    const installed = await ensureHeadroom();
    const ping = await pingHeadroomProxy();
    return { installed, proxyReachable: ping.reachable, status: ping.status, baseUrl: HEADROOM_BASE_URL };
}

/**
 * A snapshot of the proxy's cumulative session counters, read from its `/stats` route
 * (the same route the headroom-ai client's `getStats()` uses). The server emits
 * snake_case; the client normally camelCases it, so we read BOTH spellings. Used to
 * compute a per-turn savings delta for the trace: (after − before).
 */
export interface ProxyStatsSnapshot {
    totalRequests: number;
    totalTokensBefore: number;
    totalTokensAfter: number;
    totalTokensSaved: number;
}

/**
 * GET the local Headroom proxy's `/stats` (cumulative SessionStats). Never throws —
 * resolves to null on any error (proxy down, bad JSON, unexpected shape) so the caller
 * degrades to "stats unavailable" rather than failing. Local-proxy only.
 */
export function fetchProxyStats(timeoutMs = 1000): Promise<ProxyStatsSnapshot | null> {
    return new Promise((resolvePromise) => {
        let settled = false;
        const done = (v: ProxyStatsSnapshot | null) => {
            if (settled) { return; }
            settled = true;
            resolvePromise(v);
        };
        try {
            const req = httpGet(`${HEADROOM_BASE_URL}/stats`, (res) => {
                if ((res.statusCode ?? 0) >= 400) { res.resume(); done(null); return; }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { body += c; if (body.length > 1_000_000) { req.destroy(); done(null); } });
                res.on('end', () => {
                    try {
                        const j: any = JSON.parse(body);
                        // Read a finite number from the first key that has one; 0 otherwise.
                        const pick = (obj: any, ...keys: string[]): number | undefined => {
                            for (const k of keys) {
                                const val = obj?.[k];
                                if (typeof val === 'number' && isFinite(val)) { return val; }
                            }
                            return undefined;
                        };
                        // v0.2.0 shape is NESTED: { requests: { total }, tokens: { input, output, saved, savings_percent } }.
                        // There `tokens.input` is the POST-compression count and `tokens.saved` the delta, so the
                        // pre-compression total is input + saved. Older/flat builds expose `totalTokens*` at top level.
                        const tks = j?.tokens ?? {};
                        const reqs = j?.requests ?? {};
                        const nestedAfter = pick(tks, 'input');
                        const nestedSaved = pick(tks, 'saved');
                        const nestedReq = pick(reqs, 'total');
                        const flatAfter = pick(j, 'totalTokensAfter', 'total_tokens_after');
                        const flatSaved = pick(j, 'totalTokensSaved', 'total_tokens_saved');
                        const flatBefore = pick(j, 'totalTokensBefore', 'total_tokens_before');
                        const after = nestedAfter ?? flatAfter ?? 0;
                        const saved = nestedSaved ?? flatSaved ?? 0;
                        const before = flatBefore ?? ((nestedAfter !== undefined || nestedSaved !== undefined) ? after + saved : 0);
                        done({
                            totalRequests: nestedReq ?? pick(j, 'totalRequests', 'total_requests') ?? 0,
                            totalTokensBefore: before,
                            totalTokensAfter: after,
                            totalTokensSaved: saved,
                        });
                    } catch { done(null); }
                });
            });
            req.setTimeout(timeoutMs, () => { req.destroy(); done(null); });
            req.on('error', () => done(null));
        } catch {
            done(null);
        }
    });
}
