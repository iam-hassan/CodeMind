/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Graph repository (P1-T03, spec §6, IF-11).
 *
 * The single gateway to Neo4j for every Part 1 component (spec §6.7): all Cypher lives here and
 * callers work with typed nodes and relationships. Every query is explicitly project-scoped
 * (spec §6.6) — except global developer preferences, which the spec names as the one deliberate
 * exception.
 *
 * Deliberately SPECIFIC, not a generic ORM: every method below exists because a section of the
 * specification requires it (§6.6, §6.8, §6.9, §6.12). No node type, relationship type or
 * operation is invented beyond `../ontology.js`.
 *
 * Spec map:
 *  - createNode / mergeNode / ensureProject ............ §6.9 write
 *  - getNode / findNodes / getRelationships ............ §6.9 read + §8.2 candidates
 *  - updateNodeStatus .................................. §6.9 update + §13 versioning
 *  - createRelationship ............................... §6.9 write
 *  - impactAnalysis .................................... §6.8 impact analysis
 *  - expandFromSeeds ................................... §6.8 graph expansion
 *  - history ........................................... §6.8 historical traversal (§13)
 *  - retrievePreferences ............................... §6.6 shared-preferences exception
 *
 * No delete method exists: historical information is never silently deleted (§11.5/§13.9).
 */

import type { Driver } from 'neo4j-driver';
import {
	GRAPH_NODE_TYPES,
	GRAPH_RELATIONSHIP_TYPES,
	type GraphNodeType,
	type GraphRelationshipType,
	type MemoryVersionState
} from '../ontology.js';

export type PpbGraphErrorCode =
	| 'invalid-project'
	| 'invalid-node-type'
	| 'invalid-relationship-type'
	| 'invalid-option'
	| 'duplicate-node'
	| 'endpoints-missing'
	| 'driver-failure';

export class PpbGraphError extends Error {
	constructor(message: string, readonly code: PpbGraphErrorCode) {
		super(message);
		this.name = 'PpbGraphError';
	}
}

export interface GraphNode {
	readonly id: string;
	readonly projectId: string;
	readonly type: GraphNodeType;
	readonly properties: Readonly<Record<string, unknown>>;
}

export interface GraphRelationship {
	readonly type: GraphRelationshipType;
	readonly fromId: string;
	readonly toId: string;
	readonly properties: Readonly<Record<string, unknown>>;
}

/** A node write payload: `id` + `projectId` are required; all other fields become properties. */
export interface NodeInput {
	readonly id: string;
	readonly projectId: string;
	readonly [property: string]: unknown;
}

export interface GetRelationshipOptions {
	readonly type?: GraphRelationshipType;
	readonly direction?: 'out' | 'in' | 'both';
}

export interface ImpactOptions {
	readonly maxHops?: number;
}

export interface ExpansionOptions {
	readonly maxHops?: number;
	readonly relationshipTypes?: readonly GraphRelationshipType[];
}

/** §6.8 — the relationship types impact analysis traverses. */
const IMPACT_RELATIONSHIPS: readonly GraphRelationshipType[] = ['DEPENDS_ON', 'AFFECTS', 'USES', 'HOSTED_ON'];

/** Bounds — PLACEHOLDER safety limits pending real measurement (spec §26/§32). */
const MAX_HOPS_LIMIT = 4;
const DEFAULT_IMPACT_HOPS = 2;
const DEFAULT_EXPANSION_HOPS = 1;
const HISTORY_DEPTH = 10;
const DEFAULT_FIND_LIMIT = 50;

// --- minimal driver shapes (mirror neo4j-driver; keep the repository testable without a server) ---

export interface Neo4jRecord {
	get(key: string): unknown;
}

export interface Neo4jRunResult {
	readonly records: readonly Neo4jRecord[];
}

export interface Neo4jSession {
	run(query: string, params?: Record<string, unknown>): Promise<Neo4jRunResult>;
	close(): unknown;
}

export interface Neo4jDriverLike {
	session(): Neo4jSession;
}

