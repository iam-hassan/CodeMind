/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Prompt normalization + tokenization (Phase-2 re-evaluation, Layer 1).
 *
 * IMPORTANT: normalization is used ONLY by the local second-stage classifier and
 * by the benchmark/trainer. The deterministic keyword scorer still runs on the
 * RAW prompt, so its pinned confidences are byte-for-byte unchanged. Normalizing
 * here is what lets "Add Clerk", "Please add Clerk", and "Can you add Clerk?"
 * collapse to the same feature vector — semantic equivalence, not exact wording.
 */

/** Common English contractions expanded so tokens match across phrasings. */
const CONTRACTIONS: ReadonlyArray<[RegExp, string]> = [
    [/\bcan't\b/g, 'cannot'], [/\bwon't\b/g, 'will not'], [/\bn't\b/g, ' not'],
    [/\blet's\b/g, 'let us'], [/\bi'm\b/g, 'i am'], [/\bwe're\b/g, 'we are'],
    [/\byou're\b/g, 'you are'], [/\bit's\b/g, 'it is'], [/\bthat's\b/g, 'that is'],
    [/\bwhat's\b/g, 'what is'], [/\bhow's\b/g, 'how is'], [/\bwhere's\b/g, 'where is'],
    [/\bi've\b/g, 'i have'], [/\bwe've\b/g, 'we have'], [/\bthey're\b/g, 'they are'],
    [/\bdon't\b/g, 'do not'], [/\bdoesn't\b/g, 'does not'], [/\bdidn't\b/g, 'did not'],
];

/**
 * Lowercase, expand contractions, strip punctuation to spaces, collapse runs of
 * whitespace. Deterministic and side-effect free.
 */
export function normalizePrompt(raw: string): string {
    let s = (raw || '').toLowerCase();
    for (const [re, rep] of CONTRACTIONS) { s = s.replace(re, rep); }
    s = s.replace(/[^a-z0-9\s]/g, ' ');   // punctuation → space
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

/** Very small stopword set — kept short so short prompts still yield features. */
const STOPWORDS = new Set([
    'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
    'be', 'this', 'that', 'it', 'me', 'my', 'please', 'can', 'could', 'would',
    'should', 'will', 'do', 'does', 'did', 'i', 'you', 'so', 'with', 'at',
]);

/**
 * Tokenize a normalized prompt into unigrams + adjacent bigrams. Bigrams capture
 * short semantic phrases ("add auth", "switch database", "run tests") that a
 * bag-of-unigrams would miss. Stopwords are dropped from unigrams but retained
 * inside bigrams (so "set up" survives as one feature).
 */
export function tokenize(normalized: string): string[] {
    const words = normalized.split(' ').filter(Boolean);
    const unigrams = words.filter(w => w.length >= 2 && !STOPWORDS.has(w));
    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
        bigrams.push(words[i] + '_' + words[i + 1]);
    }
    return [...unigrams, ...bigrams];
}

/** Convenience: normalize then tokenize. */
export function featuresOf(raw: string): string[] {
    return tokenize(normalizePrompt(raw));
}
