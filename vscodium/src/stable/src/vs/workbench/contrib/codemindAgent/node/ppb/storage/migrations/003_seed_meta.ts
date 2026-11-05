/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration 003 — seed data (P1-T02, spec §9.1: "versioned migrations, seed data and a
 * documented rollback path").
 *
 * Seeds the PPB metadata row set: the pinned ontology/schema version and the placeholder
 * embedding configuration (OD-2), so the database records which placeholder was current when
 * its rows were written. Idempotent via ON CONFLICT DO NOTHING.
 */

import { PPB_EMBEDDING_DIM, PPB_EMBEDDING_MODEL } from '../../config.js';

export const version = '003_seed_meta';

export const sql = `
CREATE TABLE IF NOT EXISTS ppb_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ppb_meta (key, value) VALUES
	('ontology_version', '1'),
	('embedding_model', '${PPB_EMBEDDING_MODEL}'),
	('embedding_dim', '${PPB_EMBEDDING_DIM}')
ON CONFLICT (key) DO NOTHING;
`;

export const down = `
DROP TABLE IF EXISTS ppb_meta;
`;
