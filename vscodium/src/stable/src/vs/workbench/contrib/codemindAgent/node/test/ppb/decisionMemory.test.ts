/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for decision and dated-event memory (P1-T12, spec §10/§11).
 * The fake keeps an in-memory decisions table so insert → read → supersede behave realistically.
 */

import assert from 'assert';
import {
	DecisionMemoryError,
	createDecision,
	listEvents,
	rejectedTechnologyId,
	recordEvent,
	supersedeDecision
} from '../../ppb/decisions/decisionMemory.js';

class FakeClient {
	readonly calls: Array<{ text: string; params: readonly unknown[] }> = [];
	private readonly _decisions = new Map<string, Record<string, unknown>>();
	private readonly _outbox: string[] = [];

	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, params });
		if (text.includes('INSERT INTO decisions')) {
			this._decisions.set(String(params[0]), {
				id: params[0], project_id: params[1], decision: params[2], reason: params[3], alternatives: params[4],
				status: 'accepted', author: params[5], source_ref: params[6], decided_at: params[7], superseded_by: null
			});
			return { rows: [] };
		}
		if (text.includes('INSERT INTO neo4j_outbox')) {
			this._outbox.push(String(params[1]));
			return { rows: [] };
		}
		if (text.includes("SET status = 'superseded'")) {
			const row = this._decisions.get(String(params[1]));
			if (row) {
				row.status = 'superseded';
				row.superseded_by = params[2];
			}
			return { rows: [] };
		}
		if (text.includes('SELECT') && text.includes('FROM decisions WHERE project_id = $1 AND id = $2')) {
			const row = this._decisions.get(String(params[1]));
			return { rows: row ? [row] : [] };
		}
		if (text.includes('SELECT') && text.includes('FROM events')) {
			return { rows: [{ id: 'ev-1', project_id: 'projectA', event_type: 'added', description: 'Clerk added', occurred_at: '2026-01-01T00:00:00.000Z', source_ref: null }] };
		}
		return { rows: [] };
	}

	outboxEvents(): string[] {
		return [...this._outbox];
	}
}

function options() {
	let counter = 0;
	return { now: () => new Date('2026-01-01T00:00:00.000Z'), newId: () => `id-${++counter}` };
}

suite('PPB decision and event memory (spec §10/§11)', () => {

	test('createDecision persists an accepted decision and queues its projection', async () => {
		const client = new FakeClient();
		const record = await createDecision(client, {
			projectId: 'projectA', decision: 'Use Clerk', reason: 'DX', alternatives: 'Auth.js', rejectedAlternatives: ['Auth.js']
		}, options());
		assert.strictEqual(record.status, 'accepted');
		assert.strictEqual(record.decision, 'Use Clerk');
		assert.strictEqual(record.reason, 'DX');
		assert.deepStrictEqual(client.outboxEvents(), ['decision_upsert', 'decision_rejected']);
	});

	test('rejected alternative ids are deterministic and slugged (§10.3)', () => {
		assert.strictEqual(rejectedTechnologyId('projectA', 'Auth.js'), 'ppb:tech:projectA:auth-js');
		assert.strictEqual(rejectedTechnologyId('projectA', 'Auth.js'), rejectedTechnologyId('projectA', 'Auth.js'));
	});

	test('supersedeDecision marks the previous decision superseded and links the replacement (§10.4)', async () => {
		const client = new FakeClient();
		const opts = options();
		const first = await createDecision(client, { projectId: 'projectA', decision: 'Use Clerk' }, opts);
		const result = await supersedeDecision(client, 'projectA', first.id, { decision: 'Migrate to Better Auth' }, opts);
		assert.strictEqual(result.next.decision, 'Migrate to Better Auth');
		assert.strictEqual(result.next.status, 'accepted');
		assert.strictEqual(result.previous.decision, 'Use Clerk');
		assert.strictEqual(result.previous.status, 'superseded');
		assert.strictEqual(result.previous.supersededBy, result.next.id);
		assert.ok(client.outboxEvents().includes('decision_supersedes'));
	});

	test('supersedeDecision rejects an unknown previous decision', async () => {
		const client = new FakeClient();
		await assert.rejects(
			() => supersedeDecision(client, 'projectA', 'missing', { decision: 'x' }, options()),
			(error: unknown) => error instanceof DecisionMemoryError && error.code === 'not-found'
		);
	});

	test('recordEvent persists a dated event and queues its projection (§11)', async () => {
		const client = new FakeClient();
		const event = await recordEvent(client, { projectId: 'projectA', eventType: 'added', description: 'Clerk added' }, options());
		assert.strictEqual(event.eventType, 'added');
		assert.strictEqual(event.occurredAt, '2026-01-01T00:00:00.000Z');
		assert.deepStrictEqual(client.outboxEvents(), ['event_upsert']);
	});

	test('listEvents is project-scoped, chronological, and bounded (§11.3)', async () => {
		const client = new FakeClient();
		const events = await listEvents(client, 'projectA', 25);
		assert.strictEqual(events.length, 1);
		const call = client.calls[0];
		assert.ok(call.text.includes('WHERE project_id = $1'));
		assert.ok(call.text.includes('ORDER BY occurred_at ASC'));
		assert.ok(call.text.includes('LIMIT 25'));
	});

	test('validation rejects a missing project or empty decision/description (§6.12)', async () => {
		const client = new FakeClient();
		await assert.rejects(() => createDecision(client, { projectId: '', decision: 'x' }), (error: unknown) => error instanceof DecisionMemoryError && error.code === 'invalid-project');
		await assert.rejects(() => createDecision(client, { projectId: 'projectA', decision: '   ' }), (error: unknown) => error instanceof DecisionMemoryError && error.code === 'invalid-input');
		await assert.rejects(() => recordEvent(client, { projectId: 'projectA', eventType: 'added', description: '' }), (error: unknown) => error instanceof DecisionMemoryError && error.code === 'invalid-input');
		assert.strictEqual(client.calls.length, 0);
	});
});