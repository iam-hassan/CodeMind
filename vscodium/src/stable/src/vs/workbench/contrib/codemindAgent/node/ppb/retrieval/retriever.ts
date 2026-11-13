/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The PPB retriever service (P1-T08/T09/T14, IF-5 → IF-6, spec §15/§16).
 *
 * Implements the vscodium `IProjectBrainRetriever` contract that Part 2 calls: embed the query
 * (when an embedding client is available), hybrid-retrieve, rank, and return the ranked memory
 * list. It never throws — retrieval failure degrades to an empty list so a chat turn is never
 * broken (§24). Category projection maps the six knowledge categories onto Part 2's
 * `RetrievedFact` categories (`decision`/`pattern`/`fact`/`convention`).
 *
 * Two spec guarantees live here:
 *  - `maxTokenBudget` is enforced on the returned list (§8 "respects a token budget").
 *  - results are served from the IF-12 ranked-result cache when one is configured, with a
 *    direct-query fallback when the cache is unavailable (§8/§10).
 */

import type { IProjectBrainRetriever, RetrievalRequest, RetrievedFact } from '../../orchestration/retrievalRequest.js';
import type { EmbeddingClient } from '../embeddings/embedder.js';
import type { GraphRepository } from '../graph/graphRepo.js';
import type { MemoryCategory } from '../ontology.js';
import { redact } from '../redact.js';
import type { ReadQueryable } from '../storage/read.js';
import { retrievalCacheSignature, type RetrievalCache } from '../storage/redis.js';
import { hybridRetrieve } from './hybrid.js';
import { rank, type RankingWeights } from './ranker.js';
import { defaultWeightProfile, mergeWeightProfile, type RankingWeightProfile } from './weightProfile.js';

/** Knowledge category → Part 2's retrieval category (implementation decision, §18.5). */
export const CATEGORY_TO_RETRIEVED: Readonly<Record<MemoryCategory, RetrievedFact['category']>> = {
	technology_stack: 'fact',
	architecture_patterns: 'pattern',
	business_rules: 'fact',
	engineering_standards: 'convention',
	constraints: 'fact',
	developer_preferences: 'convention'
};

/** chars-per-token heuristic shared with the headroom/injection layer (spec §8). */
export const TOKENS_PER_CHAR = 1 / 4;

/**
 * Fixed allowance for the rendered bullet (`• Category: … (score 0.93)\n`) that the injection
 * layer adds around the raw content. Counting it here means the final injected block cannot
 * exceed the caller's budget merely because of framing.
 */
export const FACT_LINE_OVERHEAD_CHARS = 40;

/** Estimated tokens for one fact; `chars/4` plus the rendered-line framing. */
export function estimateFactTokens(fact: Pick<RetrievedFact, 'content'>): number {
	return Math.ceil(((typeof fact.content === 'string' ? fact.content.length : 0) + FACT_LINE_OVERHEAD_CHARS) * TOKENS_PER_CHAR);
}

/**
 * Trim a ranked list to a token budget. Order is preserved (highest score first) and the first
 * fact that would overflow stops the list — matching the injection layer's drop policy so the
 * two layers cannot disagree about what "fits".
 *
 * A missing, non-finite or non-positive budget means "no budget" (the caller did not set one).
 */
export function applyTokenBudget(facts: readonly RetrievedFact[], maxTokenBudget: unknown): RetrievedFact[] {
	const budget = Number(maxTokenBudget);
	if (!Number.isFinite(budget) || budget <= 0) {
		return [...facts];
	}
	const kept: RetrievedFact[] = [];
	let used = 0;
	for (const fact of facts) {
		const cost = estimateFactTokens(fact);
		if (used + cost > budget) {
			break;
		}
		kept.push(fact);
		used += cost;
	}
	return kept;
}

