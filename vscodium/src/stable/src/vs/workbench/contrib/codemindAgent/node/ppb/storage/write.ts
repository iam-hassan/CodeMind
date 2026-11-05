/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The PPB write path (P1-T04/T05 persist, spec §9.1/§9.5/§24).
 *
 * Persists enriched facts (`ExtractedFact[]`) into PostgreSQL — the source of truth — and queues
 * the graph projection for asynchronous application:
 *
 * - The whole batch runs in one transaction: a failure rolls everything back (§24).
 * - `memories` holds the current fact; `memory_versions` appends an immutable version row.
 * - `neo4j_outbox` receives the projection event for the async projector (eventual consistency,
 *   idempotent re-projection) — there is no cross-store transaction (§24 resolution).
 *
 * The query surface is injected (as with the migration runner) so the service is unit-testable
 * without a live database and no raw SQL leaks outside the storage layer (§6.7/§9.5).
 * T06 deduplication is NOT applied here — identical facts are re-persisted as a new version.
 */

import { randomUUID } from 'crypto';
import type { ExtractedFact, ExtractedRelationship } from '../extraction/types.js';
import { PROJECT_ENDPOINT } from '../extraction/types.js';
import type { GraphRelationshipType } from '../ontology.js';

/** Minimal query surface — satisfied by a `pg.Client`; keeps the service injectable/testable. */
export interface WriteQueryable {
	query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export class PersistenceError extends Error {
	constructor(message: string, readonly code: 'transaction-failed' | 'write-failed') {
		super(message);
		this.name = 'PersistenceError';
	}
}

/** Outcome for one fact. */
export interface WriteResult {
	readonly factId: string;
	readonly status: 'inserted' | 'updated';
}

/** Batch outcome — exactly one entry per input fact, order-preserving. */
export interface BatchWriteResult {
	readonly projectId: string;
	readonly results: readonly WriteResult[];
}

/** Insert one fact, or refresh an existing identical (category, content) memory (§12.4: not dedup). */
async function upsertFact(
	client: WriteQueryable,
	projectId: string,
	fact: ExtractedFact,
	now: string
): Promise<{ factId: string; status: 'inserted' | 'updated' }> {
	const existing = await client.query(
		`SELECT id FROM memories WHERE project_id = $1 AND category = $2 AND content = $3`,
		[projectId, fact.category, fact.content]
	);
	if (existing.rows.length > 0) {
		const factId = String(existing.rows[0].id);
		await client.query(
			`INSERT INTO memory_versions (id, memory_id, from_status, to_status, reason, recorded_at)
			 VALUES ($1, $2, 'active', 'active', $3, $4)`,
			[randomUUID(), factId, `reconfirmed (${fact.sourceRef})`, now]
		);
		await client.query(
			`UPDATE memories SET confidence = $2, importance = $3, author = $4, source_ref = $5, updated_at = $6 WHERE id = $1`,
			[factId, fact.confidence, fact.importance, fact.author, fact.sourceRef, now]
		);
		return { factId, status: 'updated' };
	}

	const factId = randomUUID();
	await client.query(
		`INSERT INTO memories (id, project_id, category, content, confidence, importance, source_ref, author, extracted_at, status, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $10)`,
		[factId, projectId, fact.category, fact.content, fact.confidence, fact.importance, fact.sourceRef, fact.author, fact.extractedAt, now]
	);
	await client.query(
		`INSERT INTO memory_versions (id, memory_id, from_status, to_status, reason, recorded_at)
		 VALUES ($1, $2, NULL, 'active', $3, $4)`,
		[randomUUID(), factId, `created (${fact.sourceRef})`, now]
	);
	await client.query(
		`INSERT INTO neo4j_outbox (id, event_type, payload, created_at)
		 VALUES ($1, 'memory_upsert', $2, $3)`,
		[randomUUID(), JSON.stringify({ factId, projectId, category: fact.category }), now]
	);
	return { factId, status: 'inserted' };
}

/**
 * Persist a batch of facts for one project inside a single transaction.
 * Throws `PersistenceError` if the transaction itself fails (the batch is rolled back).
 */
export async function persistFacts(
	client: WriteQueryable,
	projectId: string,
	facts: readonly ExtractedFact[],
	options?: { readonly now?: () => Date }
): Promise<BatchWriteResult> {
	const now = (options?.now ?? (() => new Date()))().toISOString();
	if (facts.length === 0) {
		return { projectId, results: [] };
	}
	const results: WriteResult[] = [];
	try {
		await client.query('BEGIN');
		for (const fact of facts) {
			// A failed statement aborts the PostgreSQL transaction, so the catch below rolls the
			// whole batch back — never a per-fact partial commit (§24).
			const outcome = await upsertFact(client, projectId, fact, now);
			results.push({ factId: outcome.factId, status: outcome.status });
		}
		await client.query('COMMIT');
		return { projectId, results };
	} catch (error) {
		try { await client.query('ROLLBACK'); } catch { /* ignore rollback failure */ }
		throw new PersistenceError(
			`persistFacts transaction failed: ${error instanceof Error ? error.message : String(error)}`,
			'transaction-failed'
		);
	}
}

// --- Tier 2: extracted graph relationships (§6.4/§6.8) ---------------------------------------

/** A relationship whose endpoint names have been resolved to concrete memory / project ids. */
export interface ResolvedRelationship {
	readonly fromId: string;
	readonly toId: string;
	readonly relationshipType: GraphRelationshipType;
}

/** Ground an entity name to the node id of the first extracted fact whose content mentions it. */
function matchFactId(name: string, facts: readonly ExtractedFact[], factIds: readonly string[]): string | undefined {
	const needle = name.trim().toLowerCase();
	if (needle.length === 0) {
		return undefined;
	}
	for (let index = 0; index < facts.length && index < factIds.length; index++) {
		if (facts[index].content.toLowerCase().includes(needle)) {
			return factIds[index];
		}
	}
	return undefined;
}

/**
 * Map model-emitted relationships (entity names) onto the persisted fact ids. Anything that cannot
 * be grounded to a fact (or the project sentinel) is dropped — the layer never invents an edge.
 */
export function resolveRelationships(
	projectId: string,
	relationships: readonly ExtractedRelationship[],
	facts: readonly ExtractedFact[],
	factIds: readonly string[]
): ResolvedRelationship[] {
	const resolved: ResolvedRelationship[] = [];
	const seen = new Set<string>();
	for (const relationship of relationships) {
		const fromId = relationship.fromName === PROJECT_ENDPOINT ? projectId : matchFactId(relationship.fromName, facts, factIds);
		const toId = relationship.toName === PROJECT_ENDPOINT ? projectId : matchFactId(relationship.toName, facts, factIds);
		if (fromId === undefined || toId === undefined || fromId === toId) {
			continue;
		}
		const key = `${fromId}|${relationship.relationshipType}|${toId}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		resolved.push({ fromId, toId, relationshipType: relationship.relationshipType });
	}
	return resolved;
}

/** Persist resolved relationships (source of truth) and queue their graph projection (idempotent). */
export async function persistRelationships(
	client: WriteQueryable,
	projectId: string,
	relationships: readonly ResolvedRelationship[],
	options?: { readonly now?: () => Date }
): Promise<number> {
	if (relationships.length === 0) {
		return 0;
	}
	const now = (options?.now ?? (() => new Date()))().toISOString();
	let count = 0;
	for (const relationship of relationships) {
		await client.query(
			`INSERT INTO graph_relationships (id, project_id, from_id, relationship_type, to_id, properties, created_at)
			 VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6)
			 ON CONFLICT (project_id, from_id, relationship_type, to_id) DO NOTHING`,
			[randomUUID(), projectId, relationship.fromId, relationship.relationshipType, relationship.toId, now]
		);
		await client.query(
			`INSERT INTO neo4j_outbox (id, event_type, payload, created_at)
			 VALUES ($1, 'relationship_upsert', $2, $3)`,
			[randomUUID(), JSON.stringify({ projectId, fromId: relationship.fromId, toId: relationship.toId, relationshipType: relationship.relationshipType }), now]
		);
		count++;
	}
	return count;
}