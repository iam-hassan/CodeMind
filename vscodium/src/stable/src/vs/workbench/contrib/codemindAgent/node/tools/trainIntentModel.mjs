/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *-------------------------------------------------------------------------------------------*/

/*
 * Offline trainer for the local Stage-2 intent classifier.
 *
 *   node --stack-size=4000 tools/trainIntentModel.mjs
 *
 * Reads intentBenchmark.ts (the ground truth), fits a TF-IDF + multinomial
 * logistic-regression model in pure JS (no Python, no external ML dep), tunes the
 * two pipeline thresholds against the benchmark via 5-fold cross-validation (so
 * the numbers are honest, not hand-picked), and writes orchestration/intentModel.ts.
 *
 * It transpiles the handful of .ts files it needs with the repo's own TypeScript
 * (transpileModule → temp dir → dynamic import), so it always trains against the
 * exact tokenizer/scorer the runtime uses.
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH = join(HERE, '..', 'orchestration');
const VSCODE_PKG = 'D:/HassanSem/Semester-6/FYP/CodeMind/vscodium/vscode/package.json';

const require = createRequire(VSCODE_PKG);
const ts = require('typescript');

/** Transpile a set of .ts files to a temp dir and return its path. */
function transpileToTemp(files) {
    const dir = mkdtempSync(join(tmpdir(), 'cmtrain-'));
    for (const f of files) {
        const src = readFileSync(join(ORCH, f), 'utf8');
        const out = ts.transpileModule(src, {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
        }).outputText;
        writeFileSync(join(dir, f.replace(/\.ts$/, '.js')), out, 'utf8');
    }
    return dir;
}

async function main() {
    // types.ts re-exports a base cancellation path that won't resolve in the temp
    // dir; strip that one line so the transpiled module imports cleanly.
    const tmp = transpileToTemp(['textNormalize.ts', 'deterministicIntent.ts', 'intentFusion.ts', 'capabilities.ts', 'intentBenchmark.ts']);
    // types.ts needs its trailing re-export removed before transpiling.
    const typesSrc = readFileSync(join(ORCH, 'types.ts'), 'utf8')
        .replace(/export type \{ CancellationToken \}.*$/m, '');
    writeFileSync(join(tmp, 'types.js'),
        ts.transpileModule(typesSrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true } }).outputText,
        'utf8');

    const { featuresOf, normalizePrompt } = await import(pathToFileURL(join(tmp, 'textNormalize.js')).href);
    const { scoreDeterministic, classifyDeterministic, analyzeCompound } = await import(pathToFileURL(join(tmp, 'deterministicIntent.js')).href);
    const { fuseIntent } = await import(pathToFileURL(join(tmp, 'intentFusion.js')).href);
    const { resolveRequiredCapabilities, baseCapabilitiesForIntent } = await import(pathToFileURL(join(tmp, 'capabilities.js')).href);
    const { INTENT_BENCHMARK } = await import(pathToFileURL(join(tmp, 'intentBenchmark.js')).href);
    const { DeveloperIntent } = await import(pathToFileURL(join(tmp, 'types.js')).href);

    const CLASSES = Object.values(DeveloperIntent);
    const classIndex = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
    const K = CLASSES.length;

    runTraining({
        featuresOf, normalizePrompt, scoreDeterministic, classifyDeterministic, analyzeCompound,
        fuseIntent, resolveRequiredCapabilities, baseCapabilitiesForIntent,
        INTENT_BENCHMARK, CLASSES, classIndex, K, DeveloperIntent,
    });
}

main().catch(e => { console.error(e); process.exit(1); });

// ---------------------------------------------------------------------------
// TF-IDF vocabulary (smooth idf, matching sklearn TfidfVectorizer defaults and
// localClassifier.tfidfVector exactly: tf = raw count, idf = ln((1+n)/(1+df))+1).
// ---------------------------------------------------------------------------

