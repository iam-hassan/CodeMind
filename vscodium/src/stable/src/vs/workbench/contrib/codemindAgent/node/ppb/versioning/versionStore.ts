/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Memory versioning (P1-T11, spec §13).
 *
 * The Active/Archived/Superseded lifecycle. Conflicts never overwrite silently (§13): on an
 * accepted migration the existing memory moves to `Archived`, the incoming fact becomes a new
 * `Active` memory linked via `SUPERSEDES`, and a `memory_versions` audit row records the
 * transition. Nothing is ever hard-deleted (§13.9). Each status change also queues a graph
 * projection so the Neo4j node reflects the new status (§6.7).
 */

import { randomUUID } from 'crypto';
import type { ExtractedFact } from '../extraction/types.js';
import type { MemoryVersionState } from '../ontology.js';
import { getFact, type MemoryRecord, type ReadQueryable } from '../storage/read.js';
import { persistFacts, type WriteQueryable } from '../storage/write.js';

export type ConfirmationOutcome = 'accept_migration' | 'keep_existing' | 'discard_incoming';

export class VersioningError extends Error {
	constructor(message: string, readonly code: 'not-found' | 'invalid-outcome') {
		super(message);
		this.name = 'VersioningError';
	}
}

interface Options {
	readonly now?: () => Date;
	readonly reason?: string;
}

function nowIso(options: Options): string {
	return (options.now ?? (() => new Date()))().toISOString();
}

function queueGraphStatus(client: WriteQueryable, memory: MemoryRecord, now: string): Promise<unknown> {
	return client.query(
		`INSERT INTO neo4j_outbox (id, event_type, payload, created_at) VALUES ($1, 'memory_upsert', $2, $3)`,
		[randomUUID(), JSON.stringify({ factId: memory.id, projectId: memory.projectId, category: memory.category }), now]
	);
}

/** Transition a memory's status and record the audit row (§13.2). Returns rows updated (0/1). */
async function transition(
	client: WriteQueryable,
	projectId: string,
	id: string,
	to: MemoryVersionState,
	options: Options & { readonly supersededBy?: string }
): Promise<number> {
	const memory = await getFact(client as unknown as ReadQueryable, projectId, id);
	if (!memory) {
		return 0;
	}
	const now = nowIso(options);
	const result = await client.query(
		`UPDATE memories SET status = $3, superseded_by = COALESCE($4, superseded_by), updated_at = $5 WHERE project_id = $1 AND id = $2 RETURNING id`,
		[projectId, id, to, options.supersededBy ?? null, now]
	);
	if (result.rows.length === 0) {
		return 0;
	}
	await client.query(
		`INSERT INTO memory_versions (id, memory_id, from_status, to_status, reason, recorded_at) VALUES ($1, $2, $3, $4, $5, $6)`,
		[randomUUID(), id, memory.status, to, options.reason ?? null, now]
	);
	await queueGraphStatus(client, { ...memory, status: to }, now);
	if (options.supersededBy !== undefined) {
		// Mirror the replacement as a graph edge so history is traversable (spec §6.8/§13/§17).
		await client.query(
			`INSERT INTO neo4j_outbox (id, event_type, payload, created_at) VALUES ($1, 'memory_supersedes', $2, $3)`,
			[randomUUID(), JSON.stringify({ memoryId: id, supersededById: options.supersededBy, projectId }), now]
		);
	}
	return 1;
}

/** Active → Archived (§13.2). */
export function archiveMemory(client: WriteQueryable, projectId: string, id: string, options: Options & { readonly supersededBy?: string } = {}): Promise<number> {
	return transition(client, projectId, id, 'archived', { reason: options.reason ?? 'archived', ...options });
}

/** Active → Superseded, linked to the replacing memory (§13.2/§13.7). */
export function supersedeMemory(client: WriteQueryable, projectId: string, id: string, supersededBy: string, options: Options = {}): Promise<number> {
	return transition(client, projectId, id, 'superseded', { supersededBy, reason: options.reason ?? `superseded by ${supersededBy}` });
}

/** Any state → Active (used when an incoming fact is accepted). */
export function activateMemory(client: WriteQueryable, projectId: string, id: string, options: Options = {}): Promise<number> {
	return transition(client, projectId, id, 'active', { reason: options.reason ?? 'activated' });
}

export interface ResolutionResult {
	/** The memory that is Active after resolution. */
	readonly activeId: string | undefined;
	/** The incoming fact's new memory id, when it was accepted. */
	readonly incomingId?: string;
	readonly applied: boolean;
}

/**
 * Apply an IF-4 confirmation outcome (§12.7/§13.2/§13.3):
 *  - `accept_migration`: persist the incoming fact (Active), archive the existing one and link it;
 *  - `keep_existing` / `discard_incoming`: no storage change — the existing memory stays Active.
 */
export async function applyConfirmation(
	client: WriteQueryable,
	projectId: string,
	existingId: string,
	incoming: ExtractedFact,
	outcome: ConfirmationOutcome,
	options: Options = {}
): Promise<ResolutionResult> {
	if (outcome === 'keep_existing' || outcome === 'discard_incoming') {
		// §13.3 — the existing memory remains Active; the incoming fact is not activated.
		return { activeId: existingId, applied: false };
	}
	if (outcome !== 'accept_migration') {
		throw new VersioningError(`unknown confirmation outcome: ${String(outcome)}`, 'invalid-outcome');
	}

	const existing = await getFact(client as unknown as ReadQueryable, projectId, existingId);
	if (!existing) {
		throw new VersioningError(`memory ${existingId} not found in project ${projectId}`, 'not-found');
	}
	// Persist the incoming fact as the new Active memory (queues its own projection).
	const written = await persistFacts(client, projectId, [incoming], options.now ? { now: options.now } : undefined);
	const incomingId = written.results[0].factId;
	// Archive the replaced memory and link it to its replacement (§13.2/§6.9 — no overwrite).
	await transition(client, projectId, existingId, 'archived', { supersededBy: incomingId, reason: options.reason ?? `replaced by ${incomingId}` });
	return { activeId: incomingId, incomingId, applied: true };
}