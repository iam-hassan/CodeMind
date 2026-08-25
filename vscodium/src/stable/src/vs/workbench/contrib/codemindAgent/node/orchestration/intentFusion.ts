/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { DeveloperIntent } from './types.js';
import { CompoundAnalysis, DeterministicScore } from './deterministicIntent.js';

/**
 * Fusion core (Phase-2 re-evaluation, Option 1).
 *
 * This is the single place the FINAL intent is decided, by FUSING several inputs
 * rather than letting any one of them act as an oracle:
 *   (1) deterministic keyword evidence (score + margin + signals),
 *   (2) local TF-IDF + logistic-regression probability,
 *   (3) clause-level compound analysis (≥2 distinct actionable objectives),
 *   (4) cross-stage agreement, and
 *   (5) score margin.
 *
 * It is intentionally model-AGNOSTIC and side-effect free: the ML input is passed
 * in already computed. The runtime (intentDetector.ts) feeds it the shipped model;
 * the offline trainer feeds it the per-FOLD model, so cross-validation stays honest
 * and the tuned pipeline is byte-for-byte what the runtime executes. `confidence`
 * is a CALIBRATED fused value in [0,1] — never the raw keyword score, never the
 * model probability alone.
 */

export interface MlInput {
    intent: DeveloperIntent;
    /** Top softmax probability in [0,1]. */
    probability: number;
    /** Full per-class probability map (for secondary-intent surfacing). */
    probs: Record<string, number>;
    /** True when ≥1 token was in-vocabulary. */
    hasFeatures: boolean;
}

export interface FusionParams {
    /** Consult the model only when the deterministic top score is below this. */
    triggerBelowScore: number;
    /** The model may override a weak deterministic signal only at/above this prob. */
    acceptProbability: number;
}

export interface FusionResult {
    intent: DeveloperIntent;
    /** Calibrated FINAL confidence in [0,1]. */
    confidence: number;
    signals: string[];
    secondaryIntents: DeveloperIntent[];
    /** Normalized deterministic top-vs-second gap in [0,1]. */
    margin: number;
    ambiguous: boolean;
    reason: string;
    stage: 'deterministic' | 'local_model' | 'fusion' | 'compound';
    mlConsulted: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Signals recorded for the chosen intent (so downstream capability sub-rules key off the right ones). */
function signalsFor(evidence: DeterministicScore, intent: DeveloperIntent): string[] {
    const r = evidence.ranked.find(x => x.intent === intent);
    const s = r && r.signals.length ? r.signals : evidence.topSignals;
    return (s.length ? s : ['no_strong_signals']).slice(0, 8);
}

export function fuseIntent(
    evidence: DeterministicScore,
    compound: CompoundAnalysis,
    ml: MlInput | null,
    params: FusionParams,
): FusionResult {
    const detIntent = evidence.topIntent;
    const detScore = evidence.topScore;
    const detMargin = evidence.margin;
    const detStrength = clamp(detScore / 6, 0, 1);

    // (1) Genuine compound task → MULTI_TOOL_WORKFLOW.
    if (compound.isCompound) {
        const objs = compound.objectives;
        const secondary = objs.slice(0, 3).map(o => o.intent);
        const avgStrength = clamp(objs.reduce((a, o) => a + o.score, 0) / (objs.length * 6), 0, 1);
        const confidence = clamp(0.6 + 0.08 * objs.length + 0.12 * avgStrength, 0, 0.92);
        return {
            intent: DeveloperIntent.MULTI_TOOL_WORKFLOW,
            confidence,
            signals: [`compound:${secondary.join('+')}`, ...evidence.topSignals].slice(0, 6),
            secondaryIntents: secondary,
            margin: detMargin,
            ambiguous: false,
            reason: `Compound task: ${objs.length} distinct objectives (${objs.map(o => o.intent).join(', ')}).`,
            stage: 'compound',
            mlConsulted: false,
        };
    }

    // (2) Nothing fired anywhere → safe default (short/gibberish-like), flagged ambiguous.
    const mlUsable = !!(ml && ml.hasFeatures && detScore < params.triggerBelowScore);
    if (detScore === 0 && !(ml && ml.hasFeatures)) {
        return {
            intent: DeveloperIntent.CODE_GENERATION,
            confidence: 0.3,
            signals: ['no_strong_signals'],
            secondaryIntents: [],
            margin: 0,
            ambiguous: true,
            reason: 'No deterministic signal and the local model abstained (out-of-vocabulary); safe default.',
            stage: 'deterministic',
            mlConsulted: false,
        };
    }

    const agree = !!(ml && ml.intent === detIntent);
    let intent: DeveloperIntent;
    let stage: FusionResult['stage'];
    let reason: string;
    let confidence: number;

    if (detScore >= params.triggerBelowScore) {
        // Deterministic evidence is strong enough to lead; the model can only reinforce.
        intent = detIntent;
        stage = agree ? 'fusion' : 'deterministic';
        confidence = (0.6 + 0.3 * detStrength) * (0.85 + 0.15 * detMargin);
        if (agree) { confidence += 0.07; }
        reason = agree
            ? `Deterministic evidence (score ${detScore.toFixed(1)}) and local model agree on ${intent}.`
            : `Deterministic evidence decisive for ${intent} (score ${detScore.toFixed(1)}, margin ${detMargin.toFixed(2)}).`;
    } else if (mlUsable && ml!.probability >= params.acceptProbability) {
        if (agree) {
            intent = detIntent;
            stage = 'fusion';
            confidence = clamp(0.55 + 0.25 * detStrength + 0.2 * ml!.probability, 0, 0.9);
            reason = `Weak deterministic signal for ${intent} confirmed by local model (p=${ml!.probability.toFixed(2)}).`;
        } else {
            intent = ml!.intent;
            stage = 'local_model';
            confidence = 0.5 + 0.4 * ml!.probability;
            reason = `Deterministic signal weak (score ${detScore.toFixed(1)}); local model overrides to ${intent} (p=${ml!.probability.toFixed(2)}).`;
        }
    } else {
        // Weak everywhere → keep the best available guess but treat as ambiguous.
        intent = detScore > 0 ? detIntent : (ml ? ml.intent : DeveloperIntent.CODE_GENERATION);
        stage = detScore > 0 ? 'deterministic' : 'local_model';
        confidence = 0.3 + 0.15 * detStrength;
        reason = `Low-confidence: deterministic score ${detScore.toFixed(1)}${ml ? `, model p=${ml.probability.toFixed(2)}` : ', model not consulted'}; best-guess ${intent}, treated as ambiguous.`;
    }

    confidence = clamp(confidence, 0, 0.99);
    const ambiguous = confidence < 0.5 || detMargin < 0.12 || (detScore < params.triggerBelowScore && !agree);

    // Secondary intents: strong deterministic runners-up, plus the model's pick if it dissented.
    const secondary: DeveloperIntent[] = [];
    for (const r of evidence.ranked) {
        if (r.intent !== intent && r.score > 1.5) { secondary.push(r.intent); }
        if (secondary.length >= 2) { break; }
    }
    if (ml && ml.intent !== intent && !secondary.includes(ml.intent) && ml.probability >= params.acceptProbability) {
        secondary.unshift(ml.intent);
    }

    return {
        intent,
        confidence,
        signals: signalsFor(evidence, intent),
        secondaryIntents: secondary.slice(0, 3),
        margin: detMargin,
        ambiguous,
        reason,
        stage,
        mlConsulted: mlUsable,
    };
}
