/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for the long-term reasoning layer (P1-T13, spec §17, IF-8 → IF-9). */

import assert from 'assert';
import type { EmbeddingClient } from '../../ppb/embeddings/embedder.js';
import type { GraphNode, GraphRepository } from '../../ppb/graph/graphRepo.js';
import { ReasoningError, classifyQuestion, extractKeywords, planReasoning, reason, REASONING_INSUFFICIENT_MESSAGE } from '../../ppb/reasoning/reasoner.js';

const PROJECT_A = 'projectA';
const PROJECT_B = 'projectB';

function memory(id: string, projectId: string, category: string, content: string, status: string, extractedAt: string): Record<string, unknown> {
	return { id, project_id: projectId, category, content, confidence: 0.9, importance: 0.7, source_ref: `${projectId}:${id}`, author: 'dev', extracted_at: extractedAt, status, access_count: 0 };
}

function decisionRow(id: string, projectId: string, decision: string, reason: string | null, alternatives: string | null, status: string, author: string, decidedAt: string): Record<string, unknown> {
	return { id, project_id: projectId, decision, reason, alternatives, status, author, source_ref: `${projectId}:${id}`, decided_at: decidedAt, superseded_by: null };
}

function eventRow(id: string, projectId: string, eventType: string, description: string, occurredAt: string): Record<string, unknown> {
	return { id, project_id: projectId, event_type: eventType, description, occurred_at: occurredAt, source_ref: `${projectId}:${id}` };
}

/** The Clerk → Auth.js rejection → Better Auth migration → AWS deployment fixture (§6.10/§11.2). */
const decisions = [
	decisionRow('d1', PROJECT_A, 'Use Clerk for authentication', 'Best developer experience and prebuilt components', 'Auth.js', 'superseded', 'alice', '2026-01-01T00:00:00.000Z'),
	decisionRow('d2', PROJECT_A, 'Migrate to Better Auth', 'Lower cost and self-hosting', 'Clerk', 'accepted', 'bob', '2026-01-24T00:00:00.000Z'),
	decisionRow('d3', PROJECT_A, 'Reject JWT for session management', 'Prefer server-side sessions', 'JWT', 'rejected', 'carol', '2026-01-05T00:00:00.000Z'),
	decisionRow('dB', PROJECT_B, 'Use Clerk for authentication', 'cross-project decoy', 'Auth.js', 'accepted', 'mallory', '2026-01-02T00:00:00.000Z')
];

const events = [
	eventRow('e1', PROJECT_A, 'added', 'Clerk added to auth-service', '2026-01-01T00:00:00.000Z'),
	eventRow('e2', PROJECT_A, 'rejected', 'Auth.js rejected after evaluation', '2026-01-10T00:00:00.000Z'),
	eventRow('e3', PROJECT_A, 'migrated', 'Migrated authentication from Clerk to Better Auth', '2026-01-24T00:00:00.000Z'),
	eventRow('e4', PROJECT_A, 'changed', 'Deployment moved to AWS', '2026-01-31T00:00:00.000Z'),
	eventRow('e5', PROJECT_A, 'migrated', 'Migrated database from MongoDB to PostgreSQL', '2026-02-05T00:00:00.000Z'),
	eventRow('eB', PROJECT_B, 'changed', 'Deployment moved to GCP', '2026-01-15T00:00:00.000Z')
];

const memories = [
	memory('f1', PROJECT_A, 'technology_stack', 'The project uses PostgreSQL as its primary database', 'active', '2026-01-15T00:00:00.000Z'),
	memory('f2', PROJECT_A, 'technology_stack', 'The project uses Better Auth for authentication', 'active', '2026-01-24T00:00:00.000Z'),
	memory('f3', PROJECT_A, 'technology_stack', 'The project previously used Clerk for authentication', 'archived', '2026-01-01T00:00:00.000Z'),
	memory('fB', PROJECT_B, 'technology_stack', 'Project B uses MongoDB', 'active', '2026-01-15T00:00:00.000Z')
];

interface Data {
	readonly decisions: readonly Record<string, unknown>[];
	readonly events: readonly Record<string, unknown>[];
	readonly memories: readonly Record<string, unknown>[];
	readonly vectors?: readonly Record<string, unknown>[];
}

class FakeReadClient {
	constructor(private readonly _data: Data = { decisions, events, memories }) { }

	async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
		if (text.includes('<=>')) {
			const projectId = String(params[1]);
			return { rows: (this._data.vectors ?? []).filter(row => row.project_id === projectId) };
		}
		if (text.includes('FROM decisions')) {
			const projectId = String(params[0]);
			let rows = this._data.decisions.filter(row => row.project_id === projectId);
			if (text.includes('AND status =')) {
				rows = rows.filter(row => row.status === String(params[1]));
			}
			return { rows };
		}
		if (text.includes('FROM events')) {
			const projectId = String(params[0]);
			return { rows: this._data.events.filter(row => row.project_id === projectId).slice().sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at))) };
		}
		if (text.includes('FROM memories WHERE project_id = $1 AND id = $2')) {
			const projectId = String(params[0]);
			const id = String(params[1]);
			const rows = this._data.memories.filter(row => row.project_id === projectId && row.id === id);
			return { rows };
		}
		if (text.includes('FROM memories')) {
			const projectId = String(params[0]);
			let rows = this._data.memories.filter(row => row.project_id === projectId);
			if (text.includes('AND status =')) {
				rows = rows.filter(row => row.status === String(params[1]));
			}
			return { rows };
		}
		return { rows: [] };
	}
}

