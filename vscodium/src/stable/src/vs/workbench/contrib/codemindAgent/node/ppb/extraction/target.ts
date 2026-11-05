/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extraction target resolution (OD-6, spec §7.6).
 *
 * The extraction model is **derived from the editor's active model selection** — the model,
 * endpoint and credentials the agent itself is running against — so PPB carries no separate
 * model configuration of its own. `PPB_EXTRACT_*` (`config.ts`) is retained as a dev/test
 * override and wins per field when set: an override model pins the whole target, which is what
 * the gated integration suite relies on to reach a self-contained endpoint.
 */

/** An OpenAI-compatible chat endpoint to run extraction against. */
export interface ExtractionTarget {
	readonly model: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
}

/** Trimmed first-non-empty: absent and whitespace-only both mean "not supplied". */
function firstNonEmpty(a: string | undefined, b: string | undefined): string {
	return (a ?? '').trim() || (b ?? '').trim();
}

/**
 * The extraction client speaks the OpenAI shape (`{base}/chat/completions`), but the editor's
 * endpoint is Anthropic-shaped (`{base}/v1/messages`). When the base URL is derived from the
 * panel we append the version segment, so the user only configures the provider once. An explicit
 * `PPB_EXTRACT_BASE_URL` override is always used verbatim.
 */
function ensureOpenAiVersion(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, '');
	return /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Resolve the effective extraction target. The dev/test override wins per field, otherwise the
 * active selection is used.
 *
 * Returns `undefined` when no usable model + endpoint pair exists — the caller then keeps the M2
 * stub in place, so PPB stays inert when it is enabled but nothing has been selected yet
 * (§21 M2).
 */
export function resolveExtractionTarget(
	active: ExtractionTarget | undefined,
	override: ExtractionTarget | undefined
): ExtractionTarget | undefined {
	const model = firstNonEmpty(override?.model, active?.model);
	const overrideBase = (override?.baseUrl ?? '').trim();
	let baseUrl = overrideBase || (active?.baseUrl ?? '').trim();
	if (!model || !baseUrl) {
		return undefined;
	}
	if (!overrideBase) {
		baseUrl = ensureOpenAiVersion(baseUrl);
	}
	const apiKey = firstNonEmpty(override?.apiKey, active?.apiKey);
	return apiKey ? { model, baseUrl, apiKey } : { model, baseUrl };
}