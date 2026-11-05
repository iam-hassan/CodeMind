/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extraction validation, retry and metadata enrichment (P1-T05, spec §7.5/§7.7/§7.12).
 *
 * - All model output is validated against the structured-output schema before acceptance (§7.7).
 * - Malformed output is rejected and retried; retries exhausted are logged, never silent (§7.7).
 * - Facts that pass validation are enriched with the §7.5 metadata contract before deduplication.
 *
 * The concrete retry counts/backoff are PLACEHOLDERS — the source document leaves them open
 * (§7.7/§32). The empty-result case is first-class: non-engineering content yields zero facts
 * (§7.6, §21 M2, acceptance criterion #2).
 */

import { randomUUID } from 'crypto';
import type { ConversationSegment } from '../../orchestration/segmentQueue.js';
import { GRAPH_RELATIONSHIP_TYPES, MEMORY_CATEGORIES, type GraphRelationshipType, type MemoryCategory } from '../ontology.js';
import type { LlmClient } from '../llm/client.js';
import { callExtractionModel } from './extractor.js';
import type { ExtractedFact, ExtractedRelationship, ExtractionResult, Extractor } from './types.js';

/** A validated fact from the model, before metadata enrichment. */
export interface ExtractionDraft {
	readonly category: MemoryCategory;
	readonly content: string;
	readonly confidence?: number;
	readonly importance?: number;
	readonly author?: string;
}

export class ExtractionValidationError extends Error {
	constructor(message: string, readonly reasons: readonly string[]) {
		super(message);
		this.name = 'ExtractionValidationError';
	}
}

/** PLACEHOLDER defaults — the source document leaves the scales open (§7.5/§32). */
const DEFAULT_CONFIDENCE = 0.5;
const DEFAULT_IMPORTANCE = 0.5;

export interface ExtractionPolicy {
	/** Total model attempts per segment (initial + retries). PLACEHOLDER (§7.7/§32). */
	readonly maxAttempts: number;
	/** Linear backoff base between attempts, in ms. PLACEHOLDER (§7.7/§32). */
	readonly backoffMs: number;
}

export const DEFAULT_EXTRACTION_POLICY: ExtractionPolicy = { maxAttempts: 3, backoffMs: 250 };

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Strips a ```json fence when a model wraps its JSON despite the JSON-only instruction. */
function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith('```')) {
		return trimmed;
	}
	return trimmed.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
}

export interface ParsedExtraction {
	readonly drafts: ExtractionDraft[];
	readonly relationships: ExtractedRelationship[];
}

/**
 * Validates raw model text against the structured-output schema and returns drafts + relationships.
 * Fact violations throw `ExtractionValidationError` (retried, §7.7). Relationships are secondary
 * and are parsed leniently: an invalid one is dropped rather than failing the whole extraction, so
 * a good fact set is never lost over a bad edge.
 */
export function parseExtractionPayloadFull(text: string): ParsedExtraction {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripCodeFence(text));
	} catch (error) {
		throw new ExtractionValidationError(
			'extraction output was not valid JSON',
			[error instanceof Error ? error.message : String(error)]
		);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ExtractionValidationError('extraction output must be a JSON object', ['expected {"facts": [...]}']);
	}
	const facts = (parsed as { facts?: unknown }).facts;
	if (!Array.isArray(facts)) {
		throw new ExtractionValidationError('extraction output is missing the "facts" array', ['facts must be an array']);
	}

	const reasons: string[] = [];
	const drafts: ExtractionDraft[] = [];
	facts.forEach((entry, index) => {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			reasons.push(`facts[${index}] is not an object`);
			return;
		}
		const record = entry as Record<string, unknown>;
		const category = record.category;
		if (typeof category !== 'string' || !(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
			reasons.push(`facts[${index}].category is not one of the six categories`);
			return;
		}
		const content = record.content;
		if (typeof content !== 'string' || content.trim().length === 0) {
			reasons.push(`facts[${index}].content must be a non-empty string`);
			return;
		}
		for (const field of ['confidence', 'importance'] as const) {
			const value = record[field];
			if (value !== undefined && (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1)) {
				reasons.push(`facts[${index}].${field} must be a number in [0,1]`);
			}
		}
		if (record.author !== undefined && typeof record.author !== 'string') {
			reasons.push(`facts[${index}].author must be a string`);
		}
		drafts.push({
			category: category as MemoryCategory,
			content: content.trim(),
			confidence: typeof record.confidence === 'number' ? record.confidence : undefined,
			importance: typeof record.importance === 'number' ? record.importance : undefined,
			author: typeof record.author === 'string' ? record.author : undefined
		});
	});
	if (reasons.length > 0) {
		throw new ExtractionValidationError('extraction output failed schema validation', reasons);
	}

	return { drafts, relationships: parseRelationships((parsed as { relationships?: unknown }).relationships) };
}

