/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for conflict detection (P1-T10, spec §12), incl. the five preserved examples. */

import assert from 'assert';
import { detectConflict, persistConflictReport } from '../../ppb/conflict/detector.js';
import type { ExtractedFact } from '../../ppb/extraction/types.js';
import type { MemoryRecord } from '../../ppb/storage/read.js';
import type { MemoryCategory } from '../../ppb/ontology.js';

function memory(category: MemoryCategory, content: string): MemoryRecord {
	return { id: 'm1', projectId: 'projectA', category, content, confidence: 0.9, importance: 0.8, sourceRef: 'projectA:t1', author: 'user', extractedAt: '2026-01-01T00:00:00.000Z', status: 'active', accessCount: 0 };
}

function incoming(category: MemoryCategory, content: string): ExtractedFact {
	return { id: 'in-1', category, content, confidence: 0.9, importance: 0.8, sourceRef: 'projectA:t2', author: 'user', extractedAt: '2026-01-02T00:00:00.000Z' };
}

class FakeWriteClient {
	readonly calls: Array<{ text: string; params: readonly unknown[] }> = [];
	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.calls.push({ text, params });
		return { rows: [] };
	}
}

suite('PPB conflict detection (spec §12)', () => {

	test('the four preserved changes are conflicts; an added endpoint is not (§12.3 preserved)', () => {
		assert.ok(detectConflict(memory('technology_stack', 'We use MongoDB'), incoming('technology_stack', 'We switched from MongoDB to PostgreSQL')), 'database change');
		assert.ok(detectConflict(memory('architecture_patterns', 'We use Express'), incoming('architecture_patterns', 'We are migrating the framework to Fastify')), 'framework change');
		assert.ok(detectConflict(memory('technology_stack', 'We use Clerk for authentication'), incoming('technology_stack', 'We are moving from Clerk to Better Auth')), 'auth provider change');
		assert.ok(detectConflict(memory('technology_stack', 'Hosted on Vercel'), incoming('technology_stack', 'We moved deployment to AWS')), 'deployment change');
		assert.strictEqual(detectConflict(memory('architecture_patterns', 'The API follows REST'), incoming('architecture_patterns', 'We added a new endpoint for password reset')), undefined, 'added endpoint is not a conflict');
	});

	test('hypothetical phrasing is classified ambiguous, not genuine (§12.5)', () => {
		const report = detectConflict(memory('technology_stack', 'We use MongoDB'), incoming('technology_stack', 'What if we switched to PostgreSQL?'));
		assert.ok(report);
		assert.strictEqual(report!.severity, 'ambiguous');
	});

	test('a genuine migration is classified genuine (§12.4)', () => {
		const report = detectConflict(memory('technology_stack', 'We use MongoDB'), incoming('technology_stack', "We're switching from MongoDB to PostgreSQL"));
		assert.strictEqual(report?.severity, 'genuine');
	});

	test('cross-category pairs are never conflicts (§12.2)', () => {
		assert.strictEqual(detectConflict(memory('technology_stack', 'We use MongoDB'), incoming('constraints', 'We switched from MongoDB to PostgreSQL')), undefined);
	});

	test('the IF-3 report carries the existing memory, incoming fact, category and question (§12.6)', () => {
		const report = detectConflict(memory('technology_stack', 'We use MongoDB'), incoming('technology_stack', 'We switched to PostgreSQL'));
		assert.ok(report);
		assert.strictEqual(report!.existing.id, 'm1');
		assert.strictEqual(report!.incoming.id, 'in-1');
		assert.strictEqual(report!.category, 'technology_stack');
		assert.ok(report!.question.includes('MongoDB'));
	});

	test('persistConflictReport writes a pending conflict report (§12.6)', async () => {
		const client = new FakeWriteClient();
		const report = detectConflict(memory('technology_stack', 'We use MongoDB'), incoming('technology_stack', 'We switched to PostgreSQL'))!;
		const id = await persistConflictReport(client, report);
		assert.match(id, /^[0-9a-f-]{36}$/);
		const call = client.calls[0];
		assert.ok(call.text.includes('INSERT INTO conflict_reports'));
		assert.strictEqual(call.params[1], 'projectA');
		assert.strictEqual(call.params[2], 'm1');
		assert.ok(String(call.text).includes("'pending'"));
	});
});