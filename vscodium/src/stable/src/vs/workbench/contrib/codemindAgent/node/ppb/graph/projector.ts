/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Graph projection from the write-path outbox (spec §9.3/§24 as resolved 2026-09-28).
 *
 * PostgreSQL is the source of truth; the graph is projected asynchronously and idempotently from
 * `neo4j_outbox`. There is deliberately no cross-store transaction: a projection that fails is
 * left unprocessed and retried on the next run (eventual consistency). Re-projecting merges the
 * same node / re-creates the same edge (both operations are idempotent in `GraphRepository`).
 *
 * Handled event types:
 *  - `memory_upsert`        → a fact projected as its category's node type
 *  - `decision_upsert`      → a `Decision` node with reason/alternatives/status (§10)
 *  - `event_upsert`         → a dated `Event` node (§11)
 *  - `decision_supersedes`  → `SUPERSEDES` edge (§10.4/§13)
 *  - `decision_rejected`    → `REJECTED` edge to a rejected Technology node (§10.3)
 *
 * The memory-category → node-type mapping is an implementation decision (the source does not
 * enumerate it); it is recorded in docs/ppb/schema.md and may be refined at T07/T12.
 */

import { GRAPH_RELATIONSHIP_TYPES, type GraphNodeType, type GraphRelationshipType, type MemoryCategory } from '../ontology.js';
import type { WriteQueryable } from '../storage/write.js';

/** Memory category → the graph node type that represents it. */
export const CATEGORY_TO_GRAPH_NODE: Readonly<Record<MemoryCategory, GraphNodeType>> = {
	technology_stack: 'Technology',
	architecture_patterns: 'Standard',
	business_rules: 'Constraint',
	engineering_standards: 'Standard',
	constraints: 'Constraint',
	developer_preferences: 'Preference'
};

/** The graph operations the projector needs (satisfied by `GraphRepository`). */
export interface GraphProjectionTarget {
	mergeNode(type: GraphNodeType, input: { readonly id: string; readonly projectId: string; readonly [property: string]: unknown }): Promise<unknown>;
	createRelationship(projectId: string, fromId: string, type: GraphRelationshipType, toId: string, properties?: Readonly<Record<string, unknown>>): Promise<void>;
	/** Ensures the project's own `Project` node exists (its id is the projectId). */
	ensureProject(projectId: string): Promise<unknown>;
}

/**
 * The relationship that connects a projected memory node to its `Project` hub. Technology is
 * something the project *uses*; every other knowledge node is *part of* the project. This is an
 * implementation decision (spec §6.10 leaves directionality open) — it makes the graph connected
 * so impact analysis and expansion can traverse, without inventing entity relationships the
 * extraction engine does not yet produce (see docs/ppb/DEMO_PROJECTS_REPORT.md, Tier 2).
 */
function linkToProject(repo: GraphProjectionTarget, projectId: string, nodeId: string, nodeType: GraphNodeType): Promise<void> {
	if (nodeType === 'Technology') {
		return repo.createRelationship(projectId, projectId, 'USES', nodeId);
	}
	return repo.createRelationship(projectId, nodeId, 'PART_OF', projectId);
}

