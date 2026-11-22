/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * pgvector store (P1-T07, spec §9.2/§14.5/§14.6).
 *
 * Stores one embedding per stored fact/decision/event and offers project-scoped cosine similarity
 * search over the HNSW index created by migration `005_embedding_index`. Uses the `<=>` (cosine
 * distance) operator, matching that index's operator class.
 */

import type { WriteQueryable } from '../storage/write.js';
import { PPB_EMBEDDING_DIM } from '../config.js';
import { HNSW_MAX_DIM } from '../storage/migrations/005_embedding_index.js';

export type EmbeddingOwnerKind = 'fact' | 'decision' | 'event';

/**
 * F3/D-new: pgvector's `vector` HNSW index caps at 2000 dimensions, so a wider model has no usable
 * index. `halfvec` indexes up to 4000 dims, so when the pinned dim is wider we (a) build the
 * expression HNSW index in migration 007 and (b) order by the *identical* halfvec expression here so
 * the planner can use it. Below the limit we keep the plain `vector` operator from migration 005.
 */
const USE_HALFVEC = PPB_EMBEDDING_DIM > HNSW_MAX_DIM;
/** Cosine-distance expression that matches the migration-007 expression index when it exists. */
function distanceExpr(): string {
	return USE_HALFVEC
		? `e.embedding::halfvec(${PPB_EMBEDDING_DIM}) <=> $1::halfvec(${PPB_EMBEDDING_DIM})`
		: 'e.embedding <=> $1::vector';
}

export interface VectorMatch {
	readonly ownerId: string;
	readonly ownerKind: EmbeddingOwnerKind;
	/** Cosine similarity in [-1, 1] (1 = identical). */
	readonly similarity: number;
}

export class VectorStoreError extends Error {
	constructor(message: string, readonly code: 'invalid-project' | 'invalid-option') {
		super(message);
		this.name = 'VectorStoreError';
	}
}

/** Serialises a numeric vector to the pgvector text form `[a,b,c]`. */
function toVectorLiteral(embedding: readonly number[]): string {
	return `[${embedding.join(',')}]`;
}

/** Insert or replace the embedding for one stored memory (§14.5). */
export async function upsertEmbedding(
	client: WriteQueryable,
	input: { readonly ownerKind: EmbeddingOwnerKind; readonly ownerId: string; readonly embedding: readonly number[]; readonly embeddedText: string }
): Promise<void> {
	await client.query(
		`INSERT INTO embeddings (owner_kind, owner_id, embedding, embedded_text, embedded_at)
		 VALUES ($1, $2, $3::vector, $4, now())
		 ON CONFLICT (owner_kind, owner_id)
		 DO UPDATE SET embedding = EXCLUDED.embedding, embedded_text = EXCLUDED.embedded_text, embedded_at = now()`,
		[input.ownerKind, input.ownerId, toVectorLiteral(input.embedding), input.embeddedText]
	);
}

/**
 * Cosine similarity search over the stored **facts** of one project (§8.4 dedup, §15.2 retrieval).
 * Project scope is enforced by joining to `memories` — never search across projects.
 */
export async function searchFactsByVector(
	client: WriteQueryable,
	projectId: string,
	queryEmbedding: readonly number[],
	limit: number
): Promise<VectorMatch[]> {
	if (typeof projectId !== 'string' || projectId.trim().length === 0) {
		throw new VectorStoreError('a non-empty projectId is required (spec §6.6/§6.12)', 'invalid-project');
	}
	if (!Number.isInteger(limit) || limit < 1) {
		throw new VectorStoreError('limit must be a positive integer', 'invalid-option');
	}
	const result = await client.query(
		`SELECT e.owner_id AS owner_id, e.owner_kind AS owner_kind, 1 - (${distanceExpr()}) AS similarity
		 FROM embeddings e
		 JOIN memories m ON m.id = e.owner_id
		 WHERE m.project_id = $2 AND e.owner_kind = 'fact' AND m.status = 'active'
		 ORDER BY ${distanceExpr()}
		 LIMIT ${limit}`,
		[toVectorLiteral(queryEmbedding), projectId]
	);
	return result.rows.map(row => ({
		ownerId: String(row.owner_id),
		ownerKind: String(row.owner_kind) as EmbeddingOwnerKind,
		similarity: Number(row.similarity)
	}));
}

/**
 * Cosine similarity of one query embedding against a **specific set** of stored facts (D55).
 *
 * The hybrid retriever fuses three channels (vector seeds, lexical matches, graph neighbours).
 * Only the vector channel carried a cosine score, so a fact found only by the lexical or graph
 * channel reached ranking with no relevance score at all and was treated as 0 — indistinguishable
 * from "maximally dissimilar". That is correct only when embeddings are meaningful; with a
 * derived/stand-in embedding (D24) it silently demoted every exact-keyword hit beneath semantically
 * irrelevant ones. This helper gives such candidates their real cosine score so fusion compares
 * like with like. Project scope is enforced by joining to `memories`; ids that are absent from the
 * embeddings store are simply omitted from the result.
 */
export async function similaritiesForFacts(
	client: WriteQueryable,
	projectId: string,
	queryEmbedding: readonly number[],
	ownerIds: readonly string[]
): Promise<Map<string, number>> {
	const similarities = new Map<string, number>();
	if (ownerIds.length === 0) {
		return similarities;
	}
	if (typeof projectId !== 'string' || projectId.trim().length === 0) {
		throw new VectorStoreError('a non-empty projectId is required (spec §6.6/§6.12)', 'invalid-project');
	}
	const result = await client.query(
		`SELECT e.owner_id AS owner_id, 1 - (${distanceExpr()}) AS similarity
		 FROM embeddings e
		 JOIN memories m ON m.id = e.owner_id
		 WHERE m.project_id = $2 AND e.owner_kind = 'fact' AND e.owner_id = ANY($3::uuid[])`,
		[toVectorLiteral(queryEmbedding), projectId, [...ownerIds]]
	);
	for (const row of result.rows) {
		similarities.set(String(row.owner_id), Number(row.similarity));
	}
	return similarities;
}