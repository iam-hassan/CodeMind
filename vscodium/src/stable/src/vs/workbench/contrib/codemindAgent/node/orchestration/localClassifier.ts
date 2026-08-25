/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { DeveloperIntent } from './types.js';
import { featuresOf } from './textNormalize.js';
import { INTENT_MODEL } from './intentModel.js';

/**
 * Local second-stage intent classifier (Phase-2 re-evaluation, Layer 1).
 *
 * A TF-IDF + multinomial-logistic-regression model, trained OFFLINE against
 * intentBenchmark.ts and embedded as plain numbers in intentModel.ts. Inference
 * is pure arithmetic — NO network, NO model-provider call, NO filesystem. It runs
 * only when the deterministic keyword scorer is uncertain (see intentDetector.ts),
 * so the common path stays byte-for-byte what it always was and stays free.
 *
 * The transform mirrors scikit-learn's TfidfVectorizer defaults the trainer used:
 * tf = raw term count, idf = ln((1+n)/(1+df)) + 1 (smooth), then L2 row-normalize.
 */

export interface IntentModel {
    version: string;
    /** DeveloperIntent values; index === class id used by coef/intercept. */
    classes: string[];
    /** feature string → column index. */
    vocab: Record<string, number>;
    /** idf per column, length === |vocab|. */
    idf: number[];
    /** logistic-regression weights [class][column]. */
    coef: number[][];
    /** logistic-regression bias per class. */
    intercept: number[];
    // --- pipeline params TUNED on the benchmark (not hand-picked) ---
    /** Consult this model only when the deterministic raw score is below this. */
    triggerBelowScore: number;
    /** Override the deterministic intent only if top probability ≥ this. */
    acceptProbability: number;
    // --- honesty / reproducibility metadata ---
    trainedAt: string;
    numCases: number;
    trainAccuracy: number;
    /** 5-fold cross-validated accuracy — the honest generalization estimate. */
    cvAccuracy: number;
}

export interface LocalClassification {
    intent: DeveloperIntent;
    /** Top softmax probability. */
    confidence: number;
    /** Per-intent probability, for the trace. */
    scores: Record<string, number>;
    /** True when at least one token overlapped the model vocabulary. */
    hasFeatures: boolean;
}

/** Build the L2-normalized TF-IDF vector as (column → value) for present terms. */
function tfidfVector(prompt: string): Map<number, number> {
    const counts = new Map<number, number>();
    for (const f of featuresOf(prompt)) {
        const col = INTENT_MODEL.vocab[f];
        if (col === undefined) { continue; }
        counts.set(col, (counts.get(col) ?? 0) + 1);
    }
    const vec = new Map<number, number>();
    let sumSq = 0;
    for (const [col, c] of counts) {
        const v = c * INTENT_MODEL.idf[col];
        vec.set(col, v);
        sumSq += v * v;
    }
    if (sumSq > 0) {
        const norm = Math.sqrt(sumSq);
        for (const [col, v] of vec) { vec.set(col, v / norm); }
    }
    return vec;
}

function softmax(logits: number[]): number[] {
    const max = Math.max(...logits);
    const exps = logits.map(z => Math.exp(z - max));
    const sum = exps.reduce((a, b) => a + b, 0) || 1;
    return exps.map(e => e / sum);
}

/**
 * Classify a prompt with the local model. `hasFeatures` is false for prompts
 * whose every token is out-of-vocabulary (e.g. gibberish); the caller uses that
 * to decline the model and keep the deterministic fallback.
 */
export function classifyLocal(prompt: string): LocalClassification {
    const vec = tfidfVector(prompt);
    const logits = INTENT_MODEL.classes.map((_, c) => {
        let z = INTENT_MODEL.intercept[c];
        const row = INTENT_MODEL.coef[c];
        for (const [col, x] of vec) { z += row[col] * x; }
        return z;
    });
    const probs = softmax(logits);
    let best = 0;
    for (let c = 1; c < probs.length; c++) { if (probs[c] > probs[best]) { best = c; } }
    const scores: Record<string, number> = {};
    INTENT_MODEL.classes.forEach((cls, c) => { scores[cls] = probs[c]; });
    return {
        intent: INTENT_MODEL.classes[best] as DeveloperIntent,
        confidence: probs[best],
        scores,
        hasFeatures: vec.size > 0,
    };
}

/** Exposed so the trace / tuning can report the params the model shipped with. */
export function localModelInfo(): Pick<IntentModel, 'version' | 'triggerBelowScore' | 'acceptProbability' | 'cvAccuracy' | 'numCases'> {
    const { version, triggerBelowScore, acceptProbability, cvAccuracy, numCases } = INTENT_MODEL;
    return { version, triggerBelowScore, acceptProbability, cvAccuracy, numCases };
}
