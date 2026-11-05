/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Hybrid retrieval (C1.3, P1-T08, spec §15).
 *
 * Combines the vector (semantic) seed set with one-hop graph expansion and fuses them into a
 * single de-duplicated candidate list for the Ranking Engine (§15.6–§15.8). Both paths are
 * project-scoped at the query level (§15.9), and every candidate keeps its full metadata (§15.10).
 */

import type { GraphRepository } from '../graph/graphRepo.js';
import { searchFactsByVector } from '../embeddings/vectorStore.js';
import { getFact, type MemoryRecord, type ReadQueryable } from '../storage/read.js';

export type CandidateSource = 'vector' | 'graph';

export interface RetrievalCandidate {
	readonly fact: MemoryRecord;
	/** Cosine similarity when the candidate came from the vector path. */
	readonly similarity?: number;
	readonly sources: readonly CandidateSource[];
}

export interface HybridDeps {
	readonly read: ReadQueryable;
	readonly graph: GraphRepository;
}

export interface HybridOptions {
	/** PLACEHOLDER bound (spec §26/§32). */
	readonly maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 8;

/**
 * Graph expansion returns structural nodes too (the Project node, synthetic technology nodes)
 * whose ids are not memory ids. Loading one must be skipped, never abort the whole retrieval:
 * `getFact` binds `id` to a uuid column, so a non-uuid id raises a Postgres error that the
 * retriever would otherwise swallow as an empty result. Any single load failure degrades only
 * that candidate.
 */
async function loadFact(read: ReadQueryable, projectId: string, id: string): Promise<MemoryRecord | undefined> {
	if (typeof id !== 'string' || id.length === 0) {
		return undefined;
	}
	try {
		return await getFact(read, projectId, id);
	} catch {
		return undefined;
	}
}

/**
 * Vector seeds + graph expansion, fused by memory id (§15.4–§15.7).
 * When no embedding is available the graph path alone enriches nothing (no seeds) and the result
 * is empty — the caller degrades gracefully rather than failing (§24).
 */
export async function hybridRetrieve(
	deps: HybridDeps,
	projectId: string,
	queryEmbedding: readonly number[] | undefined,
	options: HybridOptions = {}
): Promise<RetrievalCandidate[]> {
	const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
	if (!Number.isInteger(maxResults) || maxResults < 1) {
		throw new Error('maxResults must be a positive integer');
	}

	const byId = new Map<string, RetrievalCandidate>();

	// §15.2/§15.4 — vector seeds.
	if (queryEmbedding && queryEmbedding.length > 0) {
		const matches = await searchFactsByVector(deps.read, projectId, queryEmbedding, maxResults * 2);
		for (const match of matches) {
			const fact = await loadFact(deps.read, projectId, match.ownerId);
			if (fact && fact.status === 'active') {
				byId.set(fact.id, { fact, similarity: match.similarity, sources: ['vector'] });
			}
		}
	}

	// §15.3/§15.5 — graph expansion from the seed set.
	const seedIds = [...byId.keys()];
	if (seedIds.length > 0) {
		const neighbours = await deps.graph.expandFromSeeds(projectId, seedIds, { maxHops: 1 });
		for (const node of neighbours) {
			const existing = byId.get(node.id);
			if (existing) {
				// §15.7 — same memory reached by both paths collapses to one candidate.
				byId.set(node.id, { ...existing, sources: [...new Set<CandidateSource>([...existing.sources, 'graph'])] });
				continue;
			}
			const fact = await loadFact(deps.read, projectId, node.id);
			if (fact && fact.status === 'active') {
				byId.set(fact.id, { fact, sources: ['graph'] });
			}
		}
	}

	// §15.6 — one fused list; §15.8 the ranking engine owns ordering/top-k.
	return [...byId.values()];
}