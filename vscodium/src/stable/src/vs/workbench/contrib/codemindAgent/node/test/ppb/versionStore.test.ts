/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for memory versioning (P1-T11, spec §13). */

import assert from 'assert';
import type { ExtractedFact } from '../../ppb/extraction/types.js';
import { applyConfirmation, archiveMemory, supersedeMemory } from '../../ppb/versioning/versionStore.js';

interface MemRow { id: string; project_id: string; category: string; content: string; confidence: number; importance: number; source_ref: string | null; author: string | null; extracted_at: string; status: string; access_count: number; superseded_by: string | null; }

class FakeClient {
	readonly calls: Array<{ text: string; params: readonly unknown[] }> = [];
	readonly memories = new Map<string, MemRow>();
	readonly versions: Array<readonly unknown[]> = [];
	readonly outbox: string[] = [];
	seed(overrides: Partial<MemRow> & { id: string }): void {
		this.memories.set(overrides.id, { id: overrides.id, project_id: overrides.project_id ?? 'projectA', category: overrides.category ?? 'technology_stack', content: overrides.content ?? 'We use MongoDB', confidence: 0.9, importance: 0.8, source_ref: null, author: null, extracted_at: '2026-01-01T00:00:00.000Z', status: overrides.status ?? 'active', access_count: 0, superseded_by: overrides.superseded_by ?? null });
	}
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, params });
		if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) { return { rows: [] }; }
		if (text.includes('FROM memories WHERE project_id = $1 AND id = $2')) {
			const memory = this.memories.get(String(params[1]));
			return { rows: memory ? [memory as unknown as Record<string, unknown>] : [] };
		}
		if (text.includes('SELECT id FROM memories WHERE project_id = $1 AND category')) {
			return { rows: [] }; // always a new fact for these tests
		}
		if (text.includes('INSERT INTO memories')) {
			this.seed({ id: String(params[0]), project_id: String(params[1]), category: String(params[2]), content: String(params[3]) });
			return { rows: [] };
		}
		if (text.includes('UPDATE memories SET status')) {
			const memory = this.memories.get(String(params[1]));
			if (memory) {
				memory.status = String(params[2]);
				if (params[3]) { memory.superseded_by = String(params[3]); }
			}
			return { rows: memory ? [{ id: memory.id }] : [] };
		}
		if (text.includes('INSERT INTO memory_versions')) { this.versions.push(params); return { rows: [] }; }
		if (text.includes('INSERT INTO neo4j_outbox')) { this.outbox.push(String(params[1])); return { rows: [] }; }
		return { rows: [] };
	}
}

function incoming(): ExtractedFact {
	return { id: 'in-1', category: 'technology_stack', content: 'We switched to PostgreSQL', confidence: 0.9, importance: 0.8, sourceRef: 'projectA:t2', author: 'user', extractedAt: '2026-01-02T00:00:00.000Z' };
}

suite('PPB memory versioning (spec §13)', () => {

	test('archiveMemory moves Active → Archived and records the audit row (§13.2)', async () => {
		const client = new FakeClient();
		client.seed({ id: 'm1' });
		const updated = await archiveMemory(client, 'projectA', 'm1');
		assert.strictEqual(updated, 1);
		assert.strictEqual(client.memories.get('m1')!.status, 'archived');
		assert.deepStrictEqual(client.versions[0][2], 'active');
		assert.deepStrictEqual(client.versions[0][3], 'archived');
		assert.strictEqual(client.outbox.length, 1, 'graph status projection queued');
	});

	test('supersedeMemory links the replacement (§13.7)', async () => {
		const client = new FakeClient();
		client.seed({ id: 'm1' });
		await supersedeMemory(client, 'projectA', 'm1', 'm2');
		assert.strictEqual(client.memories.get('m1')!.status, 'superseded');
		assert.strictEqual(client.memories.get('m1')!.superseded_by, 'm2');
	});

	test('accept_migration archives the existing memory and activates the incoming fact (§13.2)', async () => {
		const client = new FakeClient();
		client.seed({ id: 'm1' });
		const result = await applyConfirmation(client, 'projectA', 'm1', incoming(), 'accept_migration');
		assert.strictEqual(result.applied, true);
		assert.ok(result.incomingId);
		assert.strictEqual(client.memories.get('m1')!.status, 'archived');
		assert.strictEqual(client.memories.get('m1')!.superseded_by, result.incomingId);
		assert.strictEqual(client.memories.get(result.incomingId!)!.status, 'active');
		assert.strictEqual(result.activeId, result.incomingId);
	});

	test('keep_existing and discard_incoming leave storage unchanged (§13.3)', async () => {
		for (const outcome of ['keep_existing', 'discard_incoming'] as const) {
			const client = new FakeClient();
			client.seed({ id: 'm1' });
			const result = await applyConfirmation(client, 'projectA', 'm1', incoming(), outcome);
			assert.strictEqual(result.applied, false);
			assert.strictEqual(result.activeId, 'm1');
			assert.strictEqual(client.memories.get('m1')!.status, 'active');
			assert.ok(!client.calls.some(call => call.text.includes('UPDATE memories')),
				'no transition on keep/discard');
		}
	});

	test('an unknown outcome is rejected (§12.10)', async () => {
		const client = new FakeClient();
		client.seed({ id: 'm1' });
		await assert.rejects(() => applyConfirmation(client, 'projectA', 'm1', incoming(), 'delete_it' as never));
	});

	test('no versioning code path issues a hard DELETE (§13.9)', async () => {
		const client = new FakeClient();
		client.seed({ id: 'm1' });
		await archiveMemory(client, 'projectA', 'm1');
		await applyConfirmation(client, 'projectA', 'm1', incoming(), 'accept_migration');
		assert.ok(!client.calls.some(call => /\bDELETE\b/.test(call.text)), 'never delete historical memory');
	});
});