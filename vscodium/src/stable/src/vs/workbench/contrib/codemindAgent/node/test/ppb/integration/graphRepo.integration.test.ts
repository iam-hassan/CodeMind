/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live Neo4j tests for the graph repository (P1-T03) — gated by `PPB_TEST_INFRA=1`.
 *
 * T03 is not complete until these pass: repository operations and project isolation are
 * proven against the real service brought up by `infra/ppb/docker-compose.yml`.
 */

import assert from 'assert';
import { loadPpbConfig } from '../../../ppb/config.js';
import { GraphRepository, PpbGraphError } from '../../../ppb/graph/graphRepo.js';
import { applyGraphConstraints, createNeo4jDriver } from '../../../ppb/storage/neo4j.js';
import type { Driver } from 'neo4j-driver';

const enabled = process.env.PPB_TEST_INFRA === '1';
const run = `${Date.now()}`;
const projectA = `ppb-graph-itest-a-${run}`;
const projectB = `ppb-graph-itest-b-${run}`;
const globalPrefId = `ppb-graph-itest-global-${run}`;

suite('PPB graph repository (live Neo4j)', function () {

	this.timeout(30_000);

	let driver: Driver;
	let repo: GraphRepository;

	setup(async function () {
		if (!enabled) {
			this.skip();
		}
		driver = createNeo4jDriver(loadPpbConfig());
		repo = new GraphRepository(driver);
		await applyGraphConstraints(driver);
	});

	teardown(async () => {
		if (!enabled) {
			return;
		}
		const session = driver.session();
		try {
			await session.run('MATCH (n) WHERE n.projectId IN $projects DETACH DELETE n', { projects: [projectA, projectB] });
			await session.run('MATCH (p:Preference {id: $id}) DETACH DELETE p', { id: globalPrefId });
		} finally {
			await session.close();
			await driver.close();
		}
	});

	test('ensureProject creates the project node and is idempotent (§6.6)', async () => {
		const first = await repo.ensureProject(projectA);
		assert.strictEqual(first.type, 'Project');
		assert.strictEqual(first.projectId, projectA);
		const second = await repo.ensureProject(projectA);
		assert.strictEqual(second.id, first.id);
		const projects = await repo.findNodes(projectA, 'Project');
		assert.strictEqual(projects.length, 1);
	});

	test('createNode + getNode round-trip (§6.9 write/read)', async () => {
		await repo.createNode('Module', { id: 'mod-a', projectId: projectA, name: 'auth-service' });
		const node = await repo.getNode(projectA, 'Module', 'mod-a');
		assert.ok(node);
		assert.strictEqual(node.type, 'Module');
		assert.strictEqual(node.properties.name, 'auth-service');
		assert.strictEqual(String(node.properties.createdAt).length > 0, true);
	});

	test('duplicate ids are rejected by the uniqueness constraint (§6.5)', async () => {
		await repo.createNode('Technology', { id: 'tech-dup', projectId: projectA, name: 'Clerk' });
		await assert.rejects(
			() => repo.createNode('Technology', { id: 'tech-dup', projectId: projectA, name: 'Clerk' }),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'duplicate-node'
		);
	});

	test('mergeNode is idempotent and updates properties (§6.9)', async () => {
		await repo.mergeNode('Technology', { id: 'tech-merge', projectId: projectA, name: 'PostgreSQL' });
		await repo.mergeNode('Technology', { id: 'tech-merge', projectId: projectA, name: 'PostgreSQL', category: 'database' });
		const nodes = await repo.findNodes(projectA, 'Technology', 100);
		assert.strictEqual(nodes.filter(node => node.id === 'tech-merge').length, 1);
		const node = await repo.getNode(projectA, 'Technology', 'tech-merge');
		assert.strictEqual(node?.properties.category, 'database');
	});

	test('relationships are created and retrieved in both directions (§6.4/§6.9)', async () => {
		await repo.createNode('Module', { id: 'rel-mod', projectId: projectA, name: 'auth-service' });
		await repo.createNode('Technology', { id: 'rel-pg', projectId: projectA, name: 'PostgreSQL' });
		await repo.createRelationship(projectA, 'rel-mod', 'DEPENDS_ON', 'rel-pg', { note: 'primary store' });

		// Re-creating the same edge must not duplicate it (review M8: MERGE, not CREATE).
		await repo.createRelationship(projectA, 'rel-mod', 'DEPENDS_ON', 'rel-pg', { note: 'primary store' });
		const idempotent = await repo.getRelationships(projectA, 'rel-mod', { direction: 'out', type: 'DEPENDS_ON' });
		assert.strictEqual(idempotent.length, 1, 're-creating the same edge is idempotent (§6.9)');

		const out = await repo.getRelationships(projectA, 'rel-mod', { direction: 'out' });
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].type, 'DEPENDS_ON');
		assert.strictEqual(out[0].toId, 'rel-pg');
		assert.strictEqual(out[0].properties.note, 'primary store');

		const incoming = await repo.getRelationships(projectA, 'rel-pg', { direction: 'in' });
		assert.strictEqual(incoming.length, 1);
		assert.strictEqual(incoming[0].fromId, 'rel-mod');

		const filtered = await repo.getRelationships(projectA, 'rel-mod', { type: 'USES' });
		assert.strictEqual(filtered.length, 0);
	});

	test('project isolation: nothing leaks across projects (§6.6)', async () => {
		await repo.createNode('Module', { id: 'iso-a', projectId: projectA, name: 'shared-name' });
		await repo.createNode('Module', { id: 'iso-b', projectId: projectB, name: 'shared-name' });

		assert.strictEqual(await repo.getNode(projectA, 'Module', 'iso-b'), undefined);
		const nodesB = await repo.findNodes(projectB, 'Module', 100);
		assert.ok(nodesB.every(node => node.projectId === projectB));
		assert.strictEqual(nodesB.filter(node => node.id === 'iso-a').length, 0);

		await assert.rejects(
			() => repo.createRelationship(projectA, 'iso-a', 'USES', 'iso-b'),
			(error: unknown) => error instanceof PpbGraphError && error.code === 'endpoints-missing'
		);
	});

	test('graph expansion surfaces structurally related neighbours (§6.8)', async () => {
		await repo.createNode('Module', { id: 'exp-mod', projectId: projectA, name: 'auth-service' });
		await repo.createNode('Technology', { id: 'exp-clerk', projectId: projectA, name: 'Clerk' });
		await repo.createRelationship(projectA, 'exp-mod', 'USES', 'exp-clerk');

		const expanded = await repo.expandFromSeeds(projectA, ['exp-mod']);
		assert.deepStrictEqual(expanded.map(node => node.id), ['exp-clerk']);

		const withSeeds = await repo.expandFromSeeds(projectA, ['exp-mod'], { maxHops: 2 });
		assert.ok(withSeeds.every(node => node.id !== 'exp-mod'), 'seeds are excluded from expansion');
	});

	test('impact analysis traverses the §6.8 relationship set in both directions', async () => {
		await repo.createNode('Module', { id: 'imp-mod', projectId: projectA, name: 'auth-service' });
		await repo.createNode('Technology', { id: 'imp-pg', projectId: projectA, name: 'PostgreSQL' });
		await repo.createNode('Decision', { id: 'imp-dec', projectId: projectA, decision: 'Use PostgreSQL' });
		await repo.createRelationship(projectA, 'imp-mod', 'DEPENDS_ON', 'imp-pg');
		await repo.createRelationship(projectA, 'imp-dec', 'AFFECTS', 'imp-mod');

		const fromDatabase = await repo.impactAnalysis(projectA, 'imp-pg');
		const ids = fromDatabase.map(node => node.id);
		assert.ok(ids.includes('imp-mod'), 'direct dependent is affected');
		assert.ok(ids.includes('imp-dec'), 'two-hop affected node reached via AFFECTS');

		const oneHop = await repo.impactAnalysis(projectA, 'imp-pg', { maxHops: 1 });
		assert.deepStrictEqual(oneHop.map(node => node.id), ['imp-mod']);
	});

	test('historical traversal reconstructs SUPERSEDES chains and rejected alternatives (§6.8/§13)', async () => {
		await repo.createNode('Decision', { id: 'hist-old', projectId: projectA, decision: 'Use Clerk', status: 'archived' });
		await repo.createNode('Decision', { id: 'hist-new', projectId: projectA, decision: 'Migrate to Better Auth', status: 'active' });
		await repo.createNode('Technology', { id: 'hist-rejected', projectId: projectA, name: 'Auth.js' });
		await repo.createRelationship(projectA, 'hist-new', 'SUPERSEDES', 'hist-old');
		await repo.createRelationship(projectA, 'hist-old', 'REJECTED', 'hist-rejected');

		const fromOld = await repo.history(projectA, 'hist-old');
		assert.deepStrictEqual(fromOld.chain.map(node => node.id).sort(), ['hist-new', 'hist-old']);
		assert.deepStrictEqual(fromOld.rejected.map(node => node.id), ['hist-rejected']);

		const fromNew = await repo.history(projectA, 'hist-new');
		assert.strictEqual(fromNew.chain.filter(node => node.id === 'hist-old').length, 1, 'chain walks either direction');
	});

	test('missing nodes behave explicitly (§6.12)', async () => {
		assert.strictEqual(await repo.getNode(projectA, 'Module', 'does-not-exist'), undefined);
		assert.strictEqual(await repo.updateNodeStatus(projectA, 'does-not-exist', 'archived'), 0);
		assert.deepStrictEqual(await repo.impactAnalysis(projectA, 'does-not-exist'), []);
		assert.deepStrictEqual(await repo.history(projectA, 'does-not-exist'), { chain: [], rejected: [] });
	});

	test('versioning transitions update node state only (§6.9/§13)', async () => {
		await repo.createNode('Decision', { id: 'ver-dec', projectId: projectA, decision: 'Use Clerk', status: 'active' });
		const updated = await repo.updateNodeStatus(projectA, 'ver-dec', 'archived');
		assert.strictEqual(updated, 1);
		const node = await repo.getNode(projectA, 'Decision', 'ver-dec');
		assert.strictEqual(node?.properties.status, 'archived');
		assert.strictEqual(node?.properties.decision, 'Use Clerk', 'content is not mutated in place');
	});

	test('preferences: project-scoped plus the global exception (§6.6)', async () => {
		await repo.createNode('Preference', { id: 'pref-a', projectId: projectA, description: 'Use tabs', scope: 'project' });
		await repo.saveGlobalPreference({ id: globalPrefId, description: 'Prefer functional style' });

		const forA = await repo.retrievePreferences(projectA);
		const idsA = forA.map(node => node.id);
		assert.ok(idsA.includes('pref-a'), 'project preference visible to its project');
		assert.ok(idsA.includes(globalPrefId), 'global preference visible across projects');

		const forB = await repo.retrievePreferences(projectB);
		const idsB = forB.map(node => node.id);
		assert.ok(!idsB.includes('pref-a'), 'other projects are never visible');
		assert.ok(idsB.includes(globalPrefId), 'global preference visible across projects');
	});
});