export interface ProjectionResult {
	readonly projected: number;
	readonly failed: number;
	readonly remaining: number;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`malformed outbox payload: ${field} missing`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function applyEvent(client: WriteQueryable, repo: GraphProjectionTarget, eventType: string, payload: Record<string, unknown>): Promise<void> {
	const projectId = requireString(payload.projectId, 'projectId');

	switch (eventType) {
		case 'memory_upsert': {
			const factId = requireString(payload.factId, 'factId');
			const category = requireString(payload.category, 'category') as MemoryCategory;
			const nodeType = CATEGORY_TO_GRAPH_NODE[category];
			if (!nodeType) {
				throw new Error(`unknown memory category: ${category}`);
			}
			const memory = await client.query(`SELECT content, status FROM memories WHERE project_id = $1 AND id = $2`, [projectId, factId]);
			const content = memory.rows.length > 0 ? String(memory.rows[0].content) : factId;
			const input: { id: string; projectId: string; [property: string]: unknown } = {
				id: factId, projectId, category, name: content, description: content
			};
			if (memory.rows.length > 0 && memory.rows[0].status !== undefined) {
				// §6.7 — the graph node state must reflect the PostgreSQL version state.
				input.status = String(memory.rows[0].status);
			}
			if (category === 'developer_preferences') {
				input.scope = 'project';
			}
			await repo.ensureProject(projectId);
			await repo.mergeNode(nodeType, input);
			await linkToProject(repo, projectId, factId, nodeType);
			return;
		}

		case 'decision_upsert': {
			const decisionId = requireString(payload.decisionId, 'decisionId');
			const row = (await client.query(
				`SELECT decision, reason, alternatives, status, author, decided_at FROM decisions WHERE project_id = $1 AND id = $2`,
				[projectId, decisionId]
			)).rows[0];
			if (!row) {
				throw new Error(`decision ${decisionId} not found for projection`);
			}
			const input: { id: string; projectId: string; [property: string]: unknown } = {
				id: decisionId, projectId, decision: String(row.decision), status: String(row.status)
			};
			const reason = optionalString(row.reason);
			const alternatives = optionalString(row.alternatives);
			const author = optionalString(row.author);
			const date = optionalString(row.decided_at);
			if (reason !== undefined) { input.reason = reason; }
			if (alternatives !== undefined) { input.alternatives = alternatives; }
			if (author !== undefined) { input.author = author; }
			if (date !== undefined) { input.date = new Date(date).toISOString(); }
			await repo.ensureProject(projectId);
			await repo.mergeNode('Decision', input);
			await linkToProject(repo, projectId, decisionId, 'Decision');
			return;
		}

		case 'event_upsert': {
			const eventId = requireString(payload.eventId, 'eventId');
			const row = (await client.query(
				`SELECT description, occurred_at, event_type FROM events WHERE project_id = $1 AND id = $2`,
				[projectId, eventId]
			)).rows[0];
			if (!row) {
				throw new Error(`event ${eventId} not found for projection`);
			}
			await repo.ensureProject(projectId);
			await repo.mergeNode('Event', {
				id: eventId,
				projectId,
				description: String(row.description),
				occurredAt: new Date(String(row.occurred_at)).toISOString(),
				type: String(row.event_type)
			});
			await linkToProject(repo, projectId, eventId, 'Event');
			return;
		}

		case 'decision_supersedes': {
			const decisionId = requireString(payload.decisionId, 'decisionId');
			const supersededId = requireString(payload.supersededId, 'supersededId');
			await repo.createRelationship(projectId, decisionId, 'SUPERSEDES', supersededId);
			return;
		}

		case 'memory_supersedes': {
			// Versioning (T11) archived an old memory into its replacement; mirror it as an edge so
			// historical graph traversal can follow the migration (spec §6.8/§13/§17).
			const memoryId = requireString(payload.memoryId, 'memoryId');
			const supersededById = requireString(payload.supersededById, 'supersededById');
			await repo.createRelationship(projectId, supersededById, 'SUPERSEDES', memoryId);
			return;
		}

		case 'relationship_upsert': {
			// Tier 2 — a relationship the extraction engine inferred between two extracted facts.
			const fromId = requireString(payload.fromId, 'fromId');
			const toId = requireString(payload.toId, 'toId');
			const relationshipType = requireString(payload.relationshipType, 'relationshipType');
			if (!(GRAPH_RELATIONSHIP_TYPES as readonly string[]).includes(relationshipType)) {
				throw new Error(`unknown relationship type: ${relationshipType}`);
			}
			try {
				await repo.createRelationship(projectId, fromId, relationshipType as GraphRelationshipType, toId);
			} catch (error) {
				// A dangling endpoint must not poison the queue: drop the edge and let the row be
				// marked processed (the fact it referenced was never projected).
				if ((error as { code?: string } | undefined)?.code !== 'endpoints-missing') {
					throw error;
				}
			}
			return;
		}

		case 'decision_decided_on': {
			// A decision names the technology it chose (§6.10) → `(Decision)-[:DECIDED_ON]->(Technology)`.
			const decisionId = requireString(payload.decisionId, 'decisionId');
			const technologyId = requireString(payload.technologyId, 'technologyId');
			const technologyName = requireString(payload.technologyName, 'technologyName');
			await repo.mergeNode('Technology', { id: technologyId, projectId, name: technologyName, category: 'technology_stack' });
			await repo.createRelationship(projectId, decisionId, 'DECIDED_ON', technologyId);
			return;
		}

		case 'decision_rejected': {
			const decisionId = requireString(payload.decisionId, 'decisionId');
			const technologyId = requireString(payload.technologyId, 'technologyId');
			const technologyName = requireString(payload.technologyName, 'technologyName');
			await repo.mergeNode('Technology', { id: technologyId, projectId, name: technologyName, category: 'technology_stack' });
			await repo.createRelationship(projectId, decisionId, 'REJECTED', technologyId);
			return;
		}

		default:
			throw new Error(`unknown outbox event type: ${eventType}`);
	}
}

/** Apply pending outbox rows to the graph; failures stay queued for the next run (§24). */
export async function projectOutbox(
	client: WriteQueryable,
	repo: GraphProjectionTarget,
	options: { readonly limit?: number; readonly now?: () => Date } = {}
): Promise<ProjectionResult> {
	const limit = options.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error('limit must be a positive integer');
	}
	const now = (options.now ?? (() => new Date()))().toISOString();

	const pending = await client.query(
		`SELECT id, event_type, payload FROM neo4j_outbox WHERE processed_at IS NULL ORDER BY created_at LIMIT ${limit}`
	);
	let projected = 0;
	let failed = 0;

	for (const row of pending.rows) {
		const outboxId = String(row.id);
		const eventType = String(row.event_type);
		const payload = (row.payload ?? {}) as Record<string, unknown>;
		try {
			await applyEvent(client, repo, eventType, payload);
			await client.query(`UPDATE neo4j_outbox SET processed_at = $2 WHERE id = $1`, [outboxId, now]);
			projected++;
		} catch {
			// Left unprocessed on purpose so the next pass retries it (idempotent projection).
			failed++;
		}
	}

	const remainingResult = await client.query(`SELECT COUNT(*) AS n FROM neo4j_outbox WHERE processed_at IS NULL`);
	const remaining = Number(remainingResult.rows[0]?.n ?? 0);
	return { projected, failed, remaining };
}