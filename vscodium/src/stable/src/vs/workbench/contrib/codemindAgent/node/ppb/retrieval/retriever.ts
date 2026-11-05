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
 */

import type { IProjectBrainRetriever, RetrievalRequest, RetrievedFact } from '../../orchestration/retrievalRequest.js';
import type { EmbeddingClient } from '../embeddings/embedder.js';
import type { GraphRepository } from '../graph/graphRepo.js';
import type { MemoryCategory } from '../ontology.js';
import type { ReadQueryable } from '../storage/read.js';
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

export interface RetrieverDeps {
	readonly read: ReadQueryable;
	readonly graph: GraphRepository;
	/** Optional — without it retrieval degrades to graph-only (empty seeds → empty result). */
	readonly embedding?: EmbeddingClient;
	/** Optional weight overrides (T14 tuning). */
	readonly weights?: Partial<RankingWeights>;
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

			return ranked.map(entry => ({
				id: entry.fact.id,
				content: entry.fact.content,
				score: entry.score,
				category: CATEGORY_TO_RETRIEVED[entry.fact.category],
				sourceRef: entry.fact.sourceRef,
				projectId
			}));
		} catch {
			return [];
		}
	}
}