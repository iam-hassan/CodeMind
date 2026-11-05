/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Decision and dated-event memory (P1-T12, spec §10/§11).
 *
 * A decision records the choice, the reason, the alternatives considered and the status
 * (`accepted`/`rejected`/`superseded`, §10.2). Rejected alternatives stay retrievable (§10.3) and
 * a superseding decision links to the one it replaces (§10.4). Migration-style changes are dated
 * `Event` rows (§10.5/§11).
 *
 * PostgreSQL is the source of truth (§24); every write also queues a graph-projection event so the
 * `Decision`/`Event` nodes and `SUPERSEDES`/`REJECTED` edges appear in Neo4j asynchronously.
 *
 * Forward compatibility (§10.7): `author` and `source_ref` are single columns but nothing here
 * assumes a decision has exactly one source — later phases may attach roadmaps/Decision-Matrix
 * rows without a breaking change.
 */

import { randomUUID } from 'crypto';
import type { DecisionStatus, EventType } from '../ontology.js';
import type { WriteQueryable } from '../storage/write.js';

export class DecisionMemoryError extends Error {
	constructor(message: string, readonly code: 'invalid-project' | 'invalid-input' | 'not-found') {
		super(message);
		this.name = 'DecisionMemoryError';
	}
}

export interface DecisionInput {
	readonly projectId: string;
	readonly decision: string;
	readonly reason?: string;
	readonly alternatives?: string;
	readonly author?: string;
	readonly sourceRef?: string;
	/** ISO timestamp; defaults to now. */
	readonly decidedAt?: string;
	/** Rejected alternative names — queued as `REJECTED` graph edges (§10.3). */
	readonly rejectedAlternatives?: readonly string[];
	/** The technology the decision chose — queued as a `DECIDED_ON` graph edge (§6.10, Tier 2). */
	readonly decidedOn?: string;
}

export interface DecisionRecord {
	readonly id: string;
	readonly projectId: string;
	readonly decision: string;
	readonly reason: string | undefined;
	readonly alternatives: string | undefined;
	readonly status: DecisionStatus;
	readonly author: string | undefined;
	readonly sourceRef: string | undefined;
	readonly decidedAt: string | undefined;
	readonly supersededBy: string | undefined;
}

export interface EventInput {
	readonly projectId: string;
	readonly eventType: EventType;
	readonly description: string;
	/** ISO timestamp; defaults to now. */
	readonly occurredAt?: string;
	readonly sourceRef?: string;
}

export interface EventRecord {
	readonly id: string;
	readonly projectId: string;
	readonly eventType: EventType;
	readonly description: string;
	readonly occurredAt: string;
	readonly sourceRef: string | undefined;
}

interface Options {
	readonly now?: () => Date;
	readonly newId?: () => string;
}

function context(options: Options): { now: string; newId: () => string } {
	return { now: (options.now ?? (() => new Date()))().toISOString(), newId: options.newId ?? (() => randomUUID()) };
}

function requireText(value: string | undefined, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new DecisionMemoryError(`${field} is required`, 'invalid-input');
	}
	return value.trim();
}

function requireProject(projectId: string | undefined): string {
	if (typeof projectId !== 'string' || projectId.trim().length === 0) {
		throw new DecisionMemoryError('a non-empty projectId is required (spec §6.6/§6.12)', 'invalid-project');
	}
	return projectId;
}

function queueOutbox(client: WriteQueryable, eventType: string, payload: Record<string, unknown>, now: string): Promise<unknown> {
	return client.query(
		`INSERT INTO neo4j_outbox (id, event_type, payload, created_at) VALUES ($1, $2, $3, $4)`,
		[randomUUID(), eventType, JSON.stringify(payload), now]
	);
}

function toDecision(row: Record<string, unknown>): DecisionRecord {
	return {
		id: String(row.id),
		projectId: String(row.project_id),
		decision: String(row.decision),
		reason: row.reason == null ? undefined : String(row.reason),
		alternatives: row.alternatives == null ? undefined : String(row.alternatives),
		status: String(row.status) as DecisionStatus,
		author: row.author == null ? undefined : String(row.author),
		sourceRef: row.source_ref == null ? undefined : String(row.source_ref),
		decidedAt: row.decided_at == null ? undefined : new Date(String(row.decided_at)).toISOString(),
		supersededBy: row.superseded_by == null ? undefined : String(row.superseded_by)
	};
}

const DECISION_COLUMNS = 'id, project_id, decision, reason, alternatives, status, author, source_ref, decided_at, superseded_by';

/** Deterministic graph id for a rejected alternative Technology node (§10.3). */
export function rejectedTechnologyId(projectId: string, name: string): string {
	const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return `ppb:tech:${projectId}:${slug}`;
}

