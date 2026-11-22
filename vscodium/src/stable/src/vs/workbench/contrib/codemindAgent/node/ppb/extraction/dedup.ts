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
const REPLACEMENT_PATTERN = /\b(switch|switching|switched|migrat(?:e|ed|ing)|replac(?:e|ed|ing)|chang(?:e|ed|ing)|instead of|no longer|dropped?|mov(?:e|ed|ing)|abandon(?:ed|ing)?|previously|used to|decommission(?:ed)?|retir(?:e|ed)|discontinu(?:e|ed)|superseded|phased out)\b/i;

/** Additive language suggesting new detail rather than a change (the "added endpoint" case, §12.3). */
const ADDITIVE_PATTERN = /\b(add(?:ed|ing)?|also|new(?:ly)?|introduc(?:e|ed|ing)|another)\b/i;

/** Normalised content for exact comparison — case- and whitespace-insensitive (§8.3). */
export function normaliseContent(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Subject matching (§8.4/§12.3) ─────────────────────────────────────────────
//
// Dedup and conflict detection both need to know whether two statements are about the *same thing*.
// With no embedding model, content-word overlap is the stand-in (D51). A change to the caching layer
// shares "redis"/"caching" with the caching memory and must be treated as a contradiction; it shares
// nothing with the persistence memory and must not touch it.
const SUBJECT_STOPWORDS = new Set([
	'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'for', 'of', 'to', 'in',
	'on', 'at', 'by', 'with', 'and', 'or', 'that', 'this', 'it', 'its', 'as', 'we', 'our', 'project',
	'use', 'uses', 'used', 'using', 'must', 'should', 'will', 'can', 'code', 'new', 'now'
]);

/** Content words of a statement (lowercase, punctuation-stripped, stopwords removed). */
export function contentTokens(text: string): Set<string> {
	return new Set(
		(text.toLowerCase().match(/[a-z0-9][a-z0-9_+-]*/g) ?? [])
			.filter(token => token.length >= 2 && !SUBJECT_STOPWORDS.has(token))
	);
}

/** True when two statements share at least one content word — i.e. they are about the same subject. */
export function sharesSubject(a: string, b: string): boolean {
	return contentTokens(a).size > 0 && [...contentTokens(b)].some(token => contentTokens(a).has(token));
}

/** Jaccard similarity over content-word sets — 1 means the same words, 0 means none shared. */
export function lexicalSimilarity(a: string, b: string): number {
	const left = contentTokens(a);
	const right = contentTokens(b);
	if (left.size === 0 || right.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) {
			intersection++;
		}
	}
	const union = left.size + right.size - intersection;
	return union === 0 ? 0 : intersection / union;
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