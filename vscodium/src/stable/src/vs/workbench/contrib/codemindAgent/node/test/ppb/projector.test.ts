/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the outbox → graph projector (spec §9.3/§10/§11/§24).
 */

import assert from 'assert';
import { CATEGORY_TO_GRAPH_NODE, projectOutbox } from '../../ppb/graph/projector.js';
import type { GraphNodeType, GraphRelationshipType } from '../../ppb/ontology.js';

interface OutboxRow {
	readonly id: string;
	readonly event_type: string;
	readonly payload: unknown;
}

class FakeWriteClient {
	readonly calls: Array<{ text: string; params?: readonly unknown[] }> = [];
	readonly marked: string[] = [];
	constructor(
		private readonly _outbox: OutboxRow[],
		private readonly _memories: Map<string, string> = new Map(),
		private readonly _decisions: Map<string, Record<string, unknown>> = new Map(),
		private readonly _events: Map<string, Record<string, unknown>> = new Map(),
		private readonly _remaining = 0
	) { }
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, params });
		if (text.includes('FROM neo4j_outbox WHERE processed_at IS NULL')) {
			return { rows: this._outbox as unknown as Array<Record<string, unknown>> };
		}
		if (text.includes('SELECT content FROM memories')) {
			const content = this._memories.get(String(params[1]));
			return { rows: content === undefined ? [] : [{ content }] };
		}
		if (text.includes('FROM decisions WHERE')) {
			const decision = this._decisions.get(String(params[1]));
			return { rows: decision ? [decision] : [] };
		}
		if (text.includes('FROM events WHERE')) {
			const event = this._events.get(String(params[1]));
			return { rows: event ? [event] : [] };
		}
		if (text.includes('UPDATE neo4j_outbox SET processed_at')) {
			this.marked.push(String(params[0]));
			return { rows: [] };
		}
		if (text.includes('COUNT(*)')) {
			return { rows: [{ n: this._remaining }] };
		}
		return { rows: [] };
	}
}

class RecordingRepo {
	readonly merges: Array<{ type: GraphNodeType; input: Record<string, unknown> }> = [];
	readonly edges: Array<{ projectId: string; fromId: string; type: GraphRelationshipType; toId: string }> = [];
	readonly ensuredProjects: string[] = [];
	async ensureProject(projectId: string): Promise<unknown> {
		this.ensuredProjects.push(projectId);
		return { projectId };
	}
	async mergeNode(type: GraphNodeType, input: { readonly id: string; readonly projectId: string; readonly [property: string]: unknown }): Promise<unknown> {
		this.merges.push({ type, input: { ...input } });
		return input;
	}
	async createRelationship(projectId: string, fromId: string, type: GraphRelationshipType, toId: string): Promise<void> {
		this.edges.push({ projectId, fromId, type, toId });
	}
}

