/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * PPB relational read API (P1-T14 read half of IF-11, spec §9.1/§9.5).
 *
 * Project-scoped reads over the stored memories — the relational counterpart to the graph
 * repository. The schema is never queried from outside the storage layer (§6.7/§9.5), and every
 * query carries an explicit `project_id` predicate (§6.6/§6.12).
 */

import type { MemoryCategory, MemoryVersionState } from '../ontology.js';

/** Minimal query surface — satisfied by a `pg.Client`. */
export interface ReadQueryable {
	query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MemoryRecord {
	readonly id: string;
	readonly projectId: string;
	readonly category: MemoryCategory;
	readonly content: string;
	readonly confidence: number;
	readonly importance: number;
	readonly sourceRef: string | undefined;
	readonly author: string | undefined;
	readonly extractedAt: string;
	readonly status: MemoryVersionState;
	readonly accessCount: number;
}

export interface FindFactsOptions {
	readonly category?: MemoryCategory;
	readonly status?: MemoryVersionState;
	/** PLACEHOLDER bound pending real measurement (spec §26/§32). */
	readonly limit?: number;
}

const DEFAULT_LIMIT = 100;

export class ReadError extends Error {
	constructor(message: string, readonly code: 'invalid-project' | 'invalid-option') {
		super(message);
		this.name = 'ReadError';
	}
}

function requireProject(projectId: string | undefined): string {
	if (typeof projectId !== 'string' || projectId.trim().length === 0) {
		throw new ReadError('a non-empty projectId is required (spec §6.6/§6.12)', 'invalid-project');
	}
	return projectId;
}

const SELECT_COLUMNS =
	'id, project_id, category, content, confidence, importance, source_ref, author, extracted_at, status, access_count';

function toMemory(row: Record<string, unknown>): MemoryRecord {
	return {
		id: String(row.id),
		projectId: String(row.project_id),
		category: String(row.category) as MemoryCategory,
		content: String(row.content),
		confidence: Number(row.confidence),
		importance: Number(row.importance),
		sourceRef: row.source_ref === null || row.source_ref === undefined ? undefined : String(row.source_ref),
		author: row.author === null || row.author === undefined ? undefined : String(row.author),
		extractedAt: new Date(String(row.extracted_at)).toISOString(),
		status: String(row.status) as MemoryVersionState,
		accessCount: Number(row.access_count)
	};
}

/** Project-scoped candidate lookup over stored facts (§8.2/§12.2/§15). */
export async function findFacts(
	client: ReadQueryable,
	projectId: string,
	options: FindFactsOptions = {}
): Promise<MemoryRecord[]> {
	const project = requireProject(projectId);
	const limit = options.limit ?? DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) {
		throw new ReadError('limit must be a positive integer', 'invalid-option');
	}
	const conditions = ['project_id = $1'];
	const params: unknown[] = [project];
	if (options.category !== undefined) {
		params.push(options.category);
		conditions.push(`category = $${params.length}`);
	}
	if (options.status !== undefined) {
		params.push(options.status);
		conditions.push(`status = $${params.length}`);
	}
	const result = await client.query(
		`SELECT ${SELECT_COLUMNS} FROM memories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`,
		params
	);
	return result.rows.map(toMemory);
}

/** Project-scoped single-fact lookup by id. */
export async function getFact(client: ReadQueryable, projectId: string, id: string): Promise<MemoryRecord | undefined> {
	const project = requireProject(projectId);
	const result = await client.query(
		`SELECT ${SELECT_COLUMNS} FROM memories WHERE project_id = $1 AND id = $2 LIMIT 1`,
		[project, id]
	);
	return result.rows.length > 0 ? toMemory(result.rows[0]) : undefined;
}