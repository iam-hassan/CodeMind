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
import type { GraphRelationship, GraphRepository } from '../graph/graphRepo.js';
import type { MemoryCategory } from '../ontology.js';
import { redact } from '../redact.js';
import { getFacts, type ReadQueryable } from '../storage/read.js';
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

/** Memory ids are uuids — the graph can also surface structural (non-uuid) nodes to skip. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Direction labels for the impact edges surfaced into the injection block (D57). */
const RELATION_OUT_LABEL: Readonly<Record<string, string>> = {
	DEPENDS_ON: 'depends on', AFFECTS: 'affects', USES: 'uses', HOSTED_ON: 'hosted on'
};
const RELATION_IN_LABEL: Readonly<Record<string, string>> = {
	DEPENDS_ON: 'required by', AFFECTS: 'affected by', USES: 'used by', HOSTED_ON: 'hosts'
};

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
				return await this._withGlobalPreferences(projectId, cached);
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
			const candidates = await hybridRetrieve(this._deps, projectId, queryEmbedding, { maxResults, queryText: typeof query === 'string' ? query : undefined });
			const ranked = rank(candidates, {
				intent: (req as { intent?: string }).intent,
				openFiles: (req as { openFiles?: readonly string[] }).openFiles,
				currentTask: typeof query === 'string' ? query : undefined
			}, { weights: this._profile.weights, topK: maxResults });

			// D57 — resolve the graph impact edges of the ranked memories into related content so
			// multi-hop "what is affected if X changes?" questions are answerable. Best-effort.
			const relatedById = await this._related(projectId, ranked.map(entry => entry.fact.id));

			// §8 — redact credential-shaped content before it can be cached or injected.
			const mapped = ranked.map(entry => {
				const related = relatedById.get(entry.fact.id);
				return {
					id: entry.fact.id,
					content: redact(entry.fact.content),
					score: entry.score,
					category: CATEGORY_TO_RETRIEVED[entry.fact.category],
					sourceRef: entry.fact.sourceRef,
					projectId,
					author: entry.fact.author,
					extractedAt: entry.fact.extractedAt,
					...(related && related.length > 0 ? { related } : {})
				};
			});
			const result = applyTokenBudget(mapped, (req as { maxTokenBudget?: unknown }).maxTokenBudget);
			if (cache && signature) {
				await this._cacheSet(cache, projectId, signature, result);
			}
			return await this._withGlobalPreferences(projectId, result);
		} catch {
			return [];
		}
	}

	/**
	 * §6.6 — global developer preferences are available in **every** project. They are read from the
	 * shared `Preference` store (never from this project's `memories`, so they never appear in
	 * project-scoped knowledge) and prepended so they always reach the injection block. Best-effort:
	 * a graph without `retrievePreferences` is skipped and any failure degrades to no globals.
	 */
	private async _withGlobalPreferences(projectId: string, facts: RetrievedFact[]): Promise<RetrievedFact[]> {
		const globals = await this._globalPreferences(projectId);
		if (globals.length === 0) {
			return facts;
		}
		const seen = new Set(globals.map(fact => fact.id));
		return [...globals, ...facts.filter(fact => !seen.has(fact.id))];
	}

	private async _globalPreferences(projectId: string): Promise<RetrievedFact[]> {
		const graph = this._deps.graph as GraphRepository & {
			retrievePreferences?: (projectId: string) => Promise<Array<{ id: string; properties?: Record<string, unknown> }>>;
		};
		if (typeof graph.retrievePreferences !== 'function') {
			return [];
		}
		try {
			const nodes = await graph.retrievePreferences(projectId);
			const out: RetrievedFact[] = [];
			for (const node of nodes) {
				const props = node.properties ?? {};
				if (props.scope !== 'global') {
					continue;
				}
				const text = typeof props.content === 'string' ? props.content
					: (typeof props.description === 'string' ? props.description : '');
				if (text.length === 0) {
					continue;
				}
				out.push({
					id: String(node.id),
					content: redact(`(global preference) ${text}`),
					score: 1,
					category: 'convention',
					projectId,
					sourceRef: 'global-preference'
				});
			}
			return out;
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

	/**
	 * D57 — map each ranked memory id to the content of the impact-related memories it points at
	 * (outgoing) or that point at it (incoming). One graph query for the whole ranked set plus one
	 * batched read of the neighbour contents. Every failure degrades to "no relations" and never
	 * breaks retrieval (§24). A graph implementation without `relationshipsForSeeds` is skipped, so
	 * lightweight test doubles keep working.
	 */
	private async _related(projectId: string, ids: readonly string[]): Promise<Map<string, Array<{ type: string; content: string }>>> {
		const out = new Map<string, Array<{ type: string; content: string }>>();
		const graph = this._deps.graph as GraphRepository & {
			relationshipsForSeeds?: (projectId: string, seedIds: readonly string[]) => Promise<GraphRelationship[]>;
		};
		if (typeof graph.relationshipsForSeeds !== 'function') {
			return out;
		}
		const seedIds = ids.filter(id => UUID_RE.test(id));
		if (seedIds.length === 0) {
			return out;
		}
		try {
			const relationships = await graph.relationshipsForSeeds(projectId, seedIds);
			if (relationships.length === 0) {
				return out;
			}
			const neighbourIds = [...new Set(relationships.flatMap(rel => [rel.fromId, rel.toId]))].filter(id => UUID_RE.test(id));
			const loaded = await getFacts(this._deps.read, projectId, neighbourIds);
			const contentOf = (id: string): string | undefined => loaded.get(id)?.content;

			const perFact = new Map<string, Array<{ type: string; content: string }>>();
			const push = (owner: string, other: string, label: (type: string) => string, type: string): void => {
				const text = contentOf(other);
				if (!text) {
					return;
				}
				const list = perFact.get(owner) ?? [];
				list.push({ type: label(type), content: redact(text) });
				perFact.set(owner, list);
			};
			for (const rel of relationships) {
				push(rel.fromId, rel.toId, type => RELATION_OUT_LABEL[type] ?? type.toLowerCase(), rel.type);
				push(rel.toId, rel.fromId, type => RELATION_IN_LABEL[type] ?? `incoming ${type.toLowerCase()}`, rel.type);
			}
			// Deterministic order + de-duplication so the injected block is stable across runs.
			for (const [id, list] of perFact) {
				if (!seedIds.includes(id)) {
					continue;
				}
				const seen = new Set<string>();
				const unique = list
					.filter(entry => { const key = `${entry.type}|${entry.content}`; if (seen.has(key)) { return false; } seen.add(key); return true; })
					.sort((a, b) => a.type.localeCompare(b.type) || a.content.localeCompare(b.content));
				if (unique.length > 0) {
					out.set(id, unique);
				}
			}
		} catch {
			/* relations are best-effort (§24) */
		}
		return out;
	}
}
