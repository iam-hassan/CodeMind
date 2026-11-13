/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-store isolation tests (spec §2/§6.6/§9.5/§15.9).
 *
 * One test per store plus one end-to-end retrieval, all against injected fakes that honour the
 * project predicate. A regression that drops a `project_id` filter fails these immediately.
 */

import assert from 'assert';
import type { EmbeddingClient } from '../../ppb/embeddings/embedder.js';
import { searchFactsByVector } from '../../ppb/embeddings/vectorStore.js';
import { GraphRepository, type Neo4jDriverLike, type Neo4jRecord, type Neo4jRunResult, type Neo4jSession } from '../../ppb/graph/graphRepo.js';
import { PpbRetriever } from '../../ppb/retrieval/retriever.js';
import { findFacts } from '../../ppb/storage/read.js';

interface MemoryRow { id: string; project_id: string; category: string; content: string; confidence: number; importance: number; source_ref: string | null; author: string | null; extracted_at: string; status: string; access_count: number; }
interface EmbeddingRow { owner_id: string; project_id: string; owner_kind: string; status: string; similarity: number; }

class RelationalStore {
	readonly calls: Array<{ text: string; params: readonly unknown[] }> = [];
	constructor(readonly memories: MemoryRow[], readonly embeddings: EmbeddingRow[]) { }

	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, params });
		if (text.includes('<=>')) {
			const projectId = String(params[1]);
			return {
				rows: this.embeddings
					.filter(entry => entry.project_id === projectId && entry.status === 'active')
					.map(entry => ({ owner_id: entry.owner_id, owner_kind: entry.owner_kind, similarity: entry.similarity }))
			};
		}
		if (text.includes('FROM memories')) {
			const projectId = String(params[0]);
			return { rows: this.memories.filter(memory => memory.project_id === projectId) as unknown as Array<Record<string, unknown>> };
		}
		return { rows: [] };
	}
}

function memory(id: string, projectId: string, content: string): MemoryRow {
	return { id, project_id: projectId, category: 'technology_stack', content, confidence: 0.9, importance: 0.8, source_ref: `${projectId}:${id}`, author: 'user', extracted_at: '2026-01-01T00:00:00.000Z', status: 'active', access_count: 0 };
}

const embedding: EmbeddingClient = { model: 'test', dimension: 2, embed: async () => [[1, 0]] };

interface NodeData { id: string; projectId: string; type: string; scope?: string; }
const EMPTY_GRAPH = { expandFromSeeds: async () => [] } as unknown as GraphRepository;

function nodeRecord(node: NodeData): Neo4jRecord {
	const properties = { id: node.id, projectId: node.projectId, ...(node.scope ? { scope: node.scope } : {}) };
	// A record value (what `record.get()` returns), not a record itself.
	return { properties, labels: [node.type] } as unknown as Neo4jRecord;
}

class FakeGraphSession implements Neo4jSession {
	readonly calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
	constructor(private readonly _nodes: NodeData[]) { }

