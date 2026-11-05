/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 1 Part 1 — PPB knowledge graph ontology (P1-T01, spec §6/§7).
 *
 * The node types, relationship types and memory categories below are preserved exactly as
 * specified (§6.3/§6.4/§7.4). Do not add types without recording an open decision (§32).
 * Anything beyond the specified minimums is an implementation decision (spec §6.3/§6.5).
 */

/** §7.4 — the six knowledge categories (preserve exactly). */
export const MEMORY_CATEGORIES = [
	'technology_stack',
	'architecture_patterns',
	'business_rules',
	'engineering_standards',
	'constraints',
	'developer_preferences'
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** §6.3 — graph node types (preserve exactly). */
export const GRAPH_NODE_TYPES = [
	'Project',
	'Module',
	'Technology',
	'Decision',
	'Constraint',
	'Standard',
	'Preference',
	'Event'
] as const;

export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

/** §6.4 — relationship types (preserve exactly). */
export const GRAPH_RELATIONSHIP_TYPES = [
	'USES',
	'HOSTED_ON',
	'DEPENDS_ON',
	'PART_OF',
	'DECIDED_ON',
	'SUPERSEDES',
	'REJECTED',
	'AFFECTS'
] as const;

export type GraphRelationshipType = (typeof GRAPH_RELATIONSHIP_TYPES)[number];

/**
 * §6.3 — minimum implied properties per node type (baseline; anything beyond is an
 * implementation decision, recorded as OD-3 in docs/ppb/traceability.md).
 */
export const NODE_MINIMUM_PROPERTIES: Readonly<Record<GraphNodeType, readonly string[]>> = {
	Project: ['projectId'],
	Module: ['name'],
	Technology: ['name', 'category'],
	Decision: ['decision', 'reason', 'alternatives', 'status', 'author', 'date'],
	Constraint: ['description', 'category'],
	Standard: ['description', 'category'],
	Preference: ['description', 'scope'],
	Event: ['description', 'occurredAt', 'type']
};

/** §7.5 — shared metadata fields carried by every stored memory (graph and/or relational). */
export const SHARED_MEMORY_METADATA = [
	'id',
	'extractedAt',
	'confidence',
	'sourceRef',
	'importance',
	'author'
] as const;

/** §13 — memory versioning states (preserve exactly). */
export const MEMORY_VERSION_STATES = ['active', 'archived', 'superseded'] as const;
export type MemoryVersionState = (typeof MEMORY_VERSION_STATES)[number];

/**
 * §10.2 — the Decision record's status vocabulary (preserve exactly).
 * Distinct axis from the §13 memory lifecycle: a Decision is Accepted/Rejected/Superseded,
 * while its underlying memory's lifecycle transition is recorded in `memory_versions` (§13.7).
 */
export const DECISION_STATUSES = ['accepted', 'rejected', 'superseded'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** §6.3 (Event) / §11 — event types (preserve exactly). */
export const EVENT_TYPES = ['added', 'rejected', 'migrated', 'changed'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** §12 — confirmation outcomes (preserve exactly). */
export const CONFLICT_RESOLUTIONS = ['accept_migration', 'keep_existing', 'discard_incoming'] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

/**
 * §6.5/§6.6 — baseline Neo4j constraint and index statements (implementation decision, P1-T02):
 * unique identity per node type plus project-scoping indexes. Executed by
 * `storage/neo4j.ts#applyGraphConstraints` (exercised from M3).
 */
export function graphConstraintStatements(): readonly string[] {
	const statements: string[] = [];
	for (const type of GRAPH_NODE_TYPES) {
		statements.push(`CREATE CONSTRAINT ${type.toLowerCase()}_id_unique IF NOT EXISTS FOR (n:${type}) REQUIRE n.id IS UNIQUE`);
	}
	statements.push('CREATE CONSTRAINT project_projectId_unique IF NOT EXISTS FOR (n:Project) REQUIRE n.projectId IS UNIQUE');
	for (const type of GRAPH_NODE_TYPES) {
		if (type === 'Project') {
			continue;
		}
		statements.push(`CREATE INDEX ${type.toLowerCase()}_project_idx IF NOT EXISTS FOR (n:${type}) ON (n.projectId)`);
	}
	return statements;
}