/** Create a decision (§10.2) and queue its graph projection. */
export async function createDecision(client: WriteQueryable, input: DecisionInput, options: Options = {}): Promise<DecisionRecord> {
	const projectId = requireProject(input.projectId);
	const decision = requireText(input.decision, 'decision');
	const { now, newId } = context(options);
	const id = newId();
	const decidedAt = input.decidedAt ?? now;

	await client.query(
		`INSERT INTO decisions (id, project_id, decision, reason, alternatives, status, author, source_ref, decided_at, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, 'accepted', $6, $7, $8, $9, $9)`,
		[id, projectId, decision, input.reason ?? null, input.alternatives ?? null, input.author ?? null, input.sourceRef ?? null, decidedAt, now]
	);
	await queueOutbox(client, 'decision_upsert', { decisionId: id, projectId, status: 'accepted' }, now);
	for (const alternative of input.rejectedAlternatives ?? []) {
		await queueOutbox(client, 'decision_rejected', { decisionId: id, projectId, technologyName: alternative, technologyId: rejectedTechnologyId(projectId, alternative) }, now);
	}
	if (typeof input.decidedOn === 'string' && input.decidedOn.trim().length > 0) {
		await queueOutbox(client, 'decision_decided_on', { decisionId: id, projectId, technologyName: input.decidedOn.trim(), technologyId: rejectedTechnologyId(projectId, input.decidedOn) }, now);
	}

	const created = await getDecision(client, projectId, id);
	if (!created) {
		throw new DecisionMemoryError('decision was not persisted', 'not-found');
	}
	return created;
}

export async function getDecision(client: WriteQueryable, projectId: string, id: string): Promise<DecisionRecord | undefined> {
	const project = requireProject(projectId);
	const result = await client.query(
		`SELECT ${DECISION_COLUMNS} FROM decisions WHERE project_id = $1 AND id = $2 LIMIT 1`,
		[project, id]
	);
	return result.rows.length > 0 ? toDecision(result.rows[0]) : undefined;
}

export async function listDecisions(client: WriteQueryable, projectId: string, status?: DecisionStatus): Promise<DecisionRecord[]> {
	const project = requireProject(projectId);
	const conditions = ['project_id = $1'];
	const params: unknown[] = [project];
	if (status !== undefined) {
		params.push(status);
		conditions.push(`status = $${params.length}`);
	}
	const result = await client.query(
		`SELECT ${DECISION_COLUMNS} FROM decisions WHERE ${conditions.join(' AND ')} ORDER BY decided_at DESC NULLS LAST, created_at DESC`,
		params
	);
	return result.rows.map(toDecision);
}

/**
 * Replace a decision with a newer one (§10.4/§13): the previous decision becomes `superseded` and
 * is linked to its replacement, which becomes the active decision. Nothing is deleted.
 */
export async function supersedeDecision(
	client: WriteQueryable,
	projectId: string,
	previousId: string,
	input: Omit<DecisionInput, 'projectId'>,
	options: Options = {}
): Promise<{ previous: DecisionRecord; next: DecisionRecord }> {
	const project = requireProject(projectId);
	const previous = await getDecision(client, project, previousId);
	if (!previous) {
		throw new DecisionMemoryError(`decision ${previousId} not found in project ${project}`, 'not-found');
	}
	const next = await createDecision(client, { ...input, projectId: project }, options);
	await client.query(
		`UPDATE decisions SET status = 'superseded', superseded_by = $3, updated_at = $4 WHERE project_id = $1 AND id = $2`,
		[project, previousId, next.id, context(options).now]
	);
	await queueOutbox(client, 'decision_upsert', { decisionId: previousId, projectId: project, status: 'superseded' }, context(options).now);
	await queueOutbox(client, 'decision_supersedes', { decisionId: next.id, supersededId: previousId, projectId: project }, context(options).now);

	const updatedPrevious = await getDecision(client, project, previousId);
	return { previous: updatedPrevious ?? previous, next };
}

/** Record a dated event (§10.5/§11) and queue its graph projection. */
export async function recordEvent(client: WriteQueryable, input: EventInput, options: Options = {}): Promise<EventRecord> {
	const projectId = requireProject(input.projectId);
	const description = requireText(input.description, 'description');
	const { now, newId } = context(options);
	const id = newId();
	const occurredAt = input.occurredAt ?? now;
	await client.query(
		`INSERT INTO events (id, project_id, event_type, description, occurred_at, source_ref, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[id, projectId, input.eventType, description, occurredAt, input.sourceRef ?? null, now]
	);
	await queueOutbox(client, 'event_upsert', { eventId: id, projectId, eventType: input.eventType }, now);
	return { id, projectId, eventType: input.eventType, description, occurredAt, sourceRef: input.sourceRef };
}

/** Project-scoped chronological listing (§11.3). */
export async function listEvents(client: WriteQueryable, projectId: string, limit = 100): Promise<EventRecord[]> {
	const project = requireProject(projectId);
	if (!Number.isInteger(limit) || limit < 1) {
		throw new DecisionMemoryError('limit must be a positive integer', 'invalid-input');
	}
	const result = await client.query(
		`SELECT id, project_id, event_type, description, occurred_at, source_ref FROM events
		 WHERE project_id = $1 ORDER BY occurred_at ASC LIMIT ${limit}`,
		[project]
	);
	return result.rows.map(row => ({
		id: String(row.id),
		projectId: String(row.project_id),
		eventType: String(row.event_type) as EventType,
		description: String(row.description),
		occurredAt: new Date(String(row.occurred_at)).toISOString(),
		sourceRef: row.source_ref == null ? undefined : String(row.source_ref)
	}));
}