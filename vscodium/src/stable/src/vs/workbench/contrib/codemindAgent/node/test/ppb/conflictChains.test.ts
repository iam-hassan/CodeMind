/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Conflict-detection edge cases (spec §6/§12/§13): chained migrations, two conflicting facts in
 * one message, restatement-is-not-a-conflict, concurrent writes and the abandoned-prompt path.
 * Fakes only — no live PostgreSQL/LLM.
 */

import assert from 'assert';
import { detectConflict, persistConflictReport, type ConflictReport } from '../../ppb/conflict/detector.js';
import type { ExtractedFact } from '../../ppb/extraction/types.js';
import type { MemoryCategory } from '../../ppb/ontology.js';
import type { MemoryRecord } from '../../ppb/storage/read.js';
import { applyConfirmation } from '../../ppb/versioning/versionStore.js';

interface MemRow { id: string; project_id: string; category: string; content: string; confidence: number; importance: number; source_ref: string | null; author: string | null; extracted_at: string; status: string; access_count: number; superseded_by: string | null; }

class FakeStore {
	readonly memories = new Map<string, MemRow>();
	readonly reports: Array<Record<string, unknown>> = [];
	readonly versions: Array<readonly unknown[]> = [];
	readonly outbox: string[] = [];

	seed(overrides: Partial<MemRow> & { id: string }): void {
		this.memories.set(overrides.id, {
			id: overrides.id,
			project_id: overrides.project_id ?? 'projectA',
			category: overrides.category ?? 'technology_stack',
			content: overrides.content ?? 'We use MongoDB',
			confidence: 0.9,
			importance: 0.8,
			source_ref: null,
			author: 'user',
			extracted_at: '2026-01-01T00:00:00.000Z',
			status: overrides.status ?? 'active',
			access_count: 0,
			superseded_by: null
		});
	}

	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) {
			return { rows: [] };
		}
		if (text.includes('INSERT INTO conflict_reports')) {
			this.reports.push({
				id: params[0], project_id: params[1], existing_memory_id: params[2],
				category: params[4], severity: params[5], status: 'pending'
			});
			return { rows: [] };
		}
		if (text.includes('FROM memories WHERE project_id = $1 AND id = $2')) {
			const memory = this.memories.get(String(params[1]));
			return { rows: memory ? [memory as unknown as Record<string, unknown>] : [] };
		}
		if (text.includes('SELECT id FROM memories WHERE project_id = $1 AND category')) {
			return { rows: [] }; // every incoming fact is new
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
		if (text.includes('INSERT INTO memory_versions')) {
			this.versions.push(params);
			return { rows: [] };
		}
		if (text.includes('INSERT INTO neo4j_outbox')) {
			this.outbox.push(String(params[1]));
			return { rows: [] };
		}
		return { rows: [] };
	}
}

function memory(store: FakeStore, id: string): MemoryRecord {
	const row = store.memories.get(id)!;
	return {
		id: row.id, projectId: row.project_id, category: row.category as MemoryCategory, content: row.content,
		confidence: row.confidence, importance: row.importance, sourceRef: row.source_ref ?? undefined,
		author: row.author ?? undefined, extractedAt: row.extracted_at, status: row.status as MemoryRecord['status'],
		accessCount: row.access_count
	};
}

function incoming(content: string, id = `in-${content.length}`): ExtractedFact {
	return {
		id, category: 'technology_stack', content, confidence: 0.9, importance: 0.8,
		sourceRef: `projectA:${id}`, author: 'user', extractedAt: '2026-01-02T00:00:00.000Z'
	};
}

function report(store: FakeStore, existingId: string, content: string): ConflictReport {
	const report = detectConflict(memory(store, existingId), incoming(content));
	assert.ok(report, `expected a conflict for: ${content}`);
	return report;
}

suite('PPB conflict edges (spec §6/§12/§13)', () => {

	test('a chain A→B→C archives each previous memory and keeps one active head', async () => {
		const store = new FakeStore();
		store.seed({ id: 'm1', content: 'We use MongoDB' });

		const firstReport = report(store, 'm1', 'We switched from MongoDB to PostgreSQL');
		const first = await applyConfirmation(store, 'projectA', 'm1', incoming('We switched from MongoDB to PostgreSQL'), 'accept_migration');
		assert.strictEqual(first.applied, true);
		assert.strictEqual(store.memories.get('m1')!.status, 'archived');

		const secondReport = report(store, first.incomingId!, 'We migrated from PostgreSQL to MySQL');
		assert.strictEqual(secondReport.existing.id, first.incomingId);
		const second = await applyConfirmation(store, 'projectA', first.incomingId!, incoming('We migrated from PostgreSQL to MySQL'), 'accept_migration');

		assert.strictEqual(store.memories.get(first.incomingId!)!.status, 'archived');
		assert.strictEqual(store.memories.get(second.incomingId!)!.status, 'active');
		assert.strictEqual(store.memories.get('m1')!.status, 'archived');
		assert.strictEqual(store.memories.get('m1')!.superseded_by, first.incomingId);
		assert.strictEqual(store.memories.get(first.incomingId!)!.superseded_by, second.incomingId);
		assert.strictEqual(firstReport.severity, 'genuine');
		assert.strictEqual(secondReport.severity, 'genuine');
	});

	test('two conflicting facts in one message produce two independent pending reports', async () => {
		const store = new FakeStore();
		store.seed({ id: 'm1', content: 'We use MongoDB' });

		const reports = [
			report(store, 'm1', 'We switched from MongoDB to PostgreSQL'),
			report(store, 'm1', 'We migrated from MongoDB to MySQL')
		];
		const ids = await Promise.all(reports.map(entry => persistConflictReport(store, entry)));

		assert.strictEqual(new Set(ids).size, 2, 'each report gets its own id');
		assert.strictEqual(store.reports.length, 2);
		assert.ok(store.reports.every(entry => entry.status === 'pending'));
	});

	test('restating the same fact is a duplicate, never a conflict', () => {
		const store = new FakeStore();
		store.seed({ id: 'm1', content: 'We use MongoDB' });
		assert.strictEqual(detectConflict(memory(store, 'm1'), incoming('  we USE mongodb  ')), undefined);
	});

	test('concurrent conflicting writes do not lose or corrupt either report', async () => {
		const store = new FakeStore();
		store.seed({ id: 'm1', content: 'We use MongoDB' });
		const first = report(store, 'm1', 'We switched from MongoDB to PostgreSQL');
		const second = report(store, 'm1', 'We migrated from MongoDB to MySQL');

		await Promise.all([persistConflictReport(store, first), persistConflictReport(store, second)]);

		assert.strictEqual(store.reports.length, 2);
		assert.deepStrictEqual(store.reports.map(entry => entry.existing_memory_id), ['m1', 'm1']);
		assert.strictEqual(store.memories.get('m1')!.status, 'active', 'pending reports never mutate storage');
	});

	test('an abandoned prompt leaves the report pending (§12.10)', async () => {
		const store = new FakeStore();
		store.seed({ id: 'm1', content: 'We use MongoDB' });
		await persistConflictReport(store, report(store, 'm1', 'We switched from MongoDB to PostgreSQL'));

		// No applyConfirmation call — the user never answered.
		assert.strictEqual(store.reports[0].status, 'pending');
		assert.strictEqual(store.memories.get('m1')!.status, 'active');
		assert.strictEqual(store.versions.length, 0, 'nothing was versioned');
	});
});
