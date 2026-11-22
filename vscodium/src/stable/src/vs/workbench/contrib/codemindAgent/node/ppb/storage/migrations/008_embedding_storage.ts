/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration 008 — compact embedding storage precision (OD-2, storage).
 *
 * `002_embeddings` creates the vector column at the precision selected by `PPB_EMBEDDING_STORAGE`.
 * When a database was created before the compact layout was chosen, this migration converts the
 * existing `vector(N)` column to `halfvec(N)`, halving the embedding footprint (4 → 2 bytes per
 * dimension) with no change to the retrieval contract: the distance stays cosine and the HNSW
 * index expression is unchanged (migration 007 already indexes `embedding::halfvec(N)`).
 *
 * When the configured precision is `vector` (the default), the column from 002 is already correct
 * and this migration is a documented no-op.
 */

import { PPB_EMBEDDING_DIM, PPB_EMBEDDING_STORAGE } from '../../config.js';

export const version = '008_embedding_storage';

export const sql = PPB_EMBEDDING_STORAGE === 'halfvec'
	? `
-- 005's plain vector index (only present when the pinned dimension <= 2000) cannot survive a
-- column-type change, so drop it first; the halfvec index is (re)created below.
DROP INDEX IF EXISTS embeddings_embedding_hnsw_idx;
ALTER TABLE embeddings ALTER COLUMN embedding TYPE halfvec(${PPB_EMBEDDING_DIM}) USING embedding::halfvec(${PPB_EMBEDDING_DIM});
CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_halfvec_idx
	ON embeddings USING hnsw (embedding halfvec_cosine_ops);
`
	: `
-- storage precision is 'vector' (the default); the float32 column from 002 is already correct.
SELECT 1;
`;

export const down = `
DROP INDEX IF EXISTS embeddings_embedding_hnsw_halfvec_idx;
${PPB_EMBEDDING_STORAGE === 'halfvec'
		? `ALTER TABLE embeddings ALTER COLUMN embedding TYPE vector(${PPB_EMBEDDING_DIM}) USING embedding::vector(${PPB_EMBEDDING_DIM});`
		: '-- nothing to revert'}
`;
