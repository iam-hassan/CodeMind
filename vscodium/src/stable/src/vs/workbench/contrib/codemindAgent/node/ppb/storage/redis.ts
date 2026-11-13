/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ranked-result cache (IF-12, spec §8 retrieval performance, §10 resilience).
 *
 * A read-through cache for `PpbRetriever` results. It is strictly best-effort: Redis being down,
 * slow, misconfigured or returning a corrupt/foreign entry always degrades to the direct query
 * path and never throws into retrieval (§9.4/§24).
 *
 * Key schema (versioned so a format change is a clean miss):
 *   version  ppb:retrieval:v1:version:<projectId>          — invalidation counter
 *   entry    ppb:retrieval:v1:<projectId>:<version>:<hash> — JSON array of RetrievedFact
 *
 * Invalidation is O(1) per project: bumping the version counter makes every older entry
 * unreachable, and the TTL reclaims the storage. Entries are tagged with their projectId and are
 * rejected on read when they do not match, so a polluted/stale key can never leak across projects.
 */

import { createHash } from 'crypto';
import type { RetrievalRequest, RetrievedFact } from '../../orchestration/retrievalRequest.js';
import type { PpbConfig } from '../config.js';
import { redact } from '../redact.js';

/** Cache format version. Include in every key so a shape change cannot read old values. */
export const RETRIEVAL_CACHE_VERSION = 'v1';

/** Redis key namespace for ranked retrieval results. */
export const RETRIEVAL_CACHE_PREFIX = 'ppb:retrieval';

const NOOP_CACHE: RetrievalCache = {
	enabled: false,
	async get() { return undefined; },
	async set() { /* no-op */ },
	async invalidate() { /* no-op */ },
	async close() { /* no-op */ }
};

/** The minimal Redis surface the cache needs (satisfied by `ioredis`; fake in unit tests). */
export interface RedisLike {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
	incr(key: string): Promise<number>;
	expire(key: string, seconds: number): Promise<number>;
	quit?(): Promise<unknown>;
	disconnect?(): void;
}

export interface RetrievalCache {
	/** False when the cache is disabled or has degraded; callers may skip the read entirely. */
	readonly enabled: boolean;
	get(projectId: string, signature: string): Promise<RetrievedFact[] | undefined>;
	set(projectId: string, signature: string, facts: readonly RetrievedFact[]): Promise<void>;
	/** Drop every cached result for a project (called after a write/supersede). */
	invalidate(projectId: string): Promise<void>;
	close(): Promise<void>;
}

/** The cache used when Redis is disabled or unavailable. */
export const NoopRetrievalCache: RetrievalCache = NOOP_CACHE;

/** `ppb:retrieval:v1:version:<projectId>` — incremented by `invalidate`. */
export function retrievalCacheVersionKey(projectId: string): string {
	return `${RETRIEVAL_CACHE_PREFIX}:${RETRIEVAL_CACHE_VERSION}:version:${projectId}`;
}

/** `ppb:retrieval:v1:<projectId>:<version>:<hash>` — one ranked result list. */
export function retrievalCacheEntryKey(projectId: string, version: number, signature: string): string {
	return `${RETRIEVAL_CACHE_PREFIX}:${RETRIEVAL_CACHE_VERSION}:${projectId}:${version}:${signature}`;
}

/**
 * Deterministic request signature. Everything that can change the ranked output is included:
 * query, intent, open files, recent turns, result/token caps and the active weight profile.
 */
export function retrievalCacheSignature(
	req: RetrievalRequest,
	// `object` rather than `Record<string, number>`: `RankingSignals` is an interface, so it has no
	// implicit index signature. The value is only serialised into the signature, never indexed.
	profile?: { readonly version: string; readonly weights: object; readonly topK: number }
): string {
	const sortedOpenFiles = [...(req.openFiles ?? [])].map(String).sort();
	const turns = (req.recentTurns ?? []).map(turn => `${turn.role}:${turn.content}`);
	const payload = {
		version: RETRIEVAL_CACHE_VERSION,
		query: typeof req.query === 'string' ? req.query : '',
		intent: typeof req.intent === 'string' ? req.intent : '',
		openFiles: sortedOpenFiles,
		recentTurns: turns,
		maxResults: Number.isFinite(Number(req.maxResults)) ? Number(req.maxResults) : 0,
		maxTokenBudget: Number.isFinite(Number(req.maxTokenBudget)) ? Number(req.maxTokenBudget) : 0,
		profile: profile ?? null
	};
	return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Validate a cached payload; a malformed or cross-project entry is treated as a miss. */
function parseCachedFacts(raw: string, projectId: string): RetrievedFact[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) {
		return undefined;
	}
	const facts: RetrievedFact[] = [];
	for (const entry of parsed) {
		if (entry === null || typeof entry !== 'object') {
			return undefined;
		}
		const value = entry as Record<string, unknown>;
		if (value.projectId !== projectId) {
			return undefined;
		}
		if (typeof value.id !== 'string' || typeof value.content !== 'string' || typeof value.score !== 'number') {
			return undefined;
		}
		const category = value.category;
		if (category !== 'decision' && category !== 'pattern' && category !== 'fact' && category !== 'convention') {
			return undefined;
		}
		facts.push({
			id: value.id,
			content: value.content,
			score: value.score,
			category,
			sourceRef: typeof value.sourceRef === 'string' ? value.sourceRef : undefined,
			projectId
		});
	}
	return facts;
}

