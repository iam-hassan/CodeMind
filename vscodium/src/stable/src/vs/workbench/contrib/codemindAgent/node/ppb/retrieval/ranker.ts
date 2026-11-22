/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Memory ranking (C1.4, P1-T09, spec §16).
 *
 * Scores every fused candidate with the seven signals of §16.2 (re-calculated at retrieval time),
 * combines them through a configurable weighted sum (§16.3/§16.4), and returns the top-k with the
 * per-signal breakdown required by IF-6. All normalization/weight/fallback choices are PLACEHOLDERS
 * (spec §32) exposed for Part 3's tuning (P1-T14).
 */

import type { MemoryCategory } from '../ontology.js';
import type { RankingContextCarrier } from './rankerContext.js';
import type { RetrievalCandidate } from './hybrid.js';

/**
 * Ranking signals. The first seven are the §16.2 set (preserved exactly). `similarity` is added
 * on top of them (benchmark deviation D47): the hybrid retriever already computes the vector
 * cosine similarity for every semantic candidate (`RetrievalCandidate.similarity`), but the
 * original seven-signal weighted sum never read it, so the only signal that knows the *meaning*
 * of the query had zero weight and semantic matches could be evicted from the top-k by recency.
 * Each signal is normalized to [0,1].
 */
export interface RankingSignals {
	readonly recency: number;
	readonly importance: number;
	readonly frequency: number;
	readonly currentTask: number;
	readonly currentFile: number;
	readonly developerIntent: number;
	readonly projectModule: number;
	/** Vector cosine similarity mapped to [0,1]; 0 when the candidate has no vector score (D47). */
	readonly similarity: number;
	/** Query-term overlap over content+provenance in [0,1]; 0 for non-lexical candidates (D51). */
	readonly lexical: number;
}

export type RankingWeights = RankingSignals;

/**
 * Configurable defaults. `similarity` carries the highest weight because it is the only
 * *relevance* signal here — the rest are recency/context priors. `lexical` is the keyword
 * counterpart that recovers exact-token and provenance matches the vector path misses (D51).
 * Weights remain adjustable through the published profile (T14). PLACEHOLDER values (D47/D51).
 */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
	recency: 1, importance: 1, frequency: 1, currentTask: 1, currentFile: 1, developerIntent: 1, projectModule: 1, similarity: 3, lexical: 2
};

export interface RankingContext extends RankingContextCarrier {
	readonly now?: () => Date;
}

export interface RankedCandidate extends RetrievalCandidate {
	/** Weighted combined relevance in [0,1]. */
	readonly score: number;
	readonly signals: RankingSignals;
}

export interface RankOptions {
	readonly weights?: Partial<RankingWeights>;
	/** PLACEHOLDER default; should be coordinated with Part 2's token budget (§16.6). */
	readonly topK?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FREQUENCY_SATURATION = 10; // PLACEHOLDER: access count mapping

/** Intent → the categories most relevant to it (PLACEHOLDER mapping, §16.2 signal 6). */
const INTENT_CATEGORIES: Readonly<Record<string, readonly MemoryCategory[]>> = {
	architecture: ['architecture_patterns', 'technology_stack'],
	code_generation: ['engineering_standards', 'developer_preferences', 'technology_stack'],
	debugging: ['constraints', 'engineering_standards'],
	testing: ['engineering_standards'],
	project_analysis: ['architecture_patterns', 'business_rules'],
	documentation: ['engineering_standards', 'business_rules']
};

function tokenize(text: string | undefined): string[] {
	return (text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2);
}

function overlapRatio(tokens: readonly string[], text: string): number {
	if (tokens.length === 0) {
		return 0;
	}
	const haystack = text.toLowerCase();
	const hits = tokens.filter(token => haystack.includes(token)).length;
	return hits / tokens.length;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/** Compute the normalized signals for one candidate (§16.2/§16.3 + D47 similarity). */
export function computeSignals(candidate: RetrievalCandidate, context: RankingContext, now: Date): RankingSignals {
	const fact = candidate.fact;
	const ageMs = Math.max(0, now.getTime() - new Date(fact.extractedAt).getTime());
	const recency = 1 / (1 + ageMs / DAY_MS); // PLACEHOLDER: hyperbolic decay
	const frequency = clamp01(fact.accessCount / FREQUENCY_SATURATION);
	const currentTask = overlapRatio(tokenize(context.currentTask), fact.content);
	const openFileTokens = (context.openFiles ?? []).map(file => file.split(/[\\/]/).pop() ?? '').flatMap(name => tokenize(name.replace(/\.[a-z0-9]+$/i, '')));
	const currentFile = overlapRatio(openFileTokens, fact.content);
	const intentCategories = INTENT_CATEGORIES[(context.intent ?? '').toLowerCase()];
	const developerIntent = intentCategories?.includes(fact.category) ? 1 : 0;
	const projectModule = overlapRatio(tokenize(context.projectModule), fact.content);
	// D47: cosine similarity from the vector path, mapped [-1,1] → [0,1]. Graph-only candidates
	// (no vector score) get 0 rather than a neutral 0.5 so they cannot outrank real semantic hits.
	const similarity = candidate.similarity === undefined ? 0 : clamp01((candidate.similarity + 1) / 2);
	// D51: lexical overlap from the keyword channel; 0 for candidates the vector path alone found.
	const lexical = clamp01(candidate.lexical ?? 0);
	return { recency, importance: clamp01(fact.importance), frequency, currentTask, currentFile, developerIntent, projectModule, similarity, lexical };
}

/**
 * Weighted-sum ranking with top-k selection (§16.4/§16.6). Missing context signals simply score 0
 * (graceful degradation, §16.5). Ties break on recency then id (PLACEHOLDER, §16.5).
 */
export function rank(candidates: readonly RetrievalCandidate[], context: RankingContext = {}, options: RankOptions = {}): RankedCandidate[] {
	const weights: RankingWeights = { ...DEFAULT_RANKING_WEIGHTS, ...options.weights };
	const weightSum = Object.values(weights).reduce((sum, weight) => sum + weight, 0) || 1;
	const now = (context.now ?? (() => new Date()))();

	const ranked: RankedCandidate[] = candidates.map(candidate => {
		const signals = computeSignals(candidate, context, now);
		const weighted =
			weights.recency * signals.recency +
			weights.importance * signals.importance +
			weights.frequency * signals.frequency +
			weights.currentTask * signals.currentTask +
			weights.currentFile * signals.currentFile +
			weights.developerIntent * signals.developerIntent +
			weights.projectModule * signals.projectModule +
			weights.similarity * signals.similarity +
			weights.lexical * signals.lexical;
		return { ...candidate, score: clamp01(weighted / weightSum), signals };
	});

	ranked.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		if (b.signals.recency !== a.signals.recency) {
			return b.signals.recency - a.signals.recency;
		}
		return a.fact.id.localeCompare(b.fact.id);
	});

	const topK = options.topK ?? ranked.length;
	return topK >= 0 ? ranked.slice(0, topK) : ranked;
}