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
import { searchFactsByVector, similaritiesForFacts } from '../embeddings/vectorStore.js';
import { findFacts, getFact, getFacts, type MemoryRecord, type ReadQueryable } from '../storage/read.js';

export type CandidateSource = 'vector' | 'graph' | 'lexical';

export interface RetrievalCandidate {
	readonly fact: MemoryRecord;
	/** Cosine similarity when the candidate came from the vector path. */
	readonly similarity?: number;
	/** Query-term overlap in [0,1] over content+provenance when the candidate came from the lexical path (D51). */
	readonly lexical?: number;
	readonly sources: readonly CandidateSource[];
}

export interface HybridDeps {
	readonly read: ReadQueryable;
	readonly graph: GraphRepository;
}

export interface HybridOptions {
	/** PLACEHOLDER bound (spec §26/§32). */
	readonly maxResults?: number;
	/** Raw query text, enabling the lexical channel (D51). Without it the lexical path is skipped. */
	readonly queryText?: string;
}

const DEFAULT_MAX_RESULTS = 8;

/** Upper bound on facts scanned by the lexical channel (D51). Bounds cost on large projects. */
const LEXICAL_SCAN_LIMIT = 2000;

/** Memory ids are uuids; graph expansion can also surface structural (non-uuid) nodes to skip. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Query tokens for the lexical channel — lowercased alphanumeric runs longer than two chars. */
function queryTokens(text: string | undefined): string[] {
	return [...new Set((text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2))];
}

