/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import {
    Capability, DeterministicEvidence, IntentClassification, MlPrediction, SelectionContext,
} from './types.js';
import { analyzeCompound, fastPathClassify, scoreDeterministic } from './deterministicIntent.js';
import { fuseIntent, MlInput } from './intentFusion.js';
import { classifyLocal } from './localClassifier.js';
import { INTENT_MODEL } from './intentModel.js';
import { resolveRequiredCapabilities } from './capabilities.js';

/**
 * Intent Detection Engine (Section 2) — local, no LLM, FUSION architecture.
 *
 *   fast path  → slash / very-short prompts (unchanged, still free).
 *   evidence   → deterministic weighted-keyword scorer (candidate + evidence, NOT
 *                an oracle) + clause-level compound analysis on the RAW prompt.
 *   model      → local TF-IDF + logistic-regression probability (embedded
 *                arithmetic in intentModel.ts — no network, no provider call).
 *   fusion     → intentFusion.fuseIntent combines deterministic evidence, model
 *                probability, compound structure, agreement, and margin into the
 *                FINAL intent + a calibrated confidence.
 *
 * The output separates the three quantities the re-evaluation insisted must not be
 * conflated: `deterministicEvidence` (raw keyword score), `mlPrediction` (model
 * probability), and `confidence` (the final fused value). `classificationReason`
 * records, in words, how the fusion decided.
 */

/** Context the classifier legitimately knows about (no open-files / follow-up here). */
function neutralContext(promptLength: number): SelectionContext {
    return { hasOpenFiles: false, workspaceFolder: '', promptLength, hasImageAttachments: false, isFollowUp: false };
}

export function classifyIntent(prompt: string): IntentClassification {
    // Fast path: slash command / very short prompt (identical to legacy).
    const fast = fastPathClassify(prompt);
    if (fast) {
        const ambiguous = fast.signals.includes('short_prompt_fallback');
        return {
            ...fast,
            primaryIntent: fast.intent,
            secondaryIntents: [],
            requiredCapabilities: resolveRequiredCapabilities(fast, neutralContext(prompt.length)),
            margin: ambiguous ? 0 : 1,
            ambiguous,
            classifierStage: 'fast_path',
            deterministicEvidence: null as unknown as DeterministicEvidence | undefined,
            mlPrediction: null,
            classificationReason: fast.signals.includes('slash_command')
                ? 'Slash command → terminal execution (fast path).'
                : 'Prompt too short to score; safe default (fast path).',
        };
    }

    // Evidence generation (deterministic) + genuine-compound analysis.
    const evidence = scoreDeterministic(prompt);
    const compound = analyzeCompound(prompt);

    // Local model probability (pure arithmetic; fusion decides whether to USE it).
    const local = classifyLocal(prompt);
    const ml: MlInput = {
        intent: local.intent, probability: local.confidence, probs: local.scores, hasFeatures: local.hasFeatures,
    };

    const fused = fuseIntent(evidence, compound, ml, {
        triggerBelowScore: INTENT_MODEL.triggerBelowScore,
        acceptProbability: INTENT_MODEL.acceptProbability,
    });

    const deterministicEvidence: DeterministicEvidence = {
        topIntent: evidence.topIntent,
        topScore: evidence.topScore,
        secondIntent: evidence.secondIntent,
        secondScore: evidence.secondScore,
        margin: evidence.margin,
        signals: evidence.topSignals,
        compoundObjectives: compound.objectives,
    };

    const mlPrediction: MlPrediction = {
        intent: local.intent,
        probability: local.confidence,
        hasFeatures: local.hasFeatures,
        consulted: fused.mlConsulted,
    };

    const result: IntentClassification = {
        intent: fused.intent,
        confidence: fused.confidence,
        signals: fused.signals,
        primaryIntent: fused.intent,
        secondaryIntents: fused.secondaryIntents,
        requiredCapabilities: [] as Capability[],
        margin: fused.margin,
        ambiguous: fused.ambiguous,
        classifierStage: fused.stage,
        deterministicEvidence,
        mlPrediction,
        classificationReason: fused.reason,
    };
    // Capability set reflects the FINAL intent + fused confidence + signals (so the
    // code-gen confidence gate and signal sub-rules apply), context-free otherwise.
    result.requiredCapabilities = resolveRequiredCapabilities(result, neutralContext(prompt.length));
    return result;
}
