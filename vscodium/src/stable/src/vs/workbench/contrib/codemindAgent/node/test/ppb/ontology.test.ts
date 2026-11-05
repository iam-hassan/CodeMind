/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	CONFLICT_RESOLUTIONS,
	DECISION_STATUSES,
	EVENT_TYPES,
	GRAPH_NODE_TYPES,
	GRAPH_RELATIONSHIP_TYPES,
	MEMORY_CATEGORIES,
	MEMORY_VERSION_STATES,
	NODE_MINIMUM_PROPERTIES,
	SHARED_MEMORY_METADATA,
	graphConstraintStatements
} from '../../ppb/ontology.js';

suite('PPB ontology (spec §6/§7)', () => {

	test('six memory categories preserved exactly (§7.4)', () => {
		assert.deepStrictEqual([...MEMORY_CATEGORIES], [
			'technology_stack',
			'architecture_patterns',
			'business_rules',
			'engineering_standards',
			'constraints',
			'developer_preferences'
		]);
	});

	test('eight graph node types preserved exactly (§6.3)', () => {
		assert.deepStrictEqual([...GRAPH_NODE_TYPES], [
			'Project',
			'Module',
			'Technology',
			'Decision',
			'Constraint',
			'Standard',
			'Preference',
			'Event'
		]);
	});

	test('eight relationship types preserved exactly (§6.4)', () => {
		assert.deepStrictEqual([...GRAPH_RELATIONSHIP_TYPES], [
			'USES',
			'HOSTED_ON',
			'DEPENDS_ON',
			'PART_OF',
			'DECIDED_ON',
			'SUPERSEDES',
			'REJECTED',
			'AFFECTS'
		]);
	});

	test('minimum properties cover every node type (§6.3)', () => {
		for (const type of GRAPH_NODE_TYPES) {
			assert.ok(NODE_MINIMUM_PROPERTIES[type].length > 0, `missing minimum properties for ${type}`);
		}
	});

	test('shared metadata contract (§7.5)', () => {
		assert.deepStrictEqual([...SHARED_MEMORY_METADATA], [
			'id',
			'extractedAt',
			'confidence',
			'sourceRef',
			'importance',
			'author'
		]);
	});

	test('version states, event types and conflict resolutions preserved (§13/§11/§12)', () => {
		assert.deepStrictEqual([...MEMORY_VERSION_STATES], ['active', 'archived', 'superseded']);
		assert.deepStrictEqual([...EVENT_TYPES], ['added', 'rejected', 'migrated', 'changed']);
		assert.deepStrictEqual([...CONFLICT_RESOLUTIONS], ['accept_migration', 'keep_existing', 'discard_incoming']);
	});

	test('decision status vocabulary preserved exactly (§10.2)', () => {
		assert.deepStrictEqual([...DECISION_STATUSES], ['accepted', 'rejected', 'superseded']);
	});

	test('baseline constraints: unique identity per node type plus project scoping (§6.5/§6.6)', () => {
		const statements = graphConstraintStatements();
		assert.ok(statements.length >= GRAPH_NODE_TYPES.length);
		assert.ok(statements.every(statement => statement.includes('IF NOT EXISTS')));
		assert.ok(statements.some(statement => statement.includes('project_projectId_unique')));
	});
});
