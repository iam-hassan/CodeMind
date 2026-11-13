/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Graph duplicate-replay idempotency and impact traversal (P1-T03, spec §4/§6.8/§9.3/§24).
 *
 * These run against an in-memory Cypher engine that implements the exact MERGE / traversal
 * semantics the repository relies on, so the assertions are about the *graph state* (one node,
 * one edge, no dangling SUPERSEDES) rather than about query text — `graphRepo.test.ts` already
 * pins the query shape.
 *
 * The engine also proves the outbox replay contract: a projection pass can be re-run at any
 * time (§9.3 eventual consistency) and the graph converges to the PostgreSQL truth.
 */

import assert from 'assert';
import {
	GraphRepository,
	PpbGraphError,
	type Neo4jRecord,
	type Neo4jRunResult,
	type Neo4jSession,
	type Neo4jDriverLike
} from '../../ppb/graph/graphRepo.js';
import { projectOutbox, type GraphProjectionTarget } from '../../ppb/graph/projector.js';
import type { GraphNodeType, GraphRelationshipType } from '../../ppb/ontology.js';

interface StoredNode { id: string; projectId: string; label: string; properties: Record<string, unknown>; }
interface StoredEdge { type: string; fromId: string; toId: string; projectId: string; }

const IMPACT_TYPES: readonly string[] = ['DEPENDS_ON', 'AFFECTS', 'USES', 'HOSTED_ON'];

function nodeRecord(node: StoredNode): Neo4jRecord {
	return {
		get: (key: string) => key === node.label || key === 'n' || key === 'm'
			? { properties: node.properties, labels: [node.label] }
			: undefined
	};
}

/**
 * A tiny in-memory Neo4j: it understands the subset of Cypher this repository emits and applies
 * real MERGE semantics (an existing node/edge is updated, never duplicated).
 */
class InMemoryGraphSession implements Neo4jSession {

	readonly nodes = new Map<string, StoredNode>();
	readonly edges = new Map<string, StoredEdge>();
	readonly calls: string[] = [];

	private static _nodeKey(label: string, id: string, projectId: string): string {
		return `${label}|${projectId}|${id}`;
	}

	private static _edgeKey(type: string, fromId: string, toId: string, projectId: string): string {
		return `${type}|${projectId}|${fromId}->${toId}`;
	}

	/** Test helper: seed a node that the repository queries will find. */
	seedNode(type: GraphNodeType, id: string, projectId: string, properties: Record<string, unknown> = {}): void {
		this.nodes.set(InMemoryGraphSession._nodeKey(type, id, projectId), {
			id, projectId, label: type, properties: { id, projectId, ...properties }
		});
	}

	/** Test helper: seed an edge (endpoints must already exist). */
	seedEdge(type: GraphRelationshipType, projectId: string, fromId: string, toId: string): void {
		this.edges.set(InMemoryGraphSession._edgeKey(type, fromId, toId, projectId), { type, fromId, toId, projectId });
	}

	/** Every node id of the given label in a project (deduplicated naturally by the store). */
	nodeIds(type: GraphNodeType, projectId: string): string[] {
		return [...this.nodes.values()]
			.filter(node => node.label === type && node.projectId === projectId)
			.map(node => node.id)
			.sort();
	}

	edgeKeys(): string[] {
		return [...this.edges.keys()].sort();
	}