export interface RedisRetrievalCacheOptions {
	readonly url: string;
	readonly ttlSeconds: number;
	/** Injected client for tests; the production path lazily imports `ioredis`. */
	readonly client?: RedisLike;
	readonly log?: (message: string) => void;
}

/**
 * Redis-backed ranked-result cache with a circuit breaker: once a command fails the cache disables
 * itself for the process (a broken Redis must not add latency to every turn).
 */
export class RedisRetrievalCache implements RetrievalCache {

	private _client: RedisLike | undefined;
	private _degraded = false;
	private _connecting: Promise<RedisLike | undefined> | undefined;

	constructor(private readonly _options: RedisRetrievalCacheOptions) {
		this._client = this._options.client;
	}

	get enabled(): boolean {
		return !this._degraded && typeof this._options.url === 'string' && this._options.url.length > 0;
	}

	async get(projectId: string, signature: string): Promise<RetrievedFact[] | undefined> {
		if (!this.enabled) {
			return undefined;
		}
		try {
			const client = await this._redis();
			if (!client) {
				return undefined;
			}
			const version = await this._version(client, projectId);
			const raw = await client.get(retrievalCacheEntryKey(projectId, version, signature));
			return raw === null ? undefined : parseCachedFacts(raw, projectId);
		} catch (error) {
			this._degrade('read', error);
			return undefined;
		}
	}

	async set(projectId: string, signature: string, facts: readonly RetrievedFact[]): Promise<void> {
		if (!this.enabled) {
			return;
		}
		try {
			const client = await this._redis();
			if (!client) {
				return;
			}
			const version = await this._version(client, projectId);
			await client.set(
				retrievalCacheEntryKey(projectId, version, signature),
				JSON.stringify(facts),
				'EX',
				this._options.ttlSeconds
			);
		} catch (error) {
			this._degrade('write', error);
		}
	}

	async invalidate(projectId: string): Promise<void> {
		if (!this.enabled || typeof projectId !== 'string' || projectId.length === 0) {
			return;
		}
		try {
			const client = await this._redis();
			if (!client) {
				return;
			}
			const key = retrievalCacheVersionKey(projectId);
			await client.incr(key);
			// Keep the counter well beyond the entry TTL so an idle project does not reset to 0.
			await client.expire(key, Math.max(this._options.ttlSeconds * 10, 3_600));
		} catch (error) {
			this._degrade('invalidate', error);
		}
	}

	async close(): Promise<void> {
		const client = this._client;
		this._client = undefined;
		if (!client) {
			return;
		}
		try {
			if (typeof client.quit === 'function') {
				await client.quit();
			} else {
				client.disconnect?.();
			}
		} catch {
			/* closing is best-effort */
		}
	}

	private async _version(client: RedisLike, projectId: string): Promise<number> {
		const raw = await client.get(retrievalCacheVersionKey(projectId));
		const parsed = Number.parseInt(raw ?? '', 10);
		return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
	}

	private async _redis(): Promise<RedisLike | undefined> {
		if (this._client) {
			return this._client;
		}
		if (!this._connecting) {
			this._connecting = this._createClient();
		}
		return this._connecting;
	}

	private async _createClient(): Promise<RedisLike | undefined> {
		try {
			// Lazy import: the cache is optional, so module load must not require Redis at startup.
			const module = await import('ioredis') as unknown as {
				Redis?: new (url: string, options: Record<string, unknown>) => RedisLike & { connect?: () => Promise<unknown>; on?: (event: string, listener: (...args: unknown[]) => void) => unknown };
				default?: { Redis?: new (url: string, options: Record<string, unknown>) => RedisLike & { connect?: () => Promise<unknown>; on?: (event: string, listener: (...args: unknown[]) => void) => unknown } };
			};
			const RedisConstructor = module.Redis ?? module.default?.Redis ?? (module.default as unknown as typeof module.Redis);
			if (typeof RedisConstructor !== 'function') {
				this._degrade('connect', new Error('ioredis did not expose a Redis constructor'));
				return undefined;
			}
			const client = new RedisConstructor(this._options.url, {
				lazyConnect: true,
				enableOfflineQueue: false,
				maxRetriesPerRequest: 1,
				connectTimeout: 1_500,
				retryStrategy: () => null
			});
			// Without a listener an ioredis 'error' event is an uncaught exception.
			client.on?.('error', () => { /* handled by the failing command */ });
			await client.connect?.();
			this._client = client;
			return client;
		} catch (error) {
			this._degrade('connect', error);
			return undefined;
		}
	}

	private _degrade(operation: string, error: unknown): void {
		if (!this._degraded) {
			this._degraded = true;
			try {
				this._options.log?.(`ppb: retrieval cache ${operation} failed; continuing without cache: ${redact(error instanceof Error ? error.message : String(error))}`);
			} catch {
				/* logging must never break retrieval */
			}
		}
	}
}

/** Build the cache for the runtime configuration (Noop when Redis is disabled/unset). */
export function createRetrievalCache(config: PpbConfig, log?: (message: string) => void): RetrievalCache {
	if (config.redisCacheEnabled === false || !config.redisUrl) {
		return NoopRetrievalCache;
	}
	return new RedisRetrievalCache({
		url: config.redisUrl,
		ttlSeconds: config.redisCacheTtlSeconds,
		log
	});
}
