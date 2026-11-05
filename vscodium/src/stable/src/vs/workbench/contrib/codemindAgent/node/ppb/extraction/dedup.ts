/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Fact deduplication (P1-T06, spec §8).
 *
 * Decides what an incoming fact is relative to existing project knowledge — the second judgment
 * over the candidate set shared with conflict detection (§8.9). Four outcomes (§8.7/§8.9):
 *
 *  - `duplicate`      restates existing knowledge (exact or semantically identical) — store nothing;
 *  - `update`         adds detail without contradicting (e.g. "added an endpoint") — store as new;
 *  - `contradiction`  appears to replace existing knowledge (e.g. a database/framework/auth/deployment
 *                     change) — routed to Conflict Detection (§12), never silently treated as an update;
 *  - `new`            unrelated knowledge — store independently.
 *
 * The similarity threshold and the replacement/addition heuristics are PLACEHOLDERS (the source
 * document leaves them open — §8.4/§8.7/§32). The five conflict examples of §12.3 are preserved as
 * fixed cases here and in T10's regression suite.
 */

import type { MemoryCategory } from '../ontology.js';
import type { MemoryRecord } from '../storage/read.js';
import { findFacts, type ReadQueryable } from '../storage/read.js';

export type DedupOutcome = 'duplicate' | 'update' | 'contradiction' | 'new';

export interface DedupDecision {
	readonly outcome: DedupOutcome;
	/** The existing memory this decision relates to, when one matched. */
	readonly existingId?: string;
	readonly similarity?: number;
	readonly reason: string;
}

export interface DedupOptions {
	/** Cosine similarity at/above which two differently-worded facts are the same fact (§8.4). PLACEHOLDER. */
	readonly similarityThreshold?: number;
	/** Semantic similarity lookup for a candidate id, if embeddings are available (§8.4). */
	readonly similarity?: (candidateId: string) => number | undefined;
}

/** PLACEHOLDER — configurable, pending measurement (spec §8.4/§32). */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.92;

/** Replacement language suggesting an intentional change of prior knowledge (§8.7, §12.3–§12.5). */
const REPLACEMENT_PATTERN = /\b(switch|switching|switched|migrat(?:e|ed|ing)|replac(?:e|ed|ing)|chang(?:e|ed|ing)|instead of|no longer|dropped?|mov(?:e|ed|ing))\b/i;

/** Additive language suggesting new detail rather than a change (the "added endpoint" case, §12.3). */
const ADDITIVE_PATTERN = /\b(add(?:ed|ing)?|also|new(?:ly)?|introduc(?:e|ed|ing)|another)\b/i;

/** Normalised content for exact comparison — case- and whitespace-insensitive (§8.3). */
export function normaliseContent(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Candidate set for dedup/conflict — same project, same category, active knowledge (§8.2/§8.6). */
export async function findDedupCandidates(client: ReadQueryable, projectId: string, category: MemoryCategory): Promise<MemoryRecord[]> {
	return findFacts(client, projectId, { category, status: 'active', limit: 100 });
}

/** Classify one incoming fact against its same-category candidates (§8.7). */
export function classifyFact(
	content: string,
	category: MemoryCategory,
	candidates: readonly MemoryRecord[],
	options: DedupOptions = {}
): DedupDecision {
	const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
	const incoming = normaliseContent(content);

	const sameCategory = candidates.filter(candidate => candidate.category === category);
	if (sameCategory.length === 0) {
		return { outcome: 'new', reason: 'no existing knowledge in this category' };
	}

	// 1. Exact / near-exact textual equivalence (§8.3).
	for (const candidate of sameCategory) {
		if (normaliseContent(candidate.content) === incoming) {
			return { outcome: 'duplicate', existingId: candidate.id, similarity: 1, reason: 'identical content' };
		}
	}

	// 2. Semantic similarity (§8.4) — highest matching candidate wins.
	let best: { candidate: MemoryRecord; similarity: number } | undefined;
	for (const candidate of sameCategory) {
		const similarity = options.similarity?.(candidate.id);
		if (similarity === undefined) {
			continue;
		}
		if (!best || similarity > best.similarity) {
			best = { candidate, similarity };
		}
	}
	if (best && best.similarity >= threshold) {
		return { outcome: 'duplicate', existingId: best.candidate.id, similarity: best.similarity, reason: `semantic match >= ${threshold}` };
	}

	// 3. Contradiction vs. non-contradictory update (§8.7) — conservative, additive wins ties.
	const replacement = REPLACEMENT_PATTERN.test(content);
	const additive = ADDITIVE_PATTERN.test(content);
	if (replacement && !additive) {
		return {
			outcome: 'contradiction',
			existingId: sameCategory[0].id,
			similarity: best?.similarity,
			reason: 'replacement language against existing same-category knowledge'
		};
	}
	if (additive) {
		return {
			outcome: 'update',
			existingId: sameCategory[0].id,
			similarity: best?.similarity,
			reason: 'additive detail for existing knowledge'
		};
	}

	// 4. Different knowledge in the same category.
	if (best) {
		return { outcome: 'new', existingId: best.candidate.id, similarity: best.similarity, reason: `most similar below threshold (${best.similarity})` };
	}
	return { outcome: 'new', reason: 'no matching candidate' };
}