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

export type EmbeddingOwnerKind = 'fact' | 'decision' | 'event';

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
		`SELECT e.owner_id AS owner_id, e.owner_kind AS owner_kind, 1 - (e.embedding <=> $1::vector) AS similarity
		 FROM embeddings e
		 JOIN memories m ON m.id = e.owner_id
		 WHERE m.project_id = $2 AND e.owner_kind = 'fact' AND m.status = 'active'
		 ORDER BY e.embedding <=> $1::vector
		 LIMIT ${limit}`,
		[toVectorLiteral(queryEmbedding), projectId]
	);
	return result.rows.map(row => ({
		ownerId: String(row.owner_id),
		ownerKind: String(row.owner_kind) as EmbeddingOwnerKind,
		similarity: Number(row.similarity)
	}));
}