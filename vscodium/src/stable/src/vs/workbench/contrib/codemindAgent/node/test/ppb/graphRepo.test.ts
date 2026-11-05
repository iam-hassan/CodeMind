/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the graph repository (P1-T03) — guards, error mapping and query shape.
 * These never touch a server; live behaviour is proven by
 * `integration/graphRepo.integration.test.ts` (PPB_TEST_INFRA=1).
 */

import assert from 'assert';
import {
	GraphRepository,
	PpbGraphError,
	type Neo4jDriverLike,
	type Neo4jRecord,
	type Neo4jRunResult,
	type Neo4jSession
} from '../../ppb/graph/graphRepo.js';

class FakeSession implements Neo4jSession {

	readonly calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
	private readonly _results: Neo4jRunResult[];
	private readonly _throwOn: string | undefined;

	constructor(results: Neo4jRunResult[] = [], throwOn?: string) {
		this._results = [...results];
		this._throwOn = throwOn;
	}

	async run(query: string, params?: Record<string, unknown>): Promise<Neo4jRunResult> {
		this.calls.push({ query, params });
		if (this._throwOn && query.includes(this._throwOn)) {
			const error = new Error('constraint violation') as Error & { code?: string };
			error.code = 'Neo.ClientError.Schema.ConstraintValidationFailed';
			throw error;
		}
		return this._results.shift() ?? { records: [] };
	}

	close(): void { /* no-op */ }
}

class FakeDriver implements Neo4jDriverLike {
	constructor(private readonly _session: FakeSession) { }
	session(): Neo4jSession { return this._session; }
}

function record(key: string, value: unknown): Neo4jRecord {
	return { get: (k: string) => (k === key ? value : undefined) };
}

const moduleNode = { properties: { id: 'm1', projectId: 'p1', name: 'auth-service' }, labels: ['Module'] };

function repoWith(session: FakeSession): { repo: GraphRepository; session: FakeSession } {
	return { repo: new GraphRepository(new FakeDriver(session)), session };
}

