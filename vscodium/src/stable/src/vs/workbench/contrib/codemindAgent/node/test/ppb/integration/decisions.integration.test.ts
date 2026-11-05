/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live decision/event integration test (P1-T12) — gated by `PPB_TEST_INFRA=1`.
 * Exercises §10/§11 end to end: store → supersede → project to Neo4j → traversal.
 */

import assert from 'assert';
import { loadPpbConfig } from '../../../ppb/config.js';
import {
	createDecision,
	recordEvent,
	rejectedTechnologyId,
	supersedeDecision
} from '../../../ppb/decisions/decisionMemory.js';
import { GraphRepository } from '../../../ppb/graph/graphRepo.js';
import { projectOutbox } from '../../../ppb/graph/projector.js';
import { createNeo4jDriver } from '../../../ppb/storage/neo4j.js';
import { applyPpbMigrations, createPgClient } from '../../../ppb/storage/pg.js';

const enabled = process.env.PPB_TEST_INFRA === '1';

suite('PPB decision/event memory (live)', function () {
	this.timeout(30_000);
	setup(function () {
		if (!enabled) { this.skip(); }
	});

	test('decisions, rejected alternatives, supersession and events are stored and projected (§10/§11/§24)', async () => {
		const config = loadPpbConfig();
		const client = createPgClient(config.pgUrl);
		await client.connect();
		const driver = createNeo4jDriver(config);
		const repo = new GraphRepository(driver);
		try {
			await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
			await applyPpbMigrations(config);
			await client.query("INSERT INTO projects (id, name) VALUES ('projectA', 'A')");

			const clerk = await createDecision(client, {
				projectId: 'projectA', decision: 'Use Clerk for authentication', reason: 'DX',
				alternatives: 'Auth.js', rejectedAlternatives: ['Auth.js'], author: 'dev'
			});
			assert.strictEqual(clerk.status, 'accepted');
			await recordEvent(client, { projectId: 'projectA', eventType: 'added', description: 'Clerk added' });

			const migrated = await supersedeDecision(client, 'projectA', clerk.id, { decision: 'Migrate to Better Auth', reason: 'features' });
			assert.strictEqual(migrated.previous.status, 'superseded');
			assert.strictEqual(migrated.previous.supersededBy, migrated.next.id);
			assert.strictEqual(migrated.next.status, 'accepted');
			await recordEvent(client, { projectId: 'projectA', eventType: 'migrated', description: 'Migrated to Better Auth' });

			const projection = await projectOutbox(client, repo);
			assert.strictEqual(projection.projected, 7, 'clerk, rejected, added-event, next, superseded-clerk, supersedes, migrated-event');
			assert.strictEqual(projection.remaining, 0);

			// Graph state reflects PostgreSQL (the source of truth).
			assert.strictEqual((await repo.getNode('projectA', 'Decision', clerk.id))?.properties.status, 'superseded');
			assert.strictEqual((await repo.getNode('projectA', 'Decision', migrated.next.id))?.properties.status, 'accepted');
			assert.ok(await repo.getNode('projectA', 'Technology', rejectedTechnologyId('projectA', 'Auth.js')), 'rejected alternative is retrievable (§10.3)');

			// SUPERSEDES chain is traversable for historical reasoning (§10.6/§17).
			const history = await repo.history('projectA', migrated.next.id);
			assert.ok(history.chain.some(node => node.id === clerk.id), 'the superseded decision is reachable');
			// REJECTED edge exists.
			assert.strictEqual((await repo.getRelationships('projectA', clerk.id, { type: 'REJECTED' })).length, 1);
		} finally {
			const session = driver.session();
			try {
				await session.run('MATCH (n {projectId: $projectId}) DETACH DELETE n', { projectId: 'projectA' });
			} finally {
				await session.close();
				await driver.close();
			}
			await client.end();
		}
	});
});