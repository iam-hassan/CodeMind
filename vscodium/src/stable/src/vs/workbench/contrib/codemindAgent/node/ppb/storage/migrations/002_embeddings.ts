/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration 002 — pgvector embeddings (P1-T02, spec §9.2/§14).
 *
 * Requires the `vector` extension (pgvector). The embedding dimension is a PLACEHOLDER
 * (OD-2 — BGE-M3 default assumed at 1024; finalized at T07). The vector index type
 * (HNSW vs IVFFlat) is deferred (OD-1) and will land in a later migration once decided.
 *
 * `owner_id` is polymorphic (fact/decision/event) so it carries no FK; ownership is asserted
 * through `owner_kind` (documented in docs/ppb/schema.md).
 */

import { PPB_EMBEDDING_DIM } from '../../config.js';

export const version = '002_embeddings';

export const sql = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS embeddings (
	owner_kind TEXT NOT NULL CHECK (owner_kind IN ('fact','decision','event')),
	owner_id UUID NOT NULL,
	embedding vector(${PPB_EMBEDDING_DIM}) NOT NULL,
	embedded_text TEXT NOT NULL,
	embedded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_kind, owner_id)
);
-- NOTE(OD-1): vector index intentionally deferred to a later migration.
`;

/** The extension is deliberately left installed (shared database object); only the table drops. */
export const down = `
DROP TABLE IF EXISTS embeddings;
`;
