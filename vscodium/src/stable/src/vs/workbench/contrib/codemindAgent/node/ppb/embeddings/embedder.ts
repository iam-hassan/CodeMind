/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * BGE-M3 embedding client (P1-T07, spec §14.1/§14.4).
 *
 * Calls an OpenAI-compatible `/embeddings` endpoint. The model is fixed to BGE-M3 (§14.1) but the
 * endpoint/model stay configurable (OD-2/technical stack). Every returned vector is validated
 * against the pinned dimension (`PPB_EMBEDDING_DIM`) so a misconfigured model fails loudly rather
 * than corrupting the pgvector column.
 */

import { loadPpbConfig, PPB_EMBEDDING_DIM, type PpbConfig } from '../config.js';
import type { FetchLike } from '../llm/client.js';

export class EmbeddingError extends Error {
	constructor(message: string, readonly code: 'http' | 'malformed-response' | 'dimension-mismatch' | 'network') {
		super(message);
		this.name = 'EmbeddingError';
	}
}

export interface EmbeddingClient {
	readonly model: string;
	readonly dimension: number;
	/** One vector per input text, same order. */
	embed(texts: readonly string[]): Promise<number[][]>;
}

export interface OpenAiCompatibleEmbeddingOptions {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey?: string;
	readonly dimension?: number;
	readonly fetchImpl?: FetchLike;
}

export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {

	readonly model: string;
	readonly dimension: number;
	private readonly _baseUrl: string;
	private readonly _apiKey: string;
	private readonly _fetchImpl: FetchLike | undefined;

	constructor(options: OpenAiCompatibleEmbeddingOptions) {
		this.model = options.model;
		this.dimension = options.dimension ?? PPB_EMBEDDING_DIM;
		this._baseUrl = options.baseUrl.replace(/\/+$/, '');
		this._apiKey = options.apiKey ?? '';
		this._fetchImpl = options.fetchImpl;
	}

	async embed(texts: readonly string[]): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}
		const doFetch = this._fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
		if (typeof doFetch !== 'function') {
			throw new EmbeddingError('no fetch implementation available', 'network');
		}
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this._apiKey) {
			headers['Authorization'] = `Bearer ${this._apiKey}`;
		}
		let response: { ok: boolean; status: number; json(): Promise<unknown> };
		try {
			response = await doFetch(`${this._baseUrl}/embeddings`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ model: this.model, input: [...texts] })
			});
		} catch (error) {
			throw new EmbeddingError(`embedding request failed: ${error instanceof Error ? error.message : String(error)}`, 'network');
		}
		if (!response.ok) {
			throw new EmbeddingError(`embedding request returned HTTP ${response.status}`, 'http');
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new EmbeddingError(`embedding response was not JSON: ${error instanceof Error ? error.message : String(error)}`, 'malformed-response');
		}
		const data = (payload as { data?: Array<{ embedding?: unknown }> })?.data;
		if (!Array.isArray(data) || data.length !== texts.length) {
			throw new EmbeddingError('embedding response did not contain one vector per input', 'malformed-response');
		}
		return data.map((entry, index) => {
			const vector = entry?.embedding;
			if (!Array.isArray(vector) || !vector.every(value => typeof value === 'number')) {
				throw new EmbeddingError(`embedding ${index} is not a numeric vector`, 'malformed-response');
			}
			if (vector.length !== this.dimension) {
				throw new EmbeddingError(
					`embedding ${index} has dimension ${vector.length}, expected ${this.dimension} (pin with PPB_EMBEDDING_DIM)`,
					'dimension-mismatch'
				);
			}
			return vector as number[];
		});
	}
}

export function createEmbeddingClient(config: PpbConfig = loadPpbConfig()): EmbeddingClient {
	return new OpenAiCompatibleEmbeddingClient({
		baseUrl: config.embedBaseUrl,
		model: config.embedModel,
		apiKey: config.embedApiKey,
		dimension: PPB_EMBEDDING_DIM
	});
}