function gnode(id: string, props: Record<string, unknown>): GraphNode {
	return { id, projectId: PROJECT_A, type: 'Decision', properties: { id, projectId: PROJECT_A, ...props } };
}

function graph(): GraphRepository {
	const d1 = gnode('d1', { decision: 'Use Clerk for authentication', reason: 'Best developer experience and prebuilt components', alternatives: 'Auth.js', status: 'superseded', date: '2026-01-01T00:00:00.000Z' });
	const d2 = gnode('d2', { decision: 'Migrate to Better Auth', reason: 'Lower cost and self-hosting', alternatives: 'Clerk', status: 'accepted', date: '2026-01-24T00:00:00.000Z' });
	const authJs: GraphNode = { id: 'tech-authjs', projectId: PROJECT_A, type: 'Technology', properties: { id: 'tech-authjs', projectId: PROJECT_A, name: 'Auth.js' } };
	const histories: Record<string, { chain: GraphNode[]; rejected: GraphNode[] }> = {
		d1: { chain: [d1, d2], rejected: [authJs] },
		d2: { chain: [d2, d1], rejected: [] },
		d3: { chain: [gnode('d3', { decision: 'Reject JWT for session management', status: 'rejected' })], rejected: [] }
	};
	return { history: async (_projectId: string, id: string) => histories[id] ?? { chain: [], rejected: [] } } as unknown as GraphRepository;
}

function deps(overrides: Partial<{ read: FakeReadClient; embedding: EmbeddingClient }> = {}) {
	return { read: overrides.read ?? new FakeReadClient(), graph: graph(), embedding: overrides.embedding };
}