type NodeValue = { properties?: Record<string, unknown>; labels?: readonly string[] };

export class GraphRepository {

	constructor(private readonly _driver: Driver | Neo4jDriverLike) { }

	// --- writes (§6.9) ----------------------------------------------------------------------

	/** Strict create — fails if a node with this id already exists (uniqueness, §6.5). */
	async createNode(type: GraphNodeType, input: NodeInput): Promise<GraphNode> {
		const nodeType = GraphRepository._requireNodeType(type);
		const projectId = GraphRepository._requireProject(input.projectId);
		return this._run(async session => {
			try {
				const result = await session.run(
					`CREATE (n:\`${nodeType}\` {id: $id, projectId: $projectId})
					 SET n += $props, n.createdAt = $now
					 RETURN n`,
					{ id: input.id, projectId, props: GraphRepository._stripIdentity(input), now: new Date().toISOString() }
				);
				return GraphRepository._nodeOrFail(result);
			} catch (error) {
				if (GraphRepository._isConstraintViolation(error)) {
					throw new PpbGraphError(`node ${input.id} already exists in project ${projectId}`, 'duplicate-node');
				}
				throw error;
			}
		});
	}

	/** Idempotent create-or-update — for identity nodes re-encountered across segments (§6.9). */
	async mergeNode(type: GraphNodeType, input: NodeInput): Promise<GraphNode> {
		const nodeType = GraphRepository._requireNodeType(type);
		const projectId = GraphRepository._requireProject(input.projectId);
		return this._run(async session => {
			try {
				const result = await session.run(
					`MERGE (n:\`${nodeType}\` {id: $id, projectId: $projectId})
					 ON CREATE SET n.createdAt = $now
					 SET n += $props, n.updatedAt = $now
					 RETURN n`,
					{ id: input.id, projectId, props: GraphRepository._stripIdentity(input), now: new Date().toISOString() }
				);
				return GraphRepository._nodeOrFail(result);
			} catch (error) {
				// The uniqueness constraint is on `id` alone (per label, §6.5); a MERGE keyed on
				// {id, projectId} therefore attempts a CREATE when the id already exists under a
				// different project. Surface that as a typed conflict, never a generic failure.
				if (GraphRepository._isConstraintViolation(error)) {
					throw new PpbGraphError(
						`id ${input.id} already exists under a different project or label`, 'duplicate-node'
					);
				}
				throw error;
			}
		});
	}

	/** Ensures the project's own `Project` node exists (§6.6 ownership; Project id = projectId). */
	async ensureProject(projectId: string): Promise<GraphNode> {
		const project = GraphRepository._requireProject(projectId);
		return this._run(async session => {
			const result = await session.run(
				`MERGE (p:Project {projectId: $projectId})
				 ON CREATE SET p.id = $projectId, p.createdAt = $now
				 SET p.updatedAt = $now
				 RETURN p AS n`,
				{ projectId: project, now: new Date().toISOString() }
			);
			return GraphRepository._nodeOrFail(result);
		});
	}

	/** §6.6 — the deliberate global exception to project scoping (paired with `retrievePreferences`). */
	async saveGlobalPreference(input: { id: string; [property: string]: unknown }): Promise<GraphNode> {
		return this._run(async session => {
			const result = await session.run(
				`MERGE (p:Preference {id: $id})
				 SET p += $props, p.scope = 'global', p.updatedAt = $now
				 RETURN p AS n`,
				{ id: input.id, props: GraphRepository._stripIdentity({ ...input, projectId: '' }), now: new Date().toISOString() }
			);
			return GraphRepository._nodeOrFail(result);
		});
	}