	async run(query: string, params: Record<string, unknown> = {}): Promise<Neo4jRunResult> {
		this.calls.push(query);

		// MERGE a typed node (createNode excluded — that is a strict CREATE and fails on duplicates).
		const merge = /MERGE \(n:`([^`]+)` \{id: \$id, projectId: \$projectId\}\)/.exec(query);
		if (merge) {
			const label = merge[1];
			const id = String(params.id);
			const projectId = String(params.projectId);
			const props = (params.props ?? {}) as Record<string, unknown>;
			const key = InMemoryGraphSession._nodeKey(label, id, projectId);
			const existing = this.nodes.get(key);
			const properties = { ...(existing?.properties ?? {}), id, projectId, ...props };
			const node: StoredNode = { id, projectId, label, properties };
			this.nodes.set(key, node);
			return { records: [nodeRecord(node)] };
		}

		// MERGE the project hub.
		if (query.includes('MERGE (p:Project {projectId: $projectId})')) {
			const projectId = String(params.projectId);
			const key = InMemoryGraphSession._nodeKey('Project', projectId, projectId);
			const node: StoredNode = { id: projectId, projectId, label: 'Project', properties: { id: projectId, projectId } };
			this.nodes.set(key, node);
			return { records: [nodeRecord(node)] };
		}

		// MERGE a relationship — endpoints must exist in the same project (else no records).
		const edge = /MERGE \(a\)-\[r:`([^`]+)`\]->\(b\)/.exec(query);
		if (edge) {
			const type = edge[1];
			const fromId = String(params.fromId);
			const toId = String(params.toId);
			const projectId = String(params.projectId);
			const fromExists = [...this.nodes.values()].some(node => node.id === fromId && node.projectId === projectId);
			const toExists = [...this.nodes.values()].some(node => node.id === toId && node.projectId === projectId);
			if (!fromExists || !toExists) {
				return { records: [] }; // → the repository reports endpoints-missing
			}
			const key = InMemoryGraphSession._edgeKey(type, fromId, toId, projectId);
			this.edges.set(key, { type, fromId, toId, projectId });
			return { records: [{ get: (key2: string) => key2 === 'fromId' ? fromId : key2 === 'toId' ? toId : undefined }] };
		}

		// Status update (versioning) — the only in-place property write.
		if (query.includes('SET n.status = $status')) {
			const id = String(params.id);
			const projectId = String(params.projectId);
			let updated = 0;
			for (const [key, node] of this.nodes) {
				if (node.id === id && node.projectId === projectId) {
					this.nodes.set(key, { ...node, properties: { ...node.properties, status: params.status } });
					updated++;
				break;
				}
			}
			return { records: [{ get: (key2: string) => key2 === 'updated' ? updated : undefined }] };
		}

		// impactAnalysis — bounded, project-scoped BFS over the §6.8 relationship set.
		const impact = /\*1\.\.(\d+)\]/.exec(query);
		if (impact) {
			const hops = Number(impact[1]);
			const startId = String(params.id);
			const projectId = String(params.projectId);
			const visited = new Set<string>([startId]);
			let frontier = [startId];
			const reached: StoredNode[] = [];
			for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
				const next: string[] = [];
				for (const id of frontier) {
					for (const edge of this.edges.values()) {
						if (edge.projectId !== projectId || !IMPACT_TYPES.includes(edge.type)) { continue; }
						const other = edge.fromId === id ? edge.toId : edge.toId === id ? edge.fromId : undefined;
						if (!other || visited.has(other)) { continue; }
						visited.add(other);
						next.push(other);
						for (const node of this.nodes.values()) {
							if (node.id === other && node.projectId === projectId) { reached.push(node); }
						}
					}
				}
				frontier = next;
			}
			return { records: reached.map(nodeRecord) };
		}

		// history — SUPERSEDES*0..n chain plus rejected alternatives.
		if (query.includes('-[:SUPERSEDES*0..')) {
			const projectId = String(params.projectId);
			const chain = [...this.nodes.values()].filter(node => node.projectId === projectId);
			return { records: chain.map(nodeRecord) };
		}

		return { records: [] };
	}

	close(): void { /* no-op */ }
}

class InMemoryDriver implements Neo4jDriverLike {
	constructor(private readonly _session: InMemoryGraphSession) { }
	session(): Neo4jSession { return this._session; }
}

interface OutboxRow { readonly id: string; readonly event_type: string; readonly payload: Record<string, unknown>; }

/** Write client backed by the same in-memory truth as the graph. */
class FakeWriteClient {
	readonly rows: OutboxRow[];
	readonly processed = new Set<string>();
	readonly memories = new Map<string, { content: string; status: string }>();
	readonly calls: string[] = [];

	constructor(rows: OutboxRow[]) {
		this.rows = rows.map(row => ({ ...row }));
	}

	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push(text);
		if (text.includes('FROM neo4j_outbox WHERE processed_at IS NULL')) {
			return { rows: this.rows.filter(row => !this.processed.has(row.id)) as unknown as Array<Record<string, unknown>> };
		}
		if (text.includes('SELECT content, status FROM memories')) {
			const memory = this.memories.get(String(params[1]));
			return { rows: memory ? [{ content: memory.content, status: memory.status }] : [] };
		}
		if (text.includes('UPDATE neo4j_outbox SET processed_at')) {
			this.processed.add(String(params[0]));
			return { rows: [] };
		}
		if (text.includes('COUNT(*)')) {
			return { rows: [{ n: this.rows.filter(row => !this.processed.has(row.id)).length }] };
		}
		return { rows: [] };
	}
}