	async run(query: string, params: Record<string, unknown> = {}): Promise<Neo4jRunResult> {
		this.calls.push({ query, params });
		const projectId = String(params.projectId ?? '');
		// Honour the label in `MATCH (n:`Technology` …)` so a typed read returns one type only.
		const labels = [...query.matchAll(/\(\w*:`([^`]+)`/g)].map(match => match[1]);
		const matchesLabel = (node: NodeData) => labels.length === 0 || labels.includes(node.type);
		// The deliberate global exception (§6.6) must stay visible to every project.
		const global = query.includes("scope: 'global'") ? this._nodes.filter(node => node.scope === 'global' && matchesLabel(node)) : [];
		const scoped = this._nodes.filter(node => node.projectId === projectId && node.scope !== 'global' && matchesLabel(node));
		const rows = [...scoped, ...global];
		const alias = query.includes('RETURN DISTINCT m') ? 'm' : query.includes('RETURN p AS pref') || query.includes('RETURN g AS pref') ? 'pref' : query.includes('RETURN n') ? 'n' : 'n';
		return { records: rows.map(node => ({ get: (key: string) => key === alias ? nodeRecord(node) : undefined })) };
	}

	close(): void { /* no-op */ }
}

class FakeDriver implements Neo4jDriverLike {
	constructor(private readonly _session: FakeGraphSession) { }
	session(): Neo4jSession { return this._session; }
}

suite('PPB cross-store isolation (spec §2)', () => {

	test('SQL reads return only the requesting project', async () => {
		const store = new RelationalStore([memory('a1', 'projectA', 'A uses PostgreSQL'), memory('b1', 'projectB', 'B uses MongoDB')], []);
		const factsA = await findFacts(store, 'projectA');
		const factsB = await findFacts(store, 'projectB');

		assert.deepStrictEqual(factsA.map(fact => fact.id), ['a1']);
		assert.deepStrictEqual(factsB.map(fact => fact.id), ['b1']);
		assert.ok(store.calls.every(call => call.text.includes('project_id = $1')), 'every SQL read carries a project predicate');
		assert.deepStrictEqual(store.calls.map(call => call.params[0]), ['projectA', 'projectB']);
	});

	test('vector search joins on the requesting project and only active facts', async () => {
		const store = new RelationalStore([], [
			{ owner_id: 'a1', project_id: 'projectA', owner_kind: 'fact', status: 'active', similarity: 0.95 },
			{ owner_id: 'a2', project_id: 'projectA', owner_kind: 'fact', status: 'archived', similarity: 0.9 },
			{ owner_id: 'b1', project_id: 'projectB', owner_kind: 'fact', status: 'active', similarity: 0.99 }
		]);

		const matches = await searchFactsByVector(store, 'projectA', [1, 0], 10);

		assert.deepStrictEqual(matches.map(match => match.ownerId), ['a1']);
		const call = store.calls[0];
		assert.ok(call.text.includes('m.project_id = $2'));
		assert.ok(call.text.includes("m.status = 'active'"));
		assert.strictEqual(call.params[1], 'projectA');
	});

	test('graph reads/traversals are scoped to the project', async () => {
		const nodes: NodeData[] = [
			{ id: 'a-auth', projectId: 'projectA', type: 'Technology' },
			{ id: 'a-module', projectId: 'projectA', type: 'Module' },
			{ id: 'b-auth', projectId: 'projectB', type: 'Technology' }
		];
		const session = new FakeGraphSession(nodes);
		const repo = new GraphRepository(new FakeDriver(session));

		const found = await repo.findNodes('projectA', 'Technology');
		const expanded = await repo.expandFromSeeds('projectA', ['a-auth']);
		const impacted = await repo.impactAnalysis('projectA', 'a-auth');

		assert.deepStrictEqual(found.map(node => node.id), ['a-auth']);
		assert.deepStrictEqual(expanded.map(node => node.id), ['a-auth', 'a-module']);
		assert.deepStrictEqual(impacted.map(node => node.id), ['a-auth', 'a-module']);
		for (const call of session.calls) {
			assert.strictEqual(call.params?.projectId, 'projectA');
		}
	});

	test('global preferences surface in every project while project preferences do not cross', async () => {
		const session = new FakeGraphSession([
			{ id: 'pref-a', projectId: 'projectA', type: 'Preference' },
			{ id: 'pref-b', projectId: 'projectB', type: 'Preference' },
			{ id: 'pref-global', projectId: 'ignored', type: 'Preference', scope: 'global' }
		]);
		const repo = new GraphRepository(new FakeDriver(session));

		const prefsA = (await repo.retrievePreferences('projectA')).map(node => node.id).sort();
		const prefsB = (await repo.retrievePreferences('projectB')).map(node => node.id).sort();

		assert.deepStrictEqual(prefsA, ['pref-a', 'pref-global']);
		assert.deepStrictEqual(prefsB, ['pref-b', 'pref-global']);
		assert.ok(session.calls.every(call => call.query.includes("scope: 'global'")));
	});

	test('end-to-end retrieval cannot surface another project\'s facts', async () => {
		const store = new RelationalStore([
			memory('a1', 'projectA', 'Project A uses PostgreSQL'),
			memory('b1', 'projectB', 'Project B uses MongoDB')
		], [
			{ owner_id: 'a1', project_id: 'projectA', owner_kind: 'fact', status: 'active', similarity: 0.95 },
			{ owner_id: 'b1', project_id: 'projectB', owner_kind: 'fact', status: 'active', similarity: 0.99 }
		]);
		const retriever = new PpbRetriever({ read: store, graph: EMPTY_GRAPH, embedding });

		const facts = await retriever.retrieve({
			projectId: 'projectA', query: 'database', intent: 'architecture', openFiles: [],
			recentTurns: [], maxResults: 10, maxTokenBudget: 2000
		});

		assert.deepStrictEqual(facts.map(fact => fact.id), ['a1']);
		assert.ok(facts.every(fact => fact.projectId === 'projectA'));
	});
});