suite('PPB long-term reasoning (spec §17)', () => {

	test('classification covers the five required question classes (§17.2/§17.3)', () => {
		assert.strictEqual(classifyQuestion('Why did we choose Clerk for authentication?'), 'causal');
		assert.strictEqual(classifyQuestion('What database are we currently using?'), 'current-state');
		assert.strictEqual(classifyQuestion('Who suggested JWT and when was it rejected?'), 'rejected-alternative');
		assert.strictEqual(classifyQuestion('What authentication libraries were evaluated but not selected?'), 'rejected-alternative');
		assert.strictEqual(classifyQuestion('When did we migrate from MongoDB to PostgreSQL?'), 'migration-timing');
		assert.strictEqual(classifyQuestion('Show all deployment decisions made since the project started.'), 'chronological-listing');
	});

	test('keyword extraction drops question/stop words but keeps topics (§17.3)', () => {
		assert.deepStrictEqual(extractKeywords('What database are we currently using?'), ['database']);
		assert.ok(extractKeywords('Why did we choose Clerk for authentication?').includes('clerk'));
		assert.ok(extractKeywords('Why did we choose Clerk for authentication?').includes('authentication'));
	});

	test('anchor 1 — current-state: "What database are we currently using?" (§17.2)', async () => {
		const answer = await reason(deps(), { projectId: PROJECT_A, question: 'What database are we currently using?' });
		assert.strictEqual(answer.status, 'answered');
		assert.strictEqual(answer.plan.questionType, 'current-state');
		assert.ok(answer.citations.some(citation => citation.content.includes('PostgreSQL')), 'PostgreSQL surfaced');
		assert.ok(answer.answer.includes('PostgreSQL'));
		assert.ok(!answer.citations.some(citation => citation.id === 'f3'), 'archived fact excluded from current state');
	});

	test('anchor 2 — causal: "Why did we choose Clerk for authentication?" (§17.2)', async () => {
		const answer = await reason(deps(), { projectId: PROJECT_A, question: 'Why did we choose Clerk for authentication?' });
		assert.strictEqual(answer.plan.questionType, 'causal');
		const clerk = answer.citations.find(citation => citation.id === 'd1');
		assert.ok(clerk, 'the Clerk decision is cited');
		assert.strictEqual(clerk.reason, 'Best developer experience and prebuilt components');
		assert.ok(answer.answer.includes('developer experience'), 'the recorded reason grounds the answer');
	});

	test('anchor 3 — rejected-alternative: "What authentication libraries were evaluated but not selected?" (§17.2)', async () => {
		const answer = await reason(deps(), { projectId: PROJECT_A, question: 'What authentication libraries were evaluated but not selected?' });
		assert.strictEqual(answer.plan.questionType, 'rejected-alternative');
		assert.ok(answer.citations.some(citation => citation.id === 'd1'));
		assert.ok(answer.answer.includes('Auth.js'), 'the rejected alternative is named from the REJECTED graph edge');
	});

	test('anchor 4 — rejected-alternative: "Who suggested JWT and when was it rejected?" (§17.2)', async () => {
		const answer = await reason(deps(), { projectId: PROJECT_A, question: 'Who suggested JWT and when was it rejected?' });
		assert.strictEqual(answer.plan.questionType, 'rejected-alternative');
		const jwt = answer.citations.find(citation => citation.id === 'd3');
		assert.ok(jwt, 'the JWT rejection decision is cited');
		assert.strictEqual(jwt.occurredAt, '2026-01-05T00:00:00.000Z', 'the date is preserved for the "when"');
	});

	test('anchor 5 — migration-timing: "When did we migrate from MongoDB to PostgreSQL?" (§17.2)', async () => {
		const answer = await reason(deps(), { projectId: PROJECT_A, question: 'When did we migrate from MongoDB to PostgreSQL?' });
		assert.strictEqual(answer.plan.questionType, 'migration-timing');
		const migration = answer.citations.find(citation => citation.id === 'e5');
		assert.ok(migration, 'the migration event is cited');
		assert.strictEqual(migration.occurredAt, '2026-02-05T00:00:00.000Z');
		assert.ok(answer.answer.includes('2026-02-05'));
	});

	test('anchor 6 — chronological-listing: "Show all deployment decisions made since the project started." (§17.2)', async () => {
		const answer = await reason(deps(), { projectId: PROJECT_A, question: 'Show all deployment decisions made since the project started.' });
		assert.strictEqual(answer.plan.questionType, 'chronological-listing');
		assert.ok(answer.citations.some(citation => citation.id === 'e4'), 'the AWS deployment event is cited');
		assert.ok(answer.answer.includes('AWS'));
	});

	test('insufficient evidence yields the defined response, never a fabricated answer (§17.9/§24)', async () => {
		const answer = await reason(deps(), { projectId: PROJECT_A, question: 'Why did we choose Stripe for payments?' });
		assert.strictEqual(answer.status, 'insufficient-evidence');
		assert.strictEqual(answer.answer, REASONING_INSUFFICIENT_MESSAGE);
		assert.deepStrictEqual(answer.citations, []);
	});

	test('every cited record is traceable and the sources line lists them (§17.7)', async () => {
		const answer = await reason(deps(), { projectId: PROJECT_A, question: 'Why did we choose Clerk for authentication?' });
		for (const citation of answer.citations) {
			assert.ok(['fact', 'decision', 'event'].includes(citation.sourceType));
			assert.ok(citation.id.length > 0);
			assert.ok(answer.answer.includes(citation.id), `source ${citation.id} listed in the answer`);
		}
	});

	test('reasoning is project-scoped — no cross-project leakage (§17.8/§24)', async () => {
		const answer = await reason(deps(), { projectId: PROJECT_A, question: 'Who suggested JWT and when was it rejected?' });
		assert.ok(!answer.citations.some(citation => citation.id.endsWith('B')), 'Project B records never surface');
		const forB = await reason(deps(), { projectId: PROJECT_B, question: 'Show all deployment decisions made since the project started.' });
		assert.ok(forB.citations.every(citation => citation.id === 'eB' || citation.id === 'dB'), 'Project B only sees its own records');
	});

	test('an invalid projectId is rejected outright (§17.8/§24)', async () => {
		await assert.rejects(() => reason(deps(), { projectId: '', question: 'Why did we choose Clerk?' }), (error: unknown) => error instanceof ReasoningError);
	});

	test('a vector lookup enriches evidence when an embedding client is available (§17.4)', async () => {
		const vectors = [{ owner_id: 'f1', owner_kind: 'fact', similarity: 0.8, project_id: PROJECT_A }];
		const read = new FakeReadClient({ decisions, events, memories, vectors });
		const embedding: EmbeddingClient = { model: 'test', dimension: 2, embed: async () => [[1, 0]] };
		const answer = await reason(deps({ read, embedding }), { projectId: PROJECT_A, question: 'Why did we choose Clerk for authentication?' });
		assert.ok(answer.citations.some(citation => citation.id === 'f1'), 'the vector match is folded into the evidence');
	});

	test('an embedding failure degrades to the other evidence paths rather than throwing (§24)', async () => {
		const embedding: EmbeddingClient = { model: 'x', dimension: 2, embed: async () => { throw new Error('down'); } };
		const answer = await reason(deps({ embedding }), { projectId: PROJECT_A, question: 'Why did we choose Clerk for authentication?' });
		assert.strictEqual(answer.status, 'answered');
	});

	test('planReasoning decomposes each class into the right sources (§17.3/§17.4)', () => {
		const current = planReasoning('What database are we currently using?');
		assert.strictEqual(current.factStatus, 'active');
		assert.strictEqual(current.decisionStatus, 'accepted');
		const listing = planReasoning('Show all deployment decisions made since the project started.');
		assert.strictEqual(listing.useVector, false);
		assert.strictEqual(listing.followHistory, false);
		const causal = planReasoning('Why did we choose Clerk?');
		assert.strictEqual(causal.followHistory, true);
	});
});