function repo(session: InMemoryGraphSession): GraphRepository & GraphProjectionTarget {
	return new GraphRepository(new InMemoryDriver(session)) as unknown as GraphRepository & GraphProjectionTarget;
}

/** Two facts of the same technology, the newer one superseding the older. */
function replayScenario(): FakeWriteClient {
	const client = new FakeWriteClient([
		{ id: 'ob-old', event_type: 'memory_upsert', payload: { factId: 'mem-old', projectId: 'projectA', category: 'technology_stack' } },
		{ id: 'ob-new', event_type: 'memory_upsert', payload: { factId: 'mem-new', projectId: 'projectA', category: 'technology_stack' } },
		{ id: 'ob-sup', event_type: 'memory_supersedes', payload: { memoryId: 'mem-old', supersededById: 'mem-new', projectId: 'projectA' } }
	]);
	client.memories.set('mem-old', { content: 'We use MongoDB for persistence', status: 'archived' });
	client.memories.set('mem-new', { content: 'We use PostgreSQL for persistence', status: 'active' });
	return client;
}

suite('PPB graph duplicate-replay and impact traversal (spec §4/§6.8)', () => {

	test('replaying the same projection twice yields one node and one edge per fact', async () => {
		const session = new InMemoryGraphSession();
		const client = replayScenario();

		await projectOutbox(client, repo(session));
		const afterFirst = { nodes: session.nodes.size, edges: session.edges.size };

		// Replay: the exact same outbox rows, but nothing was "unprocessed" — simulate a re-run
		// after a crash by clearing the processed markers (eventual consistency, §9.3/§24).
		client.processed.clear();
		const second = await projectOutbox(client, repo(session));

		assert.strictEqual(second.projected, 3, 'nothing failed on replay');
		assert.strictEqual(session.nodes.size, afterFirst.nodes, 'MERGE must not duplicate nodes');
		assert.strictEqual(session.edges.size, afterFirst.edges, 'MERGE must not duplicate edges');
		assert.deepStrictEqual(session.nodeIds('Technology', 'projectA'), ['mem-new', 'mem-old']);
		assert.strictEqual(session.nodeIds('Project', 'projectA').length, 1);
	});

	test('a fact replayed twice keeps a single node whose state tracks PostgreSQL (§6.7)', async () => {
		const session = new InMemoryGraphSession();
		const client = new FakeWriteClient([
			{ id: 'ob-1', event_type: 'memory_upsert', payload: { factId: 'mem-1', projectId: 'projectA', category: 'technology_stack' } },
			{ id: 'ob-2', event_type: 'memory_upsert', payload: { factId: 'mem-1', projectId: 'projectA', category: 'technology_stack' } }
		]);
		client.memories.set('mem-1', { content: 'PostgreSQL is the store', status: 'active' });

		await projectOutbox(client, repo(session));

		assert.deepStrictEqual(session.nodeIds('Technology', 'projectA'), ['mem-1'], 'one node, not two');
		const node = [...session.nodes.values()].find(entry => entry.id === 'mem-1')!;
		assert.strictEqual(node.properties.status, 'active', 'the graph mirrors the relational version state');
	});

	test('the SUPERSEDES edge is created once and never dangles (§13)', async () => {
		const session = new InMemoryGraphSession();
		const client = replayScenario();
		await projectOutbox(client, repo(session));
		client.processed.clear();
		await projectOutbox(client, repo(session));

		const supersedes = [...session.edges.values()].filter(edge => edge.type === 'SUPERSEDES');
		assert.strictEqual(supersedes.length, 1, 'replay must not duplicate the migration edge');
		assert.deepStrictEqual(
			{ from: supersedes[0].fromId, to: supersedes[0].toId },
			{ from: 'mem-new', to: 'mem-old' },
			'replacement SUPERSEDES the archived memory'
		);
		// Both endpoints exist, so nothing dangles.
		const ids = new Set([...session.nodes.values()].map(node => `${node.projectId}:${node.id}`));
		assert.ok(ids.has(`projectA:${supersedes[0].fromId}`));
		assert.ok(ids.has(`projectA:${supersedes[0].toId}`));
	});

	test('a supersede whose replacement is not projected yet stays queued instead of dangling', async () => {
		const session = new InMemoryGraphSession();
		// The edge arrives before the replacement node exists (out-of-order projection).
		const client = new FakeWriteClient([
			{ id: 'ob-sup', event_type: 'memory_supersedes', payload: { memoryId: 'mem-old', supersededById: 'mem-new', projectId: 'projectA' } },
			{ id: 'ob-new', event_type: 'memory_upsert', payload: { factId: 'mem-new', projectId: 'projectA', category: 'technology_stack' } },
			{ id: 'ob-old', event_type: 'memory_upsert', payload: { factId: 'mem-old', projectId: 'projectA', category: 'technology_stack' } }
		]);
		client.memories.set('mem-old', { content: 'We use MongoDB', status: 'archived' });
		client.memories.set('mem-new', { content: 'We use PostgreSQL', status: 'active' });

		const first = await projectOutbox(client, repo(session));
		assert.strictEqual(first.projected, 2);
		assert.strictEqual(first.failed, 1, 'the dangling edge row is retried, not dropped');
		assert.strictEqual(session.edgeKeys().filter(key => key.startsWith('SUPERSEDES')).length, 0, 'no dangling edge');

		const second = await projectOutbox(client, repo(session));
		assert.strictEqual(second.projected, 1, 'the queued edge succeeds once its endpoints exist');
		assert.strictEqual(second.remaining, 0);
		assert.strictEqual(session.edgeKeys().filter(key => key.startsWith('SUPERSEDES')).length, 1);
	});

	test('createRelationship still rejects endpoints that are not in the requesting project', async () => {
		const session = new InMemoryGraphSession();
		session.seedNode('Technology', 'auth-b', 'projectB');
		const graph = new GraphRepository(new InMemoryDriver(session));

		await assert.rejects(
			() => graph.createRelationship('projectA', 'auth-b', 'USES', 'auth-b'),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'endpoints-missing'
		);
		assert.strictEqual(session.edgeKeys().length, 0);
	});

	test('"what breaks if auth changes" reaches direct and transitive dependants, bounded by hops (§6.8)', async () => {
		const session = new InMemoryGraphSession();
		const projectId = 'projectA';
		session.seedNode('Technology', 'auth', projectId, { name: 'Auth' });
		session.seedNode('Module', 'web', projectId, { name: 'web-client' });
		session.seedNode('Module', 'api', projectId, { name: 'api-gateway' });
		session.seedNode('Module', 'billing', projectId, { name: 'billing' });
		session.seedEdge('USES', projectId, 'web', 'auth');
		session.seedEdge('DEPENDS_ON', projectId, 'api', 'web');
		session.seedEdge('DEPENDS_ON', projectId, 'billing', 'api');
		session.seedEdge('DECIDED_ON', projectId, 'decision-auth', 'auth'); // not an impact relationship

		const graph = new GraphRepository(new InMemoryDriver(session));

		const direct = await graph.impactAnalysis(projectId, 'auth', { maxHops: 1 });
		assert.deepStrictEqual(direct.map(node => node.id).sort(), ['web'], 'one hop reaches the direct dependant only');

		const transitive = await graph.impactAnalysis(projectId, 'auth', { maxHops: 2 });
		assert.deepStrictEqual(transitive.map(node => node.id).sort(), ['api', 'web']);

		const full = await graph.impactAnalysis(projectId, 'auth', { maxHops: 4 });
		assert.deepStrictEqual(full.map(node => node.id).sort(), ['api', 'billing', 'web'], 'the whole chain is reachable');

		for (const node of full) {
			assert.strictEqual(node.projectId, projectId);
		}
		assert.ok(!full.some(node => node.id === 'decision-auth'), 'DECIDED_ON is not an impact edge');
	});

	test('impact traversal never crosses into another project', async () => {
		const session = new InMemoryGraphSession();
		session.seedNode('Technology', 'auth', 'projectA');
		session.seedNode('Module', 'web', 'projectA');
		session.seedNode('Technology', 'auth-b', 'projectB');
		session.seedNode('Module', 'web-b', 'projectB');
		session.seedEdge('DEPENDS_ON', 'projectA', 'web', 'auth');
		session.seedEdge('DEPENDS_ON', 'projectB', 'web-b', 'auth-b');

		const graph = new GraphRepository(new InMemoryDriver(session));
		const nodes = await graph.impactAnalysis('projectA', 'auth', { maxHops: 4 });

		assert.deepStrictEqual(nodes.map(node => node.id).sort(), ['web']);
		assert.ok(nodes.every(node => node.projectId === 'projectA'));
	});
});