suite('PPB outbox projector (spec §9.3/§10/§11/§24)', () => {

	test('memory_upsert projects a fact to its mapped node type and marks it processed', async () => {
		const client = new FakeWriteClient(
			[{ id: 'ob-1', event_type: 'memory_upsert', payload: { factId: 'mem-1', projectId: 'projectA', category: 'technology_stack' } }],
			new Map([['mem-1', 'PostgreSQL is the persistence store']])
		);
		const repo = new RecordingRepo();
		const result = await projectOutbox(client, repo);
		assert.strictEqual(result.projected, 1);
		assert.strictEqual(repo.merges[0].type, 'Technology');
		assert.deepStrictEqual(repo.ensuredProjects, ['projectA'], 'the Project node is ensured');
		assert.deepStrictEqual(repo.edges, [{ projectId: 'projectA', fromId: 'projectA', type: 'USES', toId: 'mem-1' }], '(Project)-[:USES]->(Technology)');
		assert.deepStrictEqual(client.marked, ['ob-1']);
	});

	test('memory_upsert for a non-technology fact links it to the project with PART_OF', async () => {
		const client = new FakeWriteClient(
			[{ id: 'ob-c', event_type: 'memory_upsert', payload: { factId: 'mem-c', projectId: 'projectA', category: 'constraints' } }],
			new Map([['mem-c', 'No paid services allowed']])
		);
		const repo = new RecordingRepo();
		await projectOutbox(client, repo);
		assert.strictEqual(repo.merges[0].type, 'Constraint');
		assert.deepStrictEqual(repo.edges, [{ projectId: 'projectA', fromId: 'mem-c', type: 'PART_OF', toId: 'projectA' }], '(Constraint)-[:PART_OF]->(Project)');
	});

	test('decision_upsert projects a Decision node with reason/alternatives/status (§10)', async () => {
		const client = new FakeWriteClient(
			[{ id: 'ob-d', event_type: 'decision_upsert', payload: { decisionId: 'dec-1', projectId: 'projectA', status: 'accepted' } }],
			new Map(),
			new Map([['dec-1', { decision: 'Use Clerk', reason: 'DX', alternatives: 'Auth.js', status: 'accepted', author: 'dev', decided_at: '2026-01-01T00:00:00.000Z' }]])
		);
		const repo = new RecordingRepo();
		await projectOutbox(client, repo);
		assert.strictEqual(repo.merges[0].type, 'Decision');
		assert.strictEqual(repo.merges[0].input.decision, 'Use Clerk');
		assert.strictEqual(repo.merges[0].input.status, 'accepted');
		assert.strictEqual(repo.merges[0].input.reason, 'DX');
		assert.deepStrictEqual(repo.edges, [{ projectId: 'projectA', fromId: 'dec-1', type: 'PART_OF', toId: 'projectA' }], '(Decision)-[:PART_OF]->(Project)');
	});

	test('event_upsert projects a dated Event node (§11)', async () => {
		const client = new FakeWriteClient(
			[{ id: 'ob-e', event_type: 'event_upsert', payload: { eventId: 'ev-1', projectId: 'projectA', eventType: 'migrated' } }],
			new Map(),
			new Map(),
			new Map([['ev-1', { description: 'Migrated to Better Auth', occurred_at: '2026-01-24T00:00:00.000Z', event_type: 'migrated' }]])
		);
		const repo = new RecordingRepo();
		await projectOutbox(client, repo);
		assert.strictEqual(repo.merges[0].type, 'Event');
		assert.strictEqual(repo.merges[0].input.type, 'migrated');
		assert.strictEqual(repo.merges[0].input.occurredAt, '2026-01-24T00:00:00.000Z');
		assert.deepStrictEqual(repo.edges, [{ projectId: 'projectA', fromId: 'ev-1', type: 'PART_OF', toId: 'projectA' }], '(Event)-[:PART_OF]->(Project)');
	});

	test('decision_supersedes creates the SUPERSEDES edge (§10.4)', async () => {
		const client = new FakeWriteClient(
			[{ id: 'ob-s', event_type: 'decision_supersedes', payload: { decisionId: 'dec-new', supersededId: 'dec-old', projectId: 'projectA' } }]
		);
		const repo = new RecordingRepo();
		await projectOutbox(client, repo);
		assert.deepStrictEqual(repo.edges, [{ projectId: 'projectA', fromId: 'dec-new', type: 'SUPERSEDES', toId: 'dec-old' }]);
	});

	test('memory_supersedes creates the SUPERSEDES edge between the replacement and the archived memory (§13)', async () => {
		const client = new FakeWriteClient(
			[{ id: 'ob-m', event_type: 'memory_supersedes', payload: { memoryId: 'mem-old', supersededById: 'mem-new', projectId: 'projectA' } }]
		);
		const repo = new RecordingRepo();
		await projectOutbox(client, repo);
		assert.deepStrictEqual(repo.edges, [{ projectId: 'projectA', fromId: 'mem-new', type: 'SUPERSEDES', toId: 'mem-old' }]);
	});

	test('relationship_upsert creates an edge between two extracted facts (Tier 2)', async () => {
		const client = new FakeWriteClient(
			[{ id: 'ob-rel', event_type: 'relationship_upsert', payload: { projectId: 'projectA', fromId: 'mem-pg', toId: 'mem-aws', relationshipType: 'DEPENDS_ON' } }]
		);
		const repo = new RecordingRepo();
		await projectOutbox(client, repo);
		assert.deepStrictEqual(repo.edges, [{ projectId: 'projectA', fromId: 'mem-pg', type: 'DEPENDS_ON', toId: 'mem-aws' }]);
	});

	test('decision_decided_on merges the chosen technology and creates the DECIDED_ON edge (§6.10)', async () => {
		const client = new FakeWriteClient(
			[{ id: 'ob-do', event_type: 'decision_decided_on', payload: { projectId: 'projectA', decisionId: 'dec-1', technologyName: 'Prisma', technologyId: 'ppb:tech:projectA:prisma' } }]
		);
		const repo = new RecordingRepo();
		await projectOutbox(client, repo);
		assert.strictEqual(repo.merges[0].type, 'Technology');
		assert.strictEqual(repo.merges[0].input.name, 'Prisma');
		assert.deepStrictEqual(repo.edges, [{ projectId: 'projectA', fromId: 'dec-1', type: 'DECIDED_ON', toId: 'ppb:tech:projectA:prisma' }]);
	});

	test('decision_rejected merges the rejected technology and creates the REJECTED edge (§10.3)', async () => {
		const client = new FakeWriteClient(
			[{ id: 'ob-r', event_type: 'decision_rejected', payload: { decisionId: 'dec-1', projectId: 'projectA', technologyId: 'ppb:tech:projectA:auth-js', technologyName: 'Auth.js' } }]
		);
		const repo = new RecordingRepo();
		await projectOutbox(client, repo);
		assert.strictEqual(repo.merges[0].type, 'Technology');
		assert.strictEqual(repo.merges[0].input.name, 'Auth.js');
		assert.deepStrictEqual(repo.edges, [{ projectId: 'projectA', fromId: 'dec-1', type: 'REJECTED', toId: 'ppb:tech:projectA:auth-js' }]);
	});

	test('a malformed payload fails without being marked processed, and never blocks the rest', async () => {
		const client = new FakeWriteClient([
			{ id: 'ob-bad', event_type: 'memory_upsert', payload: { factId: 'mem-1' } },
			{ id: 'ob-ok', event_type: 'decision_supersedes', payload: { decisionId: 'a', supersededId: 'b', projectId: 'projectA' } }
		]);
		const repo = new RecordingRepo();
		const result = await projectOutbox(client, repo);
		assert.strictEqual(result.projected, 1);
		assert.strictEqual(result.failed, 1);
		assert.deepStrictEqual(client.marked, ['ob-ok']);
	});

	test('an unknown event type is left unprocessed for retry', async () => {
		const client = new FakeWriteClient([{ id: 'ob-x', event_type: 'mystery', payload: { projectId: 'projectA' } }]);
		const result = await projectOutbox(client, new RecordingRepo());
		assert.strictEqual(result.failed, 1);
		assert.deepStrictEqual(client.marked, []);
	});

	test('the category mapping is total over the six categories', () => {
		for (const category of ['technology_stack', 'architecture_patterns', 'business_rules', 'engineering_standards', 'constraints', 'developer_preferences'] as const) {
			assert.ok(CATEGORY_TO_GRAPH_NODE[category], category);
		}
	});

	test('rejects a bad limit before querying', async () => {
		const client = new FakeWriteClient([]);
		await assert.rejects(() => projectOutbox(client, new RecordingRepo(), { limit: 0 }));
		assert.strictEqual(client.calls.length, 0);
	});
});