function buildVocab(prompts, featuresOf) {
    const df = new Map();
    for (const p of prompts) {
        for (const t of new Set(featuresOf(p))) { df.set(t, (df.get(t) ?? 0) + 1); }
    }
    const terms = [...df.keys()].sort();
    const vocab = {};
    terms.forEach((t, i) => { vocab[t] = i; });
    const n = prompts.length;
    const idf = terms.map(t => Math.log((1 + n) / (1 + df.get(t))) + 1);
    return { vocab, idf, terms };
}

/** Sparse L2-normalized TF-IDF row: array of [col, value] for present terms. */
function vectorize(prompt, vocab, idf, featuresOf) {
    const counts = new Map();
    for (const f of featuresOf(prompt)) {
        const c = vocab[f];
        if (c === undefined) { continue; }
        counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let sumSq = 0;
    const raw = [];
    for (const [c, cnt] of counts) { const v = cnt * idf[c]; raw.push([c, v]); sumSq += v * v; }
    if (sumSq > 0) { const nrm = Math.sqrt(sumSq); for (const r of raw) { r[1] /= nrm; } }
    return raw;
}

// ---------------------------------------------------------------------------
// Multinomial logistic regression via full-batch gradient descent. Deterministic
// (weights start at 0), L2-regularized. Sparse rows keep it fast (< 1s).
// ---------------------------------------------------------------------------

function train(rows, y, K, d, { lr = 1.0, iters = 4000, lambda = 1e-3 } = {}) {
    const W = Array.from({ length: K }, () => new Float64Array(d));
    const b = new Float64Array(K);
    const n = rows.length;
    for (let it = 0; it < iters; it++) {
        const gW = Array.from({ length: K }, () => new Float64Array(d));
        const gb = new Float64Array(K);
        for (let i = 0; i < n; i++) {
            const x = rows[i];
            const logit = new Float64Array(K);
            for (let k = 0; k < K; k++) { let z = b[k]; const wk = W[k]; for (const [j, v] of x) { z += wk[j] * v; } logit[k] = z; }
            let mx = -Infinity; for (let k = 0; k < K; k++) { if (logit[k] > mx) { mx = logit[k]; } }
            let sum = 0; const p = new Float64Array(K);
            for (let k = 0; k < K; k++) { p[k] = Math.exp(logit[k] - mx); sum += p[k]; }
            for (let k = 0; k < K; k++) { p[k] /= sum; }
            for (let k = 0; k < K; k++) {
                const diff = p[k] - (y[i] === k ? 1 : 0);
                const gk = gW[k];
                for (const [j, v] of x) { gk[j] += diff * v; }
                gb[k] += diff;
            }
        }
        for (let k = 0; k < K; k++) {
            const wk = W[k], gk = gW[k];
            for (let j = 0; j < d; j++) { wk[j] -= lr * (gk[j] / n + lambda * wk[j]); }
            b[k] -= lr * (gb[k] / n);
        }
    }
    return { W, b };
}

/** Predicted class index + top prob + full softmax vector for one sparse row. */
function predict(row, W, b, K) {
    const logit = new Float64Array(K);
    for (let k = 0; k < K; k++) { let z = b[k]; const wk = W[k]; for (const [j, v] of row) { z += wk[j] * v; } logit[k] = z; }
    let mx = -Infinity; for (let k = 0; k < K; k++) { if (logit[k] > mx) { mx = logit[k]; } }
    let sum = 0; const p = new Float64Array(K);
    for (let k = 0; k < K; k++) { p[k] = Math.exp(logit[k] - mx); sum += p[k]; }
    for (let k = 0; k < K; k++) { p[k] /= sum; }
    let best = 0; for (let k = 1; k < K; k++) { if (p[k] > p[best]) { best = k; } }
    return { cls: best, conf: p[best], probs: Array.from(p) };
}

// ---------------------------------------------------------------------------
// 5-fold cross-validation. Vocab + idf are REFIT on each training split (no
// leakage), so the out-of-fold predictions are an honest generalization proxy
// and the threshold tuner never sees a case it trained on.
// ---------------------------------------------------------------------------

function crossValidate(cases, labels, K, classIndex, featuresOf, folds = 5) {
    const n = cases.length;
    const oof = new Array(n); // { cls, conf, hasFeat } per held-out case
    for (let f = 0; f < folds; f++) {
        const trIdx = [], teIdx = [];
        for (let i = 0; i < n; i++) { (i % folds === f ? teIdx : trIdx).push(i); }
        const { vocab, idf } = buildVocab(trIdx.map(i => cases[i].prompt), featuresOf);
        const d = idf.length;
        const Xtr = trIdx.map(i => vectorize(cases[i].prompt, vocab, idf, featuresOf));
        const ytr = trIdx.map(i => labels[i]);
        const { W, b } = train(Xtr, ytr, K, d);
        for (const i of teIdx) {
            const row = vectorize(cases[i].prompt, vocab, idf, featuresOf);
            const { cls, conf, probs } = predict(row, W, b, K);
            oof[i] = { cls, conf, probs, hasFeat: row.length > 0 };
        }
    }
    let correct = 0;
    for (let i = 0; i < n; i++) { if (oof[i].cls === labels[i]) { correct++; } }
    return { oof, cvAccuracy: correct / n };
}

// ---------------------------------------------------------------------------
// Combined-pipeline simulation via the SAME fuseIntent the runtime calls, so the
// tuned thresholds score exactly what ships. The ML input is the honest OOF fold
// prediction (no leakage); deterministic evidence + compound analysis are recomputed
// per case. Nothing here re-implements the fusion — it imports it.
// ---------------------------------------------------------------------------

function mlFrom(oof, CLASSES) {
    const probs = {};
    CLASSES.forEach((c, i) => { probs[c] = oof.probs[i]; });
    return { intent: CLASSES[oof.cls], probability: oof.conf, probs, hasFeatures: oof.hasFeat };
}

/** Full fused prediction for one case (fast path replicated, else fuseIntent). */
function combinedFuse(caseObj, ev, oof, trigger, accept, ctx) {
    const { classIndex, CLASSES, DeveloperIntent, fuseIntent } = ctx;
    const trimmed = caseObj.prompt.trim();
    if (trimmed.startsWith('/')) { return { idx: classIndex[DeveloperIntent.TERMINAL_EXECUTION], intent: DeveloperIntent.TERMINAL_EXECUTION, confidence: 1, signals: ['slash_command'] }; }
    if (trimmed.length < 5) { return { idx: classIndex[DeveloperIntent.CODE_GENERATION], intent: DeveloperIntent.CODE_GENERATION, confidence: 0.5, signals: ['short_prompt_fallback'] }; }
    const ml = mlFrom(oof, CLASSES);
    const fused = fuseIntent(ev.evidence, ev.compound, ml, { triggerBelowScore: trigger, acceptProbability: accept });
    return { idx: classIndex[fused.intent], intent: fused.intent, confidence: fused.confidence, signals: fused.signals };
}

const TRIGGERS = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
const ACCEPTS = [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60];

/** Grid-search trigger×accept, maximizing combined accuracy; tie → higher trigger, then accept. */
function tune(cases, labels, evs, oof, ctx) {
    let best = null;
    for (const trigger of TRIGGERS) {
        for (const accept of ACCEPTS) {
            let correct = 0;
            for (let i = 0; i < cases.length; i++) {
                if (combinedFuse(cases[i], evs[i], oof[i], trigger, accept, ctx).idx === labels[i]) { correct++; }
            }
            const acc = correct / cases.length;
            if (!best || acc > best.acc || (acc === best.acc && (trigger > best.trigger || (trigger === best.trigger && accept > best.accept)))) {
                best = { trigger, accept, acc };
            }
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Metrics: confusion matrix, per-class precision/recall/F1, macro-F1, weighted-F1,
// and capability-routing accuracy (intent errors → tool-capability errors).
// ---------------------------------------------------------------------------

function confusionAndF1(labels, preds, K, CLASSES) {
    const cm = Array.from({ length: K }, () => new Array(K).fill(0));
    for (let i = 0; i < labels.length; i++) { cm[labels[i]][preds[i]]++; }
    const per = [];
    let macroF1 = 0, weightedF1 = 0;
    const total = labels.length;
    for (let k = 0; k < K; k++) {
        const tp = cm[k][k];
        let fp = 0, fn = 0, support = 0;
        for (let j = 0; j < K; j++) { if (j !== k) { fp += cm[j][k]; fn += cm[k][j]; } support += cm[k][j]; }
        const precision = tp + fp ? tp / (tp + fp) : 0;
        const recall = tp + fn ? tp / (tp + fn) : 0;
        const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
        per.push({ cls: CLASSES[k], precision, recall, f1, support });
        macroF1 += f1;
        weightedF1 += f1 * support;
    }
    return { cm, per, macroF1: macroF1 / K, weightedF1: weightedF1 / (total || 1) };
}

/**
 * Capability routing accuracy. Expected = the ideal capability set for the TRUE
 * intent; predicted = the set the fused classification actually routes to (real
 * intent + fused confidence + signals, so the code-gen confidence gate and signal
 * sub-rules apply). Reports exact-set match plus micro FP/FN over capabilities —
 * the metric that shows how intent errors translate into wrong tool selection.
 */
function capabilityMetrics(cases, labels, preds, ctx) {
    const { CLASSES, baseCapabilitiesForIntent, resolveRequiredCapabilities } = ctx;
    let exact = 0, fp = 0, fn = 0, expTot = 0, predTot = 0;
    for (let i = 0; i < cases.length; i++) {
        const exp = new Set(baseCapabilitiesForIntent(CLASSES[labels[i]]));
        const p = preds[i];
        const got = new Set(resolveRequiredCapabilities(
            { intent: p.intent, confidence: p.confidence, signals: p.signals },
            { hasOpenFiles: false, workspaceFolder: '', promptLength: cases[i].prompt.length, hasImageAttachments: false, isFollowUp: false },
        ));
        let cfp = 0, cfn = 0;
        for (const c of got) { if (!exp.has(c)) { cfp++; } }
        for (const c of exp) { if (!got.has(c)) { cfn++; } }
        if (cfp === 0 && cfn === 0) { exact++; }
        fp += cfp; fn += cfn; expTot += exp.size; predTot += got.size;
    }
    return { exactMatch: exact / cases.length, fpRate: fp / (predTot || 1), fnRate: fn / (expTot || 1) };
}

// ---------------------------------------------------------------------------
// Orchestrates the whole run: CV → tune → final fit → emit → report.
// ---------------------------------------------------------------------------

function runTraining(ctx) {
    const { featuresOf, scoreDeterministic, analyzeCompound, classifyDeterministic, INTENT_BENCHMARK, CLASSES, classIndex, K } = ctx;
    const cases = INTENT_BENCHMARK;
    const n = cases.length;
    const labels = cases.map(c => classIndex[c.intent]);

    // Per-case deterministic evidence + compound analysis. These depend ONLY on the
    // prompt (exactly as the runtime computes them), so recomputing them leaks nothing.
    const evs = cases.map(c => ({ evidence: scoreDeterministic(c.prompt), compound: analyzeCompound(c.prompt) }));

    // Deterministic-ONLY baseline (no fusion, no model) — how far raw keywords alone get.
    const detOnlyIdx = cases.map(c => classIndex[classifyDeterministic(c.prompt).intent]);
    let detCorrect = 0;
    for (let i = 0; i < n; i++) { if (detOnlyIdx[i] === labels[i]) { detCorrect++; } }
    const detOnlyAcc = detCorrect / n;

    // Honest out-of-fold local predictions (vocab/idf refit per split → no leakage).
    const { oof, cvAccuracy: localCvAccuracy } = crossValidate(cases, labels, K, classIndex, featuresOf);

    // Tune fusion thresholds on the combined pipeline using OOF locals only.
    const best = tune(cases, labels, evs, oof, ctx);

    // Combined pipeline CV predictions at the chosen thresholds + held-out residuals.
    const preds = cases.map((c, i) => combinedFuse(c, evs[i], oof[i], best.trigger, best.accept, ctx));
    let combinedCvCorrect = 0;
    const residual = [];
    for (let i = 0; i < n; i++) {
        if (preds[i].idx === labels[i]) { combinedCvCorrect++; }
        else { residual.push({ prompt: cases[i].prompt, want: CLASSES[labels[i]], got: CLASSES[preds[i].idx], detScore: evs[i].evidence.topScore }); }
    }
    const combinedCvAcc = combinedCvCorrect / n;

    // Full classification + capability-routing metrics on the combined (OOF) predictions.
    const metrics = confusionAndF1(labels, preds.map(p => p.idx), K, CLASSES);
    const capMetrics = capabilityMetrics(cases, labels, preds, ctx);

    // Final model: global vocab/idf, trained on ALL data — this is what ships.
    const { vocab, idf, terms } = buildVocab(cases.map(c => c.prompt), featuresOf);
    const d = idf.length;
    const X = cases.map(c => vectorize(c.prompt, vocab, idf, featuresOf));
    const { W, b } = train(X, labels, K, d);
    let localTrainCorrect = 0;
    for (let i = 0; i < n; i++) { if (predict(X[i], W, b, K).cls === labels[i]) { localTrainCorrect++; } }
    const trainAccuracy = localTrainCorrect / n;

    emitModel({ CLASSES, vocab, idf, W, b, best, n, trainAccuracy, cvAccuracy: combinedCvAcc });
    report({ best, n, terms, CLASSES, K, trainAccuracy, localCvAccuracy, detOnlyAcc, combinedCvAcc, residual, metrics, capMetrics });
}

// ---------------------------------------------------------------------------
// Emit orchestration/intentModel.ts (coef one line per class, everything else
// one line per key — compiles cleanly, stays diff-legible).
// ---------------------------------------------------------------------------

const round = x => Number(x.toFixed(6));

function emitModel({ CLASSES, vocab, idf, W, b, best, n, trainAccuracy, cvAccuracy }) {
    const banner =
        '/*---------------------------------------------------------------------------------------------\n'
        + ' *  Copyright (c) CodeMind. All rights reserved.\n'
        + ' *  Licensed under the MIT License.\n'
        + ' *--------------------------------------------------------------------------------------------*/\n\n'
        + '/* AUTO-GENERATED by node/tools/trainIntentModel.mjs — DO NOT EDIT BY HAND.\n'
        + '   Regenerate after changing intentBenchmark.ts / textNormalize.ts / deterministicIntent.ts. */\n\n'
        + "import type { IntentModel } from './localClassifier.js';\n\n";

    const L = ['export const INTENT_MODEL: IntentModel = {'];
    L.push(`\tversion: ${JSON.stringify('tfidf-logreg-v1')},`);
    L.push(`\tclasses: ${JSON.stringify(CLASSES)},`);
    L.push(`\tvocab: ${JSON.stringify(vocab)},`);
    L.push(`\tidf: ${JSON.stringify(idf.map(round))},`);
    L.push('\tcoef: [');
    for (const row of W) { L.push(`\t\t${JSON.stringify(Array.from(row, round))},`); }
    L.push('\t],');
    L.push(`\tintercept: ${JSON.stringify(Array.from(b, round))},`);
    L.push(`\ttriggerBelowScore: ${best.trigger},`);
    L.push(`\tacceptProbability: ${best.accept},`);
    L.push(`\ttrainedAt: ${JSON.stringify(new Date().toISOString())},`);
    L.push(`\tnumCases: ${n},`);
    L.push(`\ttrainAccuracy: ${round(trainAccuracy)},`);
    L.push(`\tcvAccuracy: ${round(cvAccuracy)},`);
    L.push('};\n');
    writeFileSync(join(ORCH, 'intentModel.ts'), banner + L.join('\n'), 'utf8');
}

function report({ best, n, terms, CLASSES, K, trainAccuracy, localCvAccuracy, detOnlyAcc, combinedCvAcc, residual, metrics, capMetrics }) {
    const pct = x => `${(x * 100).toFixed(1)}%`;
    console.log('\n=== local intent model trained ===');
    console.log(`cases: ${n}   classes: ${K}   vocab terms: ${terms.length}`);
    console.log(`tuned thresholds: triggerBelowScore=${best.trigger}  acceptProbability=${best.accept}`);
    console.log('\n--- accuracy (5-fold, honest out-of-fold) ---');
    console.log(`deterministic-only baseline:      ${pct(detOnlyAcc)}`);
    console.log(`local model (in-sample train):    ${pct(trainAccuracy)}`);
    console.log(`local model 5-fold CV:            ${pct(localCvAccuracy)}`);
    console.log(`COMBINED pipeline 5-fold CV:       ${pct(combinedCvAcc)}   <- what ships`);
    console.log(`macro-F1: ${metrics.macroF1.toFixed(3)}   weighted-F1: ${metrics.weightedF1.toFixed(3)}`);

    // Per-class precision / recall / F1 (sorted by support, descending).
    console.log('\n--- per-class precision / recall / F1 (combined pipeline, OOF) ---');
    const nameW = Math.max(...CLASSES.map(c => c.length), 5);
    console.log(`${'class'.padEnd(nameW)}   prec   recall  f1     support`);
    for (const p of [...metrics.per].sort((a, b) => b.support - a.support)) {
        console.log(`${p.cls.padEnd(nameW)}  ${p.precision.toFixed(2)}   ${p.recall.toFixed(2)}    ${p.f1.toFixed(2)}   ${p.support}`);
    }

    // Confusion matrix (rows = true, cols = predicted; only non-empty rows shown).
    console.log('\n--- confusion matrix (row = true, col = predicted) ---');
    const abbr = CLASSES.map(c => c.split('_').map(w => w[0]).join('').toUpperCase().slice(0, 3));
    console.log(`${''.padEnd(nameW)}  ${abbr.map(a => a.padStart(3)).join(' ')}`);
    for (let r = 0; r < K; r++) {
        const rowSum = metrics.cm[r].reduce((a, v) => a + v, 0);
        if (rowSum === 0) { continue; }
        const cells = metrics.cm[r].map((v, c) => (v === 0 ? '  .' : String(v).padStart(3))).join(' ');
        console.log(`${CLASSES[r].padEnd(nameW)}  ${cells}`);
    }
    console.log(`legend: ${CLASSES.map((c, i) => `${abbr[i]}=${c}`).join('  ')}`);

    // Capability routing accuracy (intent errors → wrong tool-capability selection).
    console.log('\n--- capability routing (true-intent caps vs fused-prediction caps) ---');
    console.log(`exact capability-set match: ${pct(capMetrics.exactMatch)}`);
    console.log(`capability FALSE-POSITIVE rate (over-fetched): ${pct(capMetrics.fpRate)}`);
    console.log(`capability FALSE-NEGATIVE rate (missed):       ${pct(capMetrics.fnRate)}`);

    if (residual.length) {
        console.log(`\n--- held-out residual misclassifications (${residual.length}) ---`);
        for (const r of residual) { console.log(`   - "${r.prompt}"  want=${r.want} got=${r.got} detScore=${r.detScore}`); }
    } else {
        console.log('\nno residual misclassifications on held-out folds.');
    }
    console.log(`\nwrote ${join(ORCH, 'intentModel.ts')}`);
}
