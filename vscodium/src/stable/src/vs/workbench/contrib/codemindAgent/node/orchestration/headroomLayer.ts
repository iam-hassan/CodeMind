/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OptimizedContext, CompressedContext, CompressionMode } from './types.js';

/**
 * Headroom Compression Layer (Section 7)
 * Dynamic import of headroom-ai from the sibling claude-code/ tree.
 */

let _headroomCompress: ((msgs: any[], opts: any) => Promise<any[]>) | null = null;
let _headroomAvailable: boolean | null = null; // null = not yet checked

export async function prewarmHeadroom(): Promise<void> {
    if (_headroomAvailable !== null) return;
    try {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const headroomPath = resolve(__dirname, '../../../../../../claude-code/node_modules/headroom-ai/dist/index.js');
        const mod = await import(headroomPath);
        _headroomCompress = mod.compress || mod.default?.compress;
        _headroomAvailable = typeof _headroomCompress === 'function';
    } catch {
        _headroomAvailable = false;
    }
}

async function loadHeadroom(): Promise<boolean> {
    if (_headroomAvailable !== null) return _headroomAvailable;
    await prewarmHeadroom();
    return _headroomAvailable ?? false;
}

export function shouldCompress(estimatedTokens: number): CompressionMode {
    if (estimatedTokens < 2000) return 'none';
    if (estimatedTokens < 8000) return 'light';
    return 'aggressive';
}

export async function compressContext(
    optimized: OptimizedContext,
    model: string,
    _token: any
): Promise<CompressedContext> {
    const mode = shouldCompress(optimized.estimatedTokens);
    if (mode === 'none') {
        return {
            context: null,
            estimatedTokens: optimized.estimatedTokens,
            mode,
            headroomAvailable: false,
        };
    }

    const available = await loadHeadroom();
    if (!available || !_headroomCompress) {
        return {
            context: optimized.serializedContext,
            estimatedTokens: optimized.estimatedTokens,
            mode: 'none',
            headroomAvailable: false,
        };
    }

    try {
        const result = await _headroomCompress(
            [{ role: 'user', content: optimized.serializedContext }],
            { model }
        );
        const compressed = result?.[0]?.content || optimized.serializedContext;
        const ratio = compressed.length / optimized.serializedContext.length;
        return {
            context: compressed,
            estimatedTokens: Math.floor(compressed.length / 4),
            mode,
            headroomAvailable: true,
            compressionRatio: ratio,
        };
    } catch {
        return {
            context: optimized.serializedContext,
            estimatedTokens: optimized.estimatedTokens,
            mode: 'none',
            headroomAvailable: false,
        };
    }
}
