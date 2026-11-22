/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration 007 — HNSW index for embeddings wider than pgvector's `vector` index limit (P1-T07, F3).
 *
 * pgvector's HNSW/IVFFlat indexes on the `vector` type cap at 2000 dimensions, so migration 005
 * deliberately omits the index when the pinned embedding model is wider (DEV-18/F3) and retrieval
 * degrades to an exact sequential scan. `halfvec` (half-precision) supports HNSW up to 4000
 * dimensions, so a 2048-dim deployment can carry a real approximate index after all.
 *
 * The index is an **expression** index on `(embedding::halfvec(N))`; the query path in
 * `embeddings/vectorStore.ts` uses the identical expression so the planner can use it. When the
 * pinned dimension is <= 2000 the plain HNSW index from 005 already applies and this migration is a
 * no-op. Precision halves, which slightly perturbs distances but not the ranking order.
 */

import { PPB_EMBEDDING_DIM } from '../../config.js';
import { HNSW_MAX_DIM } from './005_embedding_index.js';

export const version = '007_hnsw_halfvec';

export const sql = PPB_EMBEDDING_DIM > HNSW_MAX_DIM
	? `
CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_halfvec_idx
	ON embeddings USING hnsw ((embedding::halfvec(${PPB_EMBEDDING_DIM})) halfvec_cosine_ops);
`
	: `
-- dimension ${PPB_EMBEDDING_DIM} <= ${HNSW_MAX_DIM}: migration 005's vector HNSW index applies.
SELECT 1;
`;

export const down = `
DROP INDEX IF EXISTS embeddings_embedding_hnsw_halfvec_idx;
`;
