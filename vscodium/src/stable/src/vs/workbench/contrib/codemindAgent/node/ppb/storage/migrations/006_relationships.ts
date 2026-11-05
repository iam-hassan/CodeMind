/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration 006 — extracted graph relationships (P1-T02/T04, spec §6.4/§6.8).
 *
 * Tier 2 (structured graph): the extraction engine can now also emit relationships *between* the
 * facts it extracted (e.g. `PostgreSQL DEPENDS_ON AWS RDS`, `Clerk USES Redis`). PostgreSQL stays
 * the source of truth (§24): each relationship is stored here and queued to `neo4j_outbox`, and the
 * projector turns it into an edge between the existing memory nodes. `from_id`/`to_id` are memory
 * ids, or the project id for the project hub.
 */

export const version = '006_relationships';

export const sql = `
CREATE TABLE IF NOT EXISTS graph_relationships (
	id UUID PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	from_id TEXT NOT NULL,
	relationship_type TEXT NOT NULL,
	to_id TEXT NOT NULL,
	properties JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	UNIQUE (project_id, from_id, relationship_type, to_id)
);
`;

export const down = `
DROP TABLE IF EXISTS graph_relationships;
`;
