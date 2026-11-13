/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Central secret redaction (spec §8 "no secrets injected", §11 "API keys not logged").
 *
 * Every logging/telemetry/injection path that can carry free-form text passes through here so a
 * credential cannot leak merely because a future caller serialised a request or an error. The
 * helper is deliberately conservative: it only masks credential-shaped substrings, never ordinary
 * prose, so stored knowledge stays readable.
 */

/** Replacement marker. Stable so tests and operators can grep for redactions. */
export const REDACTED = '[REDACTED]';

/** Keys whose value is always a secret, regardless of the value's shape. */
const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|private[_-]?key)(?:$|[_-])/i;

/**
 * Credential-shaped substrings. Ordered from most specific to least, and each replacement keeps
 * enough of the label to stay diagnosable (`Bearer [REDACTED]`).
 */
const PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly replace: (...args: string[]) => string }> = [
	// OpenAI-style keys (sk-..., sk-proj-..., sk-ant-...) and other long `sk_` keys.
	{ pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTED },
	{ pattern: /\bsk_[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTED },
	// GitHub tokens.
	{ pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: () => REDACTED },
	// AWS access key ids.
	{ pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REDACTED },
	// Slack bot/user tokens.
	{ pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => REDACTED },
	// Authorization: Bearer <token> — keep the scheme so the log stays readable.
	{ pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, replace: (_match, prefix) => `${prefix}${REDACTED}` },
	// `authorization: ...` / `x-api-key: ...` header values. A Bearer value is already handled
	// above (and keeps its scheme), so this only masks the raw-value form.
	{ pattern: /\b(authorization|proxy-authorization|x-api-key)\s*:\s*(?!Bearer\b)[^\s,;"']+/gi, replace: (_match, key) => `${key}: ${REDACTED}` },
	// key=value / key: value forms in JSON, query strings and prose-like logs. Quotes around the
	// key (`"api_key": "…"`) are preserved so the output stays well-formed.
	{ pattern: /("?)(\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b)("?)(\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&}"']+)/gi, replace: (_match, open, key, close, separator) => `${open}${key}${close}${separator}${REDACTED}` },
	// Credentials embedded in a URL (https://user:pass@host).
	{ pattern: /(:\/\/)[^/\s:@]+:[^/\s@]+@/g, replace: (_match, scheme) => `${scheme}${REDACTED}@` }
];

/** Mask credential-shaped values inside one string. */
export function redact(text: string): string {
	if (typeof text !== 'string' || text.length === 0) {
		return text;
	}
	let result = text;
	for (const { pattern, replace } of PATTERNS) {
		result = result.replace(pattern, replace as never);
	}
	return result;
}

/** True when an object key names a secret (its value is always masked). */
function isSecretKey(key: string): boolean {
	const normalised = key.toLowerCase();
	return SECRET_KEY.test(normalised)
		|| normalised === 'apikey'
		|| normalised === 'authorization'
		|| normalised === 'password'
		|| normalised === 'token'
		|| normalised === 'secret';
}

/**
 * Deep-copy a JSON-like value with secrets masked. Arrays and plain objects are walked; a key that
 * names a credential has its whole value replaced so an unlabelled secret (e.g. a raw token in an
 * `authorization` field) cannot survive. Non-plain values are returned unchanged.
 */
export function redactValue<T>(value: T, depth: number = 0): T {
	if (depth > 20) {
		return value;
	}
	if (typeof value === 'string') {
		return redact(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map(entry => redactValue(entry, depth + 1)) as unknown as T;
	}
	if (value !== null && typeof value === 'object') {
		if (value instanceof Error) {
			return redact(value.message) as unknown as T;
		}
		const copy: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			copy[key] = isSecretKey(key) ? REDACTED : redactValue(entry, depth + 1);
		}
		return copy as T;
	}
	return value;
}

/** Serialise a telemetry/log payload with secrets masked. Never throws. */
export function redactJson(value: unknown): string {
	try {
		return JSON.stringify(redactValue(value ?? {}));
	} catch {
		return JSON.stringify({ redactionError: true });
	}
}
