/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal OpenAI-compatible chat client (P1-T04, spec §7.6).
 *
 * Extraction calls an OpenAI-compatible model endpoint whose base URL, model and (optional) key
 * come from configuration — never hard-coded (OD-6, spec §32). The transport is injected so the
 * engine stays unit-testable without a network.
 */

export type LlmClientErrorCode = 'http' | 'malformed-response' | 'network' | 'timeout';

export class LlmClientError extends Error {
	constructor(message: string, readonly code: LlmClientErrorCode) {
		super(message);
		this.name = 'LlmClientError';
	}
}

export interface LlmChatRequest {
	readonly system: string;
	readonly user: string;
	readonly temperature?: number;
	readonly timeoutMs?: number;
	/** Response ceiling. Only sent when set; reasoning models need headroom for `thinking`. PLACEHOLDER. */
	readonly maxTokens?: number;
}

export interface LlmChatResult {
	/** The assistant message content (expected to be a JSON object for extraction). */
	readonly text: string;
}

export interface LlmClient {
	/** The model id this client is pinned to (configurable, specs §7.6/OD-6). */
	readonly model: string;
	chat(request: LlmChatRequest): Promise<LlmChatResult>;
}

/** Minimal fetch shape — avoids depending on DOM/undici typings in the workbench build. */
export type FetchLike = (
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OpenAiCompatibleOptions {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey?: string;
	/** Request ceiling — PLACEHOLDER pending real measurement (spec §26/§32). */
	readonly timeoutMs?: number;
	readonly fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class OpenAiCompatibleClient implements LlmClient {

	constructor(private readonly _options: OpenAiCompatibleOptions) { }

	get model(): string {
		return this._options.model;
	}

	async chat(request: LlmChatRequest): Promise<LlmChatResult> {
		const doFetch = this._options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
		if (typeof doFetch !== 'function') {
			throw new LlmClientError('no fetch implementation available', 'network');
		}
		const url = `${this._options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this._options.apiKey) {
			headers['Authorization'] = `Bearer ${this._options.apiKey}`;
		}
		const body = JSON.stringify({
			model: this._options.model,
			temperature: request.temperature ?? 0,
			...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: request.system },
				{ role: 'user', content: request.user }
			]
		});

		let response: { ok: boolean; status: number; json(): Promise<unknown> };
		const controller = new AbortController();
		const timeoutMs = request.timeoutMs ?? this._options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			response = await doFetch(url, { method: 'POST', headers, body, signal: controller.signal });
		} catch (error) {
			const aborted = error instanceof Error && error.name === 'AbortError';
			throw new LlmClientError(
				aborted
					? `chat request timed out after ${timeoutMs} ms`
					: `chat request failed: ${error instanceof Error ? error.message : String(error)}`,
				aborted ? 'timeout' : 'network'
			);
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) {
			throw new LlmClientError(`chat request returned HTTP ${response.status}`, 'http');
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new LlmClientError(`chat response was not JSON: ${error instanceof Error ? error.message : String(error)}`, 'malformed-response');
		}
		const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
			?.choices?.[0]?.message?.content;
		if (typeof content !== 'string') {
			throw new LlmClientError('chat response contained no message content', 'malformed-response');
		}
		return { text: content };
	}
}

export function createExtractionClient(baseUrl: string, model: string, apiKey: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): LlmClient {
	return new OpenAiCompatibleClient({ baseUrl, model, apiKey, timeoutMs });
}