export interface RetrieverDeps {
	readonly read: ReadQueryable;
	readonly graph: GraphRepository;
	/** Optional — without it retrieval degrades to graph-only (empty seeds → empty result). */
	readonly embedding?: EmbeddingClient;
	/** Optional weight overrides (T14 tuning). */
	readonly weights?: Partial<RankingWeights>;
	/** Optional IF-12 ranked-result cache; failure always degrades to a direct query. */
	readonly cache?: RetrievalCache;
}

export class PpbRetriever implements IProjectBrainRetriever {

	/** The tunable profile Part 3 adjusts via the published surface (P1-T14, §16.7). */
	private _profile: RankingWeightProfile;

	constructor(private readonly _deps: RetrieverDeps) {
		this._profile = mergeWeightProfile(defaultWeightProfile(), _deps.weights ?? {});
	}

	/** The current weight profile (read-only snapshot). */
	get weightProfile(): RankingWeightProfile {
		return { version: this._profile.version, weights: { ...this._profile.weights }, topK: this._profile.topK };
	}

	/** Adjust ranking weights/top-k (Part 3 tuning). Throws `WeightProfileError` on invalid input. */
	configureWeights(overrides: Partial<RankingWeights> & { readonly topK?: number } = {}): RankingWeightProfile {
		this._profile = mergeWeightProfile(this._profile, overrides);
		return this.weightProfile;
	}

	async retrieve(req: RetrievalRequest): Promise<RetrievedFact[]> {
		const projectId = (req as { projectId?: unknown })?.projectId;
		if (typeof projectId !== 'string' || projectId.length === 0) {
			return [];
		}

		// IF-12: the cache is upstream of the query work; an unusable cache is simply skipped.
		const cache = this._deps.cache;
		let signature: string | undefined;
		if (cache) {
			signature = retrievalCacheSignature(req, this.weightProfile);
			const cached = await this._cacheGet(cache, projectId, signature);
			if (cached !== undefined) {
				return cached;
			}
		}

		try {
			let queryEmbedding: number[] | undefined;
			const query = (req as { query?: unknown }).query;
			if (this._deps.embedding && typeof query === 'string' && query.length > 0) {
				try {
					const [vector] = await this._deps.embedding.embed([query]);
					queryEmbedding = vector;
				} catch {
					queryEmbedding = undefined; // §14.8 / §24 — never break retrieval on embedding failure
				}
			}

			const maxResults = Number((req as { maxResults?: unknown }).maxResults) || this._profile.topK;
			const candidates = await hybridRetrieve(this._deps, projectId, queryEmbedding, { maxResults });
			const ranked = rank(candidates, {
				intent: (req as { intent?: string }).intent,
				openFiles: (req as { openFiles?: readonly string[] }).openFiles,
				currentTask: typeof query === 'string' ? query : undefined
			}, { weights: this._profile.weights, topK: maxResults });

			// §8 — redact credential-shaped content before it can be cached or injected.
			const mapped = ranked.map(entry => ({
				id: entry.fact.id,
				content: redact(entry.fact.content),
				score: entry.score,
				category: CATEGORY_TO_RETRIEVED[entry.fact.category],
				sourceRef: entry.fact.sourceRef,
				projectId
			}));
			const result = applyTokenBudget(mapped, (req as { maxTokenBudget?: unknown }).maxTokenBudget);
			if (cache && signature) {
				await this._cacheSet(cache, projectId, signature, result);
			}
			return result;
		} catch {
			return [];
		}
	}

	private async _cacheGet(cache: RetrievalCache, projectId: string, signature: string): Promise<RetrievedFact[] | undefined> {
		try {
			const cached = await cache.get(projectId, signature);
			// Defensive: never serve a foreign project's facts even if a cache implementation misbehaves.
			if (cached !== undefined && cached.every(fact => fact.projectId === projectId)) {
				return cached;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	private async _cacheSet(cache: RetrievalCache, projectId: string, signature: string, facts: readonly RetrievedFact[]): Promise<void> {
		try {
			await cache.set(projectId, signature, facts);
		} catch {
			/* cache writes are best-effort (§9.4) */
		}
	}
}