suite('PPB graph repository — guards and shape (P1-T03)', () => {

	test('rejects a missing/empty projectId before touching the driver (§6.12)', async () => {
		const { repo, session } = repoWith(new FakeSession());
		const calls: Array<() => Promise<unknown>> = [
			() => repo.getNode('', 'Module', 'm1'),
			() => repo.findNodes('', 'Module'),
			() => repo.updateNodeStatus('', 'm1', 'archived'),
			() => repo.impactAnalysis('', 'm1'),
			() => repo.expandFromSeeds('', ['m1']),
			() => repo.history('', 'm1'),
			() => repo.retrievePreferences(''),
			() => repo.ensureProject(''),
			() => repo.createRelationship('', 'a', 'USES', 'b'),
			() => repo.createNode('Module', { id: 'm1', projectId: '' })
		];
		for (const call of calls) {
			await assert.rejects(call, (error: unknown) => error instanceof PpbGraphError && error.code === 'invalid-project');
		}
		assert.strictEqual(session.calls.length, 0, 'guards must run before any driver call');
	});

	test('rejects unknown node types (§6.3)', async () => {
		const { repo } = repoWith(new FakeSession());
		await assert.rejects(
			() => repo.getNode('p1', 'Service' as never, 'x'),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'invalid-node-type'
		);
	});

	test('rejects unknown relationship types (§6.4)', async () => {
		const { repo } = repoWith(new FakeSession());
		await assert.rejects(
			() => repo.createRelationship('p1', 'a', 'RELATED_TO' as never, 'b'),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'invalid-relationship-type'
		);
	});

	test('rejects out-of-range maxHops and unknown directions', async () => {
		const { repo } = repoWith(new FakeSession());
		await assert.rejects(
			() => repo.impactAnalysis('p1', 'm1', { maxHops: 0 }),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'invalid-option'
		);
		await assert.rejects(
			() => repo.impactAnalysis('p1', 'm1', { maxHops: 99 }),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'invalid-option'
		);
		await assert.rejects(
			() => repo.getRelationships('p1', 'm1', { direction: 'sideways' as never }),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'invalid-option'
		);
	});

	test('rejects a non-positive find limit', async () => {
		const { repo } = repoWith(new FakeSession());
		await assert.rejects(
			() => repo.findNodes('p1', 'Module', 0),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'invalid-option'
		);
	});

	test('createNode maps a uniqueness violation to duplicate-node (§6.5)', async () => {
		const { repo } = repoWith(new FakeSession([], 'CREATE (n:'));
		await assert.rejects(
			() => repo.createNode('Module', { id: 'm1', projectId: 'p1', name: 'auth-service' }),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'duplicate-node'
		);
	});

	test('createRelationship reports endpoints-missing when the endpoints are not in the project', async () => {
		const { repo } = repoWith(new FakeSession([{ records: [] }]));
		await assert.rejects(
			() => repo.createRelationship('p1', 'a', 'USES', 'b'),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'endpoints-missing'
		);
	});

	test('getNode maps a driver record to a typed GraphNode', async () => {
		const { repo } = repoWith(new FakeSession([{ records: [record('n', moduleNode)] }]));
		const node = await repo.getNode('p1', 'Module', 'm1');
		assert.ok(node);
		assert.strictEqual(node.type, 'Module');
		assert.strictEqual(node.id, 'm1');
		assert.strictEqual(node.projectId, 'p1');
		assert.strictEqual(node.properties.name, 'auth-service');
	});

	test('getNode returns undefined when there is no record', async () => {
		const { repo } = repoWith(new FakeSession([{ records: [] }]));
		assert.strictEqual(await repo.getNode('p1', 'Module', 'missing'), undefined);
	});

	test('impactAnalysis is project-scoped, bounded and uses the §6.8 relationship set', async () => {
		const { repo, session } = repoWith(new FakeSession([{ records: [] }]));
		await repo.impactAnalysis('p1', 'm1', { maxHops: 2 });
		const call = session.calls[0];
		assert.ok(call.query.includes('projectId: $projectId'), 'query must be project-scoped');
		assert.ok(call.query.includes('`DEPENDS_ON`|`AFFECTS`|`USES`|`HOSTED_ON`'), 'impact relationship set');
		assert.ok(call.query.includes('*1..2'), 'hop bound must be applied');
		assert.strictEqual(call.params?.projectId, 'p1');
		assert.strictEqual(call.params?.id, 'm1');
	});

	test('findNodes interpolates a validated limit and scopes to the project', async () => {
		const { repo, session } = repoWith(new FakeSession([{ records: [] }]));
		await repo.findNodes('p1', 'Technology', 25);
		const call = session.calls[0];
		assert.ok(call.query.includes('LIMIT 25'), 'limit is interpolated as an integer (Neo4j rejects float params)');
		assert.strictEqual(call.params?.limit, undefined);
		assert.strictEqual(call.params?.projectId, 'p1');
	});

	test('retrievePreferences keeps the deliberate global exception (§6.6)', async () => {
		const { repo, session } = repoWith(new FakeSession([{ records: [] }]));
		await repo.retrievePreferences('p1');
		assert.ok(session.calls[0].query.includes("scope: 'global'"), 'global preferences must stay retrievable');
	});

	test('expandFromSeeds short-circuits on empty seeds without touching the driver', async () => {
		const { repo, session } = repoWith(new FakeSession());
		assert.deepStrictEqual(await repo.expandFromSeeds('p1', []), []);
		assert.strictEqual(session.calls.length, 0);
	});

	test('query aliases and record mapping stay consistent (live-bug regression shapes)', async () => {
		// ensureProject / saveGlobalPreference return the node aliased as `n` — the key every
		// mapper reads. A mismatch only ever appears against a live server, so assert it here.
		const project = new FakeSession([{ records: [record('n', { properties: { id: 'p1', projectId: 'p1' }, labels: ['Project'] })] }]);
		await new GraphRepository(new FakeDriver(project)).ensureProject('p1');
		assert.ok(project.calls[0].query.includes('RETURN p AS n'));

		const globalPref = new FakeSession([{ records: [record('n', { properties: { id: 'g1' }, labels: ['Preference'] })] }]);
		await new GraphRepository(new FakeDriver(globalPref)).saveGlobalPreference({ id: 'g1' });
		assert.ok(globalPref.calls[0].query.includes('RETURN p AS n'));

		// history reads `m` for the SUPERSEDES chain and `t` for rejected alternatives.
		const history = new FakeSession([
			{ records: [record('m', moduleNode)] },
			{ records: [record('t', { properties: { id: 'r1', projectId: 'p1' }, labels: ['Technology'] })] }
		]);
		const result = await new GraphRepository(new FakeDriver(history)).history('p1', 'm1');
		assert.deepStrictEqual(result.chain.map(node => node.id), ['m1']);
		assert.deepStrictEqual(result.rejected.map(node => node.id), ['r1']);
		assert.ok(history.calls[0].query.includes('RETURN DISTINCT m'));
		assert.ok(history.calls[1].query.includes('RETURN DISTINCT t'));

		// getRelationships must not juxtapose node patterns (that is invalid Cypher).
		const relationships = new FakeSession([{ records: [] }]);
		await new GraphRepository(new FakeDriver(relationships)).getRelationships('p1', 'm1', { direction: 'out' });
		const query = relationships.calls[0].query;
		assert.ok(query.includes('MATCH (a {id: $id, projectId: $projectId})'));
		assert.ok(query.includes('MATCH (a)-[r]->(b {projectId: $projectId})'));
		assert.ok(!/\}\)\(a\)/.test(query), 'node patterns must not be juxtaposed');

		// findNodes returns its nodes aliased as `n` — the mapper must read that key.
		const found = new FakeSession([{ records: [record('n', moduleNode)] }]);
		const foundNodes = await new GraphRepository(new FakeDriver(found)).findNodes('p1', 'Module');
		assert.deepStrictEqual(foundNodes.map(node => node.id), ['m1']);
	});

	test('mergeNode maps a cross-project id collision to a typed conflict (review M7)', async () => {
		const { repo } = repoWith(new FakeSession([], 'MERGE (n:'));
		await assert.rejects(
			() => repo.mergeNode('Module', { id: 'm1', projectId: 'p1', name: 'auth-service' }),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'duplicate-node'
		);
	});

	test('createRelationship MERGEs and guards match cardinality (review M8)', async () => {
		const { repo, session } = repoWith(new FakeSession([{ records: [record('fromId', 'a')] }]));
		await repo.createRelationship('p1', 'a', 'USES', 'b');
		const query = session.calls[0].query;
		assert.ok(query.includes('MERGE (a)-[r:'), 're-ingestion must not duplicate edges');
		assert.ok(query.includes('WITH a LIMIT 1') && query.includes('WITH a, b LIMIT 1'), 'cardinality guards');
		assert.ok(!query.includes('CREATE (a)-[r:'), 'no bare CREATE');
	});
});