	/** Creates a typed relationship between two nodes **of the same project** (§6.4/§6.6). */
	async createRelationship(
		projectId: string,
		fromId: string,
		type: GraphRelationshipType,
		toId: string,
		properties: Readonly<Record<string, unknown>> = {}
	): Promise<void> {
		const project = GraphRepository._requireProject(projectId);
		const relationshipType = GraphRepository._requireRelationshipType(type);
		return this._run(async session => {
			const result = await session.run(
				// `WITH … LIMIT 1` guards cardinality: an id shared across labels must not fan the
				// match out into a Cartesian product of edges. MERGE keeps re-ingestion idempotent.
				`MATCH (a {id: $fromId, projectId: $projectId})
				 WITH a LIMIT 1
				 MATCH (b {id: $toId, projectId: $projectId})
				 WITH a, b LIMIT 1
				 MERGE (a)-[r:\`${relationshipType}\`]->(b)
				 ON CREATE SET r.createdAt = $now
				 SET r += $props, r.updatedAt = $now
				 RETURN a.id AS fromId, b.id AS toId`,
				{ fromId, toId, projectId: project, props: properties, now: new Date().toISOString() }
			);
			if (result.records.length === 0) {
				throw new PpbGraphError(
					`cannot create ${relationshipType}: endpoint missing in project ${project} (${fromId} -> ${toId})`,
					'endpoints-missing'
				);
			}
		});
	}

	/** Versioning transition (§6.9/§13) — the only in-place update ordinary facts ever receive. */
	async updateNodeStatus(projectId: string, id: string, status: MemoryVersionState): Promise<number> {
		const project = GraphRepository._requireProject(projectId);
		return this._run(async session => {
			const result = await session.run(
				`MATCH (n {id: $id, projectId: $projectId})
				 SET n.status = $status, n.updatedAt = $now
				 RETURN count(n) AS updated`,
				{ id, projectId: project, status, now: new Date().toISOString() }
			);
			const updated = result.records[0]?.get('updated');
			return typeof updated === 'number' ? updated : Number(updated ?? 0);
		});
	}

	// --- reads (§6.9) -----------------------------------------------------------------------

	async getNode(projectId: string, type: GraphNodeType, id: string): Promise<GraphNode | undefined> {
		const nodeType = GraphRepository._requireNodeType(type);
		const project = GraphRepository._requireProject(projectId);
		return this._run(async session => {
			const result = await session.run(
				`MATCH (n:\`${nodeType}\` {id: $id, projectId: $projectId})
				 RETURN n LIMIT 1`,
				{ id, projectId: project }
			);
			return GraphRepository._toNode(result.records[0]?.get('n'));
		});
	}

	/** Bounded candidate lookup for deduplication/conflict detection (§8.2/§12.2). */
	async findNodes(projectId: string, type: GraphNodeType, limit: number = DEFAULT_FIND_LIMIT): Promise<GraphNode[]> {
		const nodeType = GraphRepository._requireNodeType(type);
		const project = GraphRepository._requireProject(projectId);
		if (!Number.isInteger(limit) || limit < 1) {
			throw new PpbGraphError('limit must be a positive integer', 'invalid-option');
		}
		return this._run(async session => {
			const result = await session.run(
				`MATCH (n:\`${nodeType}\` {projectId: $projectId})
				 RETURN n LIMIT ${limit}`,
				{ projectId: project }
			);
			return GraphRepository._toNodes(result, 'n');
		});
	}

	async getRelationships(projectId: string, id: string, options: GetRelationshipOptions = {}): Promise<GraphRelationship[]> {
		const project = GraphRepository._requireProject(projectId);
		const direction = options.direction ?? 'both';
		if (direction !== 'out' && direction !== 'in' && direction !== 'both') {
			throw new PpbGraphError(`unknown direction: ${String(direction)}`, 'invalid-option');
		}
		const relationshipType = options.type === undefined ? undefined : GraphRepository._requireRelationshipType(options.type);
		const target = '(b {projectId: $projectId})';
		const pattern = direction === 'out' ? `(a)-[r]->${target}` : direction === 'in' ? `(a)<-[r]-${target}` : `(a)-[r]-${target}`;
		return this._run(async session => {
			const result = await session.run(
				`MATCH (a {id: $id, projectId: $projectId})
				 MATCH ${pattern}
				 WHERE $relType IS NULL OR type(r) = $relType
				 RETURN type(r) AS relType, startNode(r).id AS fromId, endNode(r).id AS toId, r AS rel`,
				{ id, projectId: project, relType: relationshipType ?? null }
			);
			const relationships: GraphRelationship[] = [];
			for (const record of result.records) {
				const relType = String(record.get('relType') ?? '');
				if (!(GRAPH_RELATIONSHIP_TYPES as readonly string[]).includes(relType)) {
					continue;
				}
				const rel = record.get('rel') as { properties?: Record<string, unknown> } | undefined;
				relationships.push({
					type: relType as GraphRelationshipType,
					fromId: String(record.get('fromId') ?? ''),
					toId: String(record.get('toId') ?? ''),
					properties: rel?.properties ?? {}
				});
			}
			return relationships;
		});
	}

