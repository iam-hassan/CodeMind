/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration 005 — pgvector similarity index (P1-T07, spec §9.2).
 *
 * OD-1 decided at T07: **HNSW** with the **cosine** operator class. HNSW is chosen over IVFFlat
 * because it needs no training/`lists` tuning on an initially-empty table and gives better
 * recall/latency at this scale. The operator class must match the query operator used by the
 * vector store (`<=>`, cosine distance).
 *
 * DEV-18: pgvector's HNSW/IVFFlat indexes cap at 2000 dimensions. A deployment that pins an
 * embedding model wider than that (e.g. a 2048-dimension model) cannot carry the index, so the
 * migration degrades to exact cosine search (`<=>`, sequential scan) instead of failing — the
 * query path is identical, only the index is omitted. The dimension is configurable (OD-2).
 */

import { PPB_EMBEDDING_DIM } from '../../config.js';

export const version = '005_embedding_index';

/** pgvector's documented maximum indexed dimension for HNSW/IVFFlat. */
export const HNSW_MAX_DIM = 2000;

export const sql = PPB_EMBEDDING_DIM <= HNSW_MAX_DIM
	? `
CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_idx
	ON embeddings USING hnsw (embedding vector_cosine_ops);
`
	: `
-- NOTE(DEV-18): pgvector cannot index a ${PPB_EMBEDDING_DIM}-dimension vector with HNSW
-- (HNSW/IVFFlat limit is ${HNSW_MAX_DIM}); exact cosine search is used instead.
SELECT 1;
`;

export const down = `
DROP INDEX IF EXISTS embeddings_embedding_hnsw_idx;
`;
