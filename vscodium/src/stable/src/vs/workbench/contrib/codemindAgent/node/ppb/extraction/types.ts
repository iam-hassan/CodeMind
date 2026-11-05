/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extraction seam types (P1-T04/T05, spec §7.3/§7.5, IF-2).
 *
 * The exact extraction payload is finalized at T04 (§18.5); every field below comes from the
 * §7.5 metadata contract (`SHARED_MEMORY_METADATA`) plus the category (§7.4) and content.
 */

import type { GraphRelationshipType, MemoryCategory } from '../ontology.js';
import type { ConversationSegment } from '../../orchestration/segmentQueue.js';

/** IF-2 — a single extracted fact carrying the full §7.5 metadata contract. */
export interface ExtractedFact {
	readonly id: string;
	readonly category: MemoryCategory;
	readonly content: string;
	readonly confidence: number;
	readonly importance: number;
	readonly sourceRef: string;
	readonly author: string;
	readonly extractedAt: string;
}

/**
 * Tier 2 — a relationship the model inferred *between* extracted facts. Endpoints are entity
 * **names** as they appear in the facts, or the sentinel `@@project` for the project hub. The
 * resolver maps a name to the fact's node id and drops anything it cannot ground.
 */
export const PROJECT_ENDPOINT = '@@project';

export interface ExtractedRelationship {
	readonly relationshipType: GraphRelationshipType;
	readonly fromName: string;
	readonly toName: string;
}

/** IF-2 — the extraction result for one conversation segment. Relationships are optional (Tier 2). */
export interface ExtractionResult {
	readonly segmentId: string;
	readonly facts: readonly ExtractedFact[];
	readonly relationships?: readonly ExtractedRelationship[];
}

/**
 * The extraction boundary. The M2 stub returns an empty fact set so Part 2's ingestion path can
 * run end-to-end before the real extraction engine exists (spec §21 M2).
 * The real implementation is `PpbExtractor` (`validate.ts`, T05).
 */
export interface Extractor {
	extract(segment: ConversationSegment): Promise<ExtractionResult>;
}