	/** §6.6 — project-scoped preferences plus the deliberate global exception. */
	async retrievePreferences(projectId: string): Promise<GraphNode[]> {
		const project = GraphRepository._requireProject(projectId);
		return this._run(async session => {
			const result = await session.run(
				`MATCH (p:Preference {projectId: $projectId}) RETURN p AS pref
				 UNION
				 MATCH (g:Preference {scope: 'global'}) RETURN g AS pref`,
				{ projectId: project }
			);
			return GraphRepository._toNodes(result, 'pref');
		});
	}

	// --- traversals (§6.8) ------------------------------------------------------------------

	/**
	 * §6.8 impact analysis — "what would be affected if this changes": everything reachable
	 * from the given Technology/Module via DEPENDS_ON | AFFECTS | USES | HOSTED_ON.
	 */
	async impactAnalysis(projectId: string, id: string, options: ImpactOptions = {}): Promise<GraphNode[]> {
		const project = GraphRepository._requireProject(projectId);
		const hops = GraphRepository._requireHops(options.maxHops, DEFAULT_IMPACT_HOPS);
		const relPattern = IMPACT_RELATIONSHIPS.map(type => `\`${type}\``).join('|');
		return this._run(async session => {
			const result = await session.run(
				`MATCH path = (n {id: $id, projectId: $projectId})-[:${relPattern}*1..${hops}]-(m {projectId: $projectId})
				 RETURN DISTINCT m`,
				{ id, projectId: project }
			);
			return GraphRepository._toNodes(result);
		});
	}

	/**
	 * §6.8 graph expansion — pull in graph neighbours of the given seed memories so structurally
	 * related knowledge the vector search missed still reaches fusion and ranking.
	 */
	async expandFromSeeds(projectId: string, seedIds: readonly string[], options: ExpansionOptions = {}): Promise<GraphNode[]> {
		const project = GraphRepository._requireProject(projectId);
		if (seedIds.length === 0) {
			return [];
		}
		const hops = GraphRepository._requireHops(options.maxHops, DEFAULT_EXPANSION_HOPS);
		const types = options.relationshipTypes ?? GRAPH_RELATIONSHIP_TYPES;
		for (const type of types) {
			GraphRepository._requireRelationshipType(type);
		}
		const relPattern = types.map(type => `\`${type}\``).join('|');
		return this._run(async session => {
			const result = await session.run(
				`MATCH (n {projectId: $projectId})-[:${relPattern}*1..${hops}]-(m {projectId: $projectId})
				 WHERE n.id IN $seedIds AND NOT m.id IN $seedIds
				 RETURN DISTINCT m`,
				{ projectId: project, seedIds: [...seedIds] }
			);
			return GraphRepository._toNodes(result);
		});
	}

	/**
	 * §6.8 historical traversal — the SUPERSEDES chain (either direction) and the rejected
	 * alternatives reachable from a Decision/Event node (§13/§17).
	 */
	async history(projectId: string, id: string): Promise<{ chain: GraphNode[]; rejected: GraphNode[] }> {
		const project = GraphRepository._requireProject(projectId);
		return this._run(async session => {
			const chainResult = await session.run(
				`MATCH (n {id: $id, projectId: $projectId})-[:SUPERSEDES*0..${HISTORY_DEPTH}]-(m {projectId: $projectId})
				 RETURN DISTINCT m`,
				{ id, projectId: project }
			);
			const rejectedResult = await session.run(
				`MATCH (n {id: $id, projectId: $projectId})-[:REJECTED]->(t {projectId: $projectId})
				 RETURN DISTINCT t`,
				{ id, projectId: project }
			);
			return {
				chain: GraphRepository._toNodes(chainResult),
				rejected: GraphRepository._toNodes(rejectedResult, 't')
			};
		});
	}

	// --- internals --------------------------------------------------------------------------

	private async _run<T>(fn: (session: Neo4jSession) => Promise<T>): Promise<T> {
		const session = (this._driver as Neo4jDriverLike).session();
		try {
			return await fn(session);
		} catch (error) {
			if (error instanceof PpbGraphError) {
				throw error;
			}
			throw new PpbGraphError(
				`graph operation failed: ${error instanceof Error ? error.message : String(error)}`,
				'driver-failure'
			);
		} finally {
			try { await session.close(); } catch { /* closing best-effort */ }
		}
	}

	private static _requireProject(projectId: string | undefined): string {
		if (typeof projectId !== 'string' || projectId.trim().length === 0) {
			throw new PpbGraphError('a non-empty projectId is required (spec §6.6/§6.12)', 'invalid-project');
		}
		return projectId;
	}

	private static _requireNodeType(type: string | undefined): GraphNodeType {
		if (type === undefined || !(GRAPH_NODE_TYPES as readonly string[]).includes(type)) {
			throw new PpbGraphError(`unknown node type: ${String(type)} (spec §6.3)`, 'invalid-node-type');
		}
		return type as GraphNodeType;
	}

	private static _requireRelationshipType(type: string | undefined): GraphRelationshipType {
		if (type === undefined || !(GRAPH_RELATIONSHIP_TYPES as readonly string[]).includes(type)) {
			throw new PpbGraphError(`unknown relationship type: ${String(type)} (spec §6.4)`, 'invalid-relationship-type');
		}
		return type as GraphRelationshipType;
	}

	private static _requireHops(hops: number | undefined, fallback: number): number {
		const value = hops ?? fallback;
		if (!Number.isInteger(value) || value < 1 || value > MAX_HOPS_LIMIT) {
			throw new PpbGraphError(`maxHops must be an integer in 1..${MAX_HOPS_LIMIT}`, 'invalid-option');
		}
		return value;
	}

	/** `id`/`projectId` are set explicitly, never via the free-form property bag. */
	private static _stripIdentity(input: NodeInput): Record<string, unknown> {
		const props: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(input)) {
			if (key === 'id' || key === 'projectId') {
				continue;
			}
			props[key] = value;
		}
		return props;
	}

	private static _isConstraintViolation(error: unknown): boolean {
		const code = (error as { code?: unknown } | undefined)?.code;
		return typeof code === 'string' && code.includes('ConstraintValidationFailed');
	}

	private static _nodeOrFail(result: Neo4jRunResult): GraphNode {
		const node = GraphRepository._toNode(result.records[0]?.get('n'));
		if (!node) {
			throw new PpbGraphError('write did not return a node', 'driver-failure');
		}
		return node;
	}

	private static _toNodes(result: Neo4jRunResult, key: string = 'm'): GraphNode[] {
		const nodes: GraphNode[] = [];
		for (const record of result.records) {
			const node = GraphRepository._toNode(record.get(key));
			if (node) {
				nodes.push(node);
			}
		}
		return nodes;
	}

	private static _toNode(value: unknown): GraphNode | undefined {
		const node = value as NodeValue | undefined;
		if (!node?.properties) {
			return undefined;
		}
		const labels = node.labels ?? [];
		const type = labels.find(label => (GRAPH_NODE_TYPES as readonly string[]).includes(label)) as GraphNodeType | undefined;
		if (!type) {
			return undefined;
		}
		return {
			id: String(node.properties.id ?? ''),
			projectId: String(node.properties.projectId ?? ''),
			type,
			properties: node.properties
		};
	}
}
