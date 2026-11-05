/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Conflict detection (C1.5, P1-T10, spec §12).
 *
 * Reuses Deduplication's candidate set and classifier (§8.9/§12.2) to identify contradictions,
 * and builds the IF-3 confirmation payload — the existing memory, the incoming fact, the category,
 * a severity and the question text — that Part 2 transports to Part 3's dialog. Severity is a
 * PLACEHOLDER two-level split (genuine migration vs. ambiguous/hypothetical) per §12.4/§12.5.
 */

import { classifyFact, findDedupCandidates, type DedupOptions } from '../extraction/dedup.js';
import type { ExtractedFact } from '../extraction/types.js';
import type { MemoryCategory } from '../ontology.js';
import type { MemoryRecord, ReadQueryable } from '../storage/read.js';
import type { WriteQueryable } from '../storage/write.js';

export type ConflictSeverity = 'genuine' | 'ambiguous';

export interface ConflictReport {
	readonly projectId: string;
	readonly existing: MemoryRecord;
	readonly incoming: ExtractedFact;
	readonly category: MemoryCategory;
	readonly severity: ConflictSeverity;
	readonly question: string;
}

/** Hypothetical/uncertain phrasing → ambiguous rather than a genuine migration (§12.5). PLACEHOLDER. */
const AMBIGUOUS_PATTERN = /\b(what if|maybe|perhaps|might|could|hypothetical|considering|thinking about|should we)\b/i;

/** Build an IF-3 report when the incoming fact contradicts an existing same-category memory (§12.3). */
export function detectConflict(existing: MemoryRecord, incoming: ExtractedFact, options: DedupOptions = {}): ConflictReport | undefined {
	if (existing.category !== incoming.category) {
		return undefined;
	}
	const decision = classifyFact(incoming.content, incoming.category, [existing], options);
	if (decision.outcome !== 'contradiction') {
		return undefined;
	}
	const severity: ConflictSeverity = AMBIGUOUS_PATTERN.test(incoming.content) ? 'ambiguous' : 'genuine';
	return {
		projectId: existing.projectId,
		existing,
		incoming,
		category: incoming.category,
		severity,
		question: `Existing knowledge: "${existing.content}". Incoming: "${incoming.content}". Accept the change (archive the existing memory), keep the existing memory, or discard the incoming fact?`
	};
}

/** Candidate lookup (shared with dedup) then contradiction detection (§12.2). */
export async function findConflict(client: ReadQueryable, projectId: string, incoming: ExtractedFact, options: DedupOptions = {}): Promise<ConflictReport | undefined> {
	const candidates = await findDedupCandidates(client, projectId, incoming.category);
	for (const candidate of candidates) {
		const report = detectConflict(candidate, incoming, options);
		if (report) {
			return report;
		}
	}
	return undefined;
}

/** Persist a pending confirmation request for audit/transport (§12.6, IF-3). Returns its id. */
export async function persistConflictReport(client: WriteQueryable, report: ConflictReport, now: Date = new Date()): Promise<string> {
	const id = crypto.randomUUID();
	await client.query(
		`INSERT INTO conflict_reports (id, project_id, existing_memory_id, incoming_payload, category, severity, question, status, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
		[id, report.projectId, report.existing.id, JSON.stringify(report.incoming), report.category, report.severity, report.question, now.toISOString()]
	);
	return id;
}