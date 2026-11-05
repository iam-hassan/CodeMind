/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** API contract / drift tests for the published Part 1 surface (P1-T14, spec §18, §23.13). */

import assert from 'assert';
import { PPB_API_VERSION, PPB_INTERFACES, describePpbApi } from '../../ppb/api.js';
import type { GraphRepository } from '../../ppb/graph/graphRepo.js';
import { reason } from '../../ppb/reasoning/reasoner.js';
import { WEIGHT_PROFILE_VERSION } from '../../ppb/retrieval/weightProfile.js';
import { PPB_MIGRATIONS } from '../../ppb/storage/migrations/index.js';

const REQUIRED_IDS = Array.from({ length: 12 }, (_, index) => `IF-${index + 1}`);

function decisionRow(): Record<string, unknown> {
	return { id: 'd1', project_id: 'projectA', decision: 'Use Clerk for authentication', reason: 'DX', alternatives: 'Auth.js', status: 'accepted', author: 'alice', source_ref: 'projectA:d1', decided_at: '2026-01-01T00:00:00.000Z', superseded_by: null };
}

class DecisionOnlyClient {
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		if (text.includes('FROM decisions') && String(params[0]) === 'projectA') {
			return { rows: [decisionRow()] };
		}
		return { rows: [] };
	}
}

const graph = { history: async () => ({ chain: [], rejected: [] }) } as unknown as GraphRepository;

suite('PPB API contract (P1-T14, spec §18)', () => {

	test('the published surface declares all twelve interfaces with producer/consumer/purpose', () => {
		const api = describePpbApi();
		assert.strictEqual(api.version, PPB_API_VERSION);
		assert.strictEqual(api.interfaces.length, 12);
		for (const id of REQUIRED_IDS) {
			const descriptor = api.interfaces.find(entry => entry.id === id);
			assert.ok(descriptor, `missing ${id}`);
			assert.ok(descriptor.producer.length > 0, `${id} producer`);
			assert.ok(descriptor.consumer.length > 0, `${id} consumer`);
			assert.ok(descriptor.purpose.length > 0, `${id} purpose`);
			assert.ok(['implemented', 'published'].includes(descriptor.status), `${id} status`);
		}
	});

	test('IF-11 publishes the schema version and the weight profile version (§16.7/§18)', () => {
		const api = describePpbApi();
		assert.strictEqual(api.weightProfileVersion, WEIGHT_PROFILE_VERSION);
		assert.strictEqual(api.schemaVersion, PPB_MIGRATIONS[PPB_MIGRATIONS.length - 1].version);
		const if11 = PPB_INTERFACES.find(entry => entry.id === 'IF-11');
		assert.ok(if11?.payload.includes('weightProfile'));
	});

	test('IF-8/IF-9 payloads match what the reasoner consumes and produces (§17/§23.13)', async () => {
		const if8 = PPB_INTERFACES.find(entry => entry.id === 'IF-8');
		const if9 = PPB_INTERFACES.find(entry => entry.id === 'IF-9');
		assert.deepStrictEqual(if8?.payload, ['projectId', 'question']);

		const answer = await reason({ read: new DecisionOnlyClient(), graph }, { projectId: 'projectA', question: 'Why did we choose Clerk for authentication?' });
		for (const field of if9?.payload ?? []) {
			assert.ok(field in answer, `IF-9 answer missing documented field ${field}`);
		}
	});

	test('the constructor-retriever profile stays versioned and adjustable through the descriptor (§16.7)', () => {
		const if11 = PPB_INTERFACES.find(entry => entry.id === 'IF-11');
		assert.ok(if11?.payload.includes('repositories'));
		assert.ok(PPB_INTERFACES.every(entry => entry.id.length > 0));
	});
});