/** Lenient relationship parsing — invalid entries are dropped, never fatal (Tier 2). */
function parseRelationships(value: unknown): ExtractedRelationship[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const relationships: ExtractedRelationship[] = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const type = record.type;
		const from = record.from;
		const to = record.to;
		if (typeof type !== 'string' || !(GRAPH_RELATIONSHIP_TYPES as readonly string[]).includes(type)) {
			continue;
		}
		if (typeof from !== 'string' || from.trim().length === 0 || typeof to !== 'string' || to.trim().length === 0) {
			continue;
		}
		relationships.push({ relationshipType: type as GraphRelationshipType, fromName: from.trim(), toName: to.trim() });
	}
	return relationships;
}

/** Backwards-compatible wrapper returning only the drafts (relationships are available via the full form). */
export function parseExtractionPayload(text: string): ExtractionDraft[] {
	return parseExtractionPayloadFull(text).drafts;
}

export interface EnrichmentOptions {
	readonly now?: () => Date;
	readonly newId?: () => string;
}

/** Attaches the §7.5 metadata contract to each validated fact (§7.8 hand-off to dedup). */
export function enrichFacts(drafts: readonly ExtractionDraft[], segment: ConversationSegment, options: EnrichmentOptions = {}): ExtractedFact[] {
	const now = options.now ?? (() => new Date());
	const newId = options.newId ?? (() => randomUUID());
	const extractedAt = now().toISOString();
	return drafts.map(draft => ({
		id: newId(),
		category: draft.category,
		content: draft.content,
		confidence: draft.confidence ?? DEFAULT_CONFIDENCE,
		importance: draft.importance ?? DEFAULT_IMPORTANCE,
		sourceRef: `${segment.projectId}:${segment.turnId}`,
		author: draft.author ?? segment.role,
		extractedAt
	}));
}

export interface PpbExtractorOptions extends EnrichmentOptions {
	readonly client: LlmClient;
	readonly policy?: ExtractionPolicy;
	readonly log?: (message: string) => void;
}

/** The real extraction engine (T05): model call → validation → retry → metadata enrichment. */
export class PpbExtractor implements Extractor {

	private readonly _client: LlmClient;
	private readonly _policy: ExtractionPolicy;
	private readonly _log: (message: string) => void;
	private readonly _enrichment: EnrichmentOptions;

	constructor(options: PpbExtractorOptions) {
		this._client = options.client;
		this._policy = options.policy ?? DEFAULT_EXTRACTION_POLICY;
		this._log = options.log ?? (() => { });
		this._enrichment = { now: options.now, newId: options.newId };
	}

	async extract(segment: ConversationSegment): Promise<ExtractionResult> {
		let lastFailure = 'unknown failure';
		for (let attempt = 1; attempt <= this._policy.maxAttempts; attempt++) {
			try {
				const raw = await callExtractionModel(this._client, segment);
				const parsed = parseExtractionPayloadFull(raw);
				return { segmentId: segment.turnId, facts: enrichFacts(parsed.drafts, segment, this._enrichment), relationships: parsed.relationships };
			} catch (error) {
				lastFailure = error instanceof Error ? error.message : String(error);
				if (attempt < this._policy.maxAttempts) {
					await delay(this._policy.backoffMs * attempt);
				}
			}
		}
		// Never silently dropped: the failure is traced, and the segment yields no facts (§7.7/§24).
		this._log(`ppb: extraction failed for turn ${segment.turnId} after ${this._policy.maxAttempts} attempt(s): ${lastFailure}`);
		return { segmentId: segment.turnId, facts: [] };
	}
}
