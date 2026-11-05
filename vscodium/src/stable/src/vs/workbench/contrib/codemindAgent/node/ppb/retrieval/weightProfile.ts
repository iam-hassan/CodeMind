/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ranking weight profile (P1-T14, spec §16.4/§16.7).
 *
 * Publishes the seven-signal weight profile as a typed, adjustable value so Part 3's benchmark
 * harness can tune the weights and measure retrieval relevance against the evaluation dataset —
 * without reading Part 1's internals. The formula structure is the weighted sum of §16.4; the
 * default weights and top-k remain PLACEHOLDERS (spec §32) and are not fixed by the source.
 */

import { DEFAULT_RANKING_WEIGHTS, type RankingSignals, type RankingWeights } from './ranker.js';

/** The seven signal names in profile order (§16.2, preserve exactly). */
export const RANKING_SIGNAL_NAMES: readonly (keyof RankingSignals)[] = [
	'recency', 'importance', 'frequency', 'currentTask', 'currentFile', 'developerIntent', 'projectModule'
];

export interface RankingWeightProfile {
	/** Contract version for Part 3 tuning clients. */
	readonly version: string;
	readonly weights: RankingWeights;
	/** PLACEHOLDER default; coordinate with Part 2's token budget (§16.6). */
	readonly topK: number;
}

/** Bumped when the published shape changes (§33). */
export const WEIGHT_PROFILE_VERSION = '1.0.0';

export const DEFAULT_TOP_K = 8;

export class WeightProfileError extends Error {
	constructor(message: string, readonly code: 'invalid-weight' | 'invalid-top-k' | 'unknown-signal') {
		super(message);
		this.name = 'WeightProfileError';
	}
}

/** A fresh profile with the placeholder defaults (§16.4). */
export function defaultWeightProfile(): RankingWeightProfile {
	return { version: WEIGHT_PROFILE_VERSION, weights: { ...DEFAULT_RANKING_WEIGHTS }, topK: DEFAULT_TOP_K };
}

function requireWeight(name: string, value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new WeightProfileError(`weight "${name}" must be a non-negative finite number (got ${String(value)})`, 'invalid-weight');
	}
	return value;
}

/** Validate and normalize a partial set of weight overrides; unknown signals are rejected. */
export function validateWeights(overrides: Partial<RankingWeights>): Partial<RankingWeights> {
	const validated: Record<string, number> = {};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			continue;
		}
		if (!(RANKING_SIGNAL_NAMES as readonly string[]).includes(key)) {
			throw new WeightProfileError(`unknown ranking signal "${key}"`, 'unknown-signal');
		}
		validated[key] = requireWeight(key, value);
	}
	return validated as Partial<RankingWeights>;
}

/** Combine a base profile with validated overrides, returning a new immutable profile (§16.7). */
export function mergeWeightProfile(
	base: RankingWeightProfile,
	overrides: Partial<RankingWeights> & { readonly topK?: number } = {}
): RankingWeightProfile {
	const { topK, ...weightOverrides } = overrides;
	let nextTopK = base.topK;
	if (topK !== undefined) {
		if (!Number.isInteger(topK) || topK < 1) {
			throw new WeightProfileError(`topK must be a positive integer (got ${String(topK)})`, 'invalid-top-k');
		}
		nextTopK = topK;
	}
	return {
		version: base.version,
		weights: { ...base.weights, ...validateWeights(weightOverrides) },
		topK: nextTopK
	};
}

/** Convenience for Part 3: tune from the defaults in one call. */
export function tuneWeights(overrides: Partial<RankingWeights> & { readonly topK?: number } = {}): RankingWeightProfile {
	return mergeWeightProfile(defaultWeightProfile(), overrides);
}