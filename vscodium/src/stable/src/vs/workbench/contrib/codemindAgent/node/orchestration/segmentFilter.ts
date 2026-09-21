/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * PPB Part 2 — P2-T04: Normalisation + Pre-filter.
 *
 * Provides three primitives consumed by segmentQueue (P2-T05):
 *
 *   normalise(text)     — whitespace collapse and Unicode normalisation.
 *   applyPiiRedaction   — redact the four PII patterns: email, bearer token,
 *                         password assignment, PEM block.
 *   shouldIngest(text)  — true iff the segment is worth storing.
 *
 * PII scope (honest about limits):
 *   These four patterns catch the most common accidental secret leaks in
 *   conversation text. Semantic PII (names, phone numbers, postal addresses)
 *   and code secret scanning beyond these patterns are deferred to Part 1.
 *
 * Pure Node; no vscode/electron import.
 */

// ── PII patterns ─────────────────────────────────────────────────────────────

/**
 * Email addresses: user@host.tld
 * Covers the common RFC 5321 local-part characters used in practice.
 */
const RE_EMAIL = /[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi;

/**
 * Bearer tokens in Authorization headers / inline auth strings.
 * Requires at least 20 characters after "bearer " to avoid false positives
 * on short identifiers.
 */
const RE_BEARER = /bearer\s+[a-z0-9\-_.~+/]{20,}/gi;

/**
 * Password assignments: `password: hunter2`, `password=hunter2`,
 * `PASSWORD = "hunter2"`.  Stops at whitespace — does not reach over lines.
 */
const RE_PASSWORD = /password\s*[:=]\s*\S+/gi;

/**
 * PEM private key / certificate blocks.
 * Matches -----BEGIN XXXX-----.....-----END XXXX----- across multiple lines.
 */
const RE_PEM = /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g;

/**
 * Bare POSIX / Windows filesystem path.
 * Matches strings that look entirely like a filesystem path and nothing else.
 * Used in shouldIngest to skip path-only strings that carry no semantic value.
 *
 * Covers:
 *   - Absolute POSIX: /home/user/project/src/foo.ts
 *   - Absolute Windows: C:\Users\user\project\src\foo.ts
 *   - Relative starting with ./ or ../: ./relative/path/to/file.ts
 *
 * Does NOT match paths embedded in prose like "Changed /path/to/file to add logging".
 */
const RE_BARE_PATH = /^(?:\.\.?[\\/]|(?:[A-Za-z]:)?[\\/])(?:[\w. \-]+[\\/])*[\w. \-]*$/;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Normalise a raw text segment:
 *   1. Unicode NFC normalisation.
 *   2. Collapse runs of whitespace (space, tab, CR, LF) to a single space.
 *   3. Trim leading and trailing whitespace.
 *
 * Returns an empty string if the input is empty or whitespace-only.
 */
export function normalise(text: string): string {
	if (!text) { return ''; }
	return text
		.normalize('NFC')
		.replace(/[\t\r\n ]+/g, ' ')
		.trim();
}

/**
 * Apply PII redaction to a text segment.
 *
 * The four patterns (email, bearer, password, PEM) are replaced with a
 * `[REDACTED]` placeholder.  The replacement is applied to the *original*
 * text (not pre-normalised) so that multi-line PEM blocks are caught before
 * the newlines are collapsed.
 *
 * Callers should call `normalise()` on the result if they need whitespace
 * collapsed — e.g. after a PEM block is removed the surrounding text will
 * contain extra whitespace.
 */
export function applyPiiRedaction(text: string): string {
	if (!text) { return ''; }
	return text
		.replace(RE_PEM, '[REDACTED]')       // PEM first: multi-line, must run before whitespace collapse
		.replace(RE_EMAIL, '[REDACTED]')
		.replace(RE_BEARER, 'bearer [REDACTED]')
		.replace(RE_PASSWORD, 'password=[REDACTED]');
}

/**
 * Decide whether a segment is worth ingesting into the PPB pipeline.
 *
 * Returns `false` (skip) when:
 *   - The text is empty or whitespace-only after normalisation.
 *   - The text is a bare filesystem path and nothing else — these carry no
 *     semantic value on their own.
 *
 * Returns `true` for everything else, including short strings like "Use Redis"
 * (the 30-character minimum from earlier designs is removed).
 *
 * @param text - The segment text AFTER PII redaction and normalisation.
 */
export function shouldIngest(text: string): boolean {
	const t = text.trim();
	if (!t) { return false; }
	if (RE_BARE_PATH.test(t)) { return false; }
	return true;
}