/** Text a lexical query is matched against: content plus its provenance (D48/D51). */
function lexicalHaystack(fact: MemoryRecord): string {
	const date = fact.extractedAt ? fact.extractedAt.slice(0, 10) : '';
	return `${fact.content} ${fact.author ?? ''} ${date}`.toLowerCase();
}

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

	// §15.2/§15.4 — vector seeds. D47: over-fetch a wide pool (8×k, ≥64) so the ranking engine can
	// pick the top-k by relevance instead of being handed only the 2×k the vector scan happened to
	// return; the original 2×k pool made the top-k a near-arbitrary cut of the vector ranking.
	// D54: load the whole pool in one round trip (`getFacts`); N sequential `getFact` calls made the
	// widened pool the dominant cost (E2 p50 62.7→214.8 ms at N=100 before this fix).
	if (queryEmbedding && queryEmbedding.length > 0) {
		const poolSize = Math.max(maxResults * 8, 64);
		const matches = await searchFactsByVector(deps.read, projectId, queryEmbedding, poolSize);
		let loaded = new Map<string, MemoryRecord>();
		let batchOk = true;
		try { loaded = await getFacts(deps.read, projectId, matches.map(match => match.ownerId)); }
		catch { batchOk = false; }
		for (const match of matches) {
			// D54 batch load; `getFacts` deliberately skips ids that are not uuids (graph structural
			// nodes) and ids absent from the store, so any miss here is resolved individually rather
			// than silently dropped.
			let fact = batchOk ? loaded.get(match.ownerId) : undefined;
			if (!fact) {
				fact = await loadFact(deps.read, projectId, match.ownerId);
			}
			if (fact && fact.status === 'active') {
				byId.set(fact.id, { fact, similarity: match.similarity, sources: ['vector'] });
			}
		}
	}

	// D51 — lexical channel. The vector path can miss a fact whose distinctive tokens live in its
	// provenance (author/date) rather than its content (e.g. "who decided X and when was it
	// recorded?"). Score every active fact by query-term overlap over content+provenance and seed
	// the strongest matches so the ranking engine can consider them.
	const qtoks = queryTokens(options.queryText);
	if (qtoks.length > 0) {
		let all: MemoryRecord[] = [];
		try { all = await findFacts(deps.read, projectId, { status: 'active', limit: LEXICAL_SCAN_LIMIT }); } catch { all = []; }
		// IDF weighting over the scanned project so generic query words ("the", "what", "our") cannot
		// let an unrelated fact outrank a real semantic hit; only distinctive tokens carry weight.
		const haystacks = new Map<string, string>();
		const documentFrequency = new Map<string, number>();
		for (const fact of all) {
			const hay = lexicalHaystack(fact);
			haystacks.set(fact.id, hay);
			for (const token of qtoks) { if (hay.includes(token)) { documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1); } }
		}
		const total = Math.max(1, all.length);
		const idf = (token: string): number => {
			const df = documentFrequency.get(token) ?? 0;
			return Math.log(1 + (total - df + 0.5) / (df + 0.5));
		};
		const queryIdf = qtoks.reduce((sum, token) => sum + idf(token), 0) || 1;
		const scored: Array<{ fact: MemoryRecord; lexical: number }> = [];
		for (const fact of all) {
			const hay = haystacks.get(fact.id) ?? '';
			let weight = 0;
			for (const token of qtoks) { if (hay.includes(token)) { weight += idf(token); } }
			if (weight > 0) { scored.push({ fact, lexical: weight / queryIdf }); }
		}
		scored.sort((a, b) => b.lexical - a.lexical);
		for (const { fact, lexical } of scored.slice(0, Math.max(maxResults * 2, 16))) {
			const existing = byId.get(fact.id);
			if (existing) {
				byId.set(fact.id, { ...existing, lexical, sources: [...new Set<CandidateSource>([...existing.sources, 'lexical'])] });
			} else {
				byId.set(fact.id, { fact, lexical, sources: ['lexical'] });
			}
		}
	}

	// §15.3/§15.5 — graph expansion from the seed set. D54: batch-load the neighbour ids that are not
	// already candidates; `getFacts` skips the structural (non-uuid) nodes so one bad id cannot abort.
	const seedIds = [...byId.keys()];
	if (seedIds.length > 0) {
		const neighbours = await deps.graph.expandFromSeeds(projectId, seedIds, { maxHops: 1 });
		const needIds = neighbours.filter(node => !byId.has(node.id)).map(node => node.id);
		let loadedGraph = new Map<string, MemoryRecord>();
		let graphBatchOk = true;
		try { loadedGraph = await getFacts(deps.read, projectId, needIds); }
		catch { graphBatchOk = false; }
		for (const node of neighbours) {
			const existing = byId.get(node.id);
			if (existing) {
				// §15.7 — same memory reached by both paths collapses to one candidate.
				byId.set(node.id, { ...existing, sources: [...new Set<CandidateSource>([...existing.sources, 'graph'])] });
				continue;
			}
			let fact = graphBatchOk ? loadedGraph.get(node.id) : undefined;
			if (!fact) {
				fact = await loadFact(deps.read, projectId, node.id);
			}
			if (fact && fact.status === 'active') {
				byId.set(fact.id, { fact, sources: ['graph'] });
			}
		}
	}

	// D55 — equalise the relevance signal. Candidates found only by the lexical or graph channel
	// carry no cosine score, and the ranker treats "no score" as 0 (maximally dissimilar). Give every
	// such candidate its real cosine similarity against the query so a strong keyword/structure hit
	// is compared on the same footing as a vector hit instead of being silently demoted. Best-effort:
	// a failure leaves the candidate unscored (unchanged behaviour).
	if (queryEmbedding && queryEmbedding.length > 0) {
		const missing = [...byId.values()]
			.filter(candidate => candidate.similarity === undefined)
			.map(candidate => candidate.fact.id)
			.filter(id => UUID_RE.test(id));
		if (missing.length > 0) {
			try {
				const similarities = await similaritiesForFacts(deps.read, projectId, queryEmbedding, missing);
				for (const [id, similarity] of similarities) {
					const existing = byId.get(id);
					if (existing) {
						byId.set(id, { ...existing, similarity });
					}
				}
			} catch { /* similarity enrichment is best-effort (§24) */ }
		}
	}

	// §15.6 — one fused list; §15.8 the ranking engine owns ordering/top-k.
	return [...byId.values()];
}