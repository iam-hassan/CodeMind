/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration 004 — write-path tables (P1-T04/T05 persist, spec §9.1/§24).
 *
 * Adds `memory_versions` (immutable version audit trail for every memory fact),
 * `neo4j_outbox` (eventual-consistent graph projection, processed asynchronously),
 * and an index on unprocessed outbox rows.
 *
 * Rollback drops them — safe because the write service is not yet wired (facts
 * are extracted but not persisted; no data to lose).
 */

export const version = '004_write_path';

export const sql = `
CREATE TABLE IF NOT EXISTS memory_versions (
	id UUID PRIMARY KEY,
	memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
	from_status TEXT CHECK (from_status IS NULL OR from_status IN ('active','archived','superseded')),
	to_status TEXT NOT NULL CHECK (to_status IN ('active','archived','superseded')),
	reason TEXT,
	recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_versions_memory_idx ON memory_versions (memory_id, recorded_at);

CREATE TABLE IF NOT EXISTS neo4j_outbox (
	id UUID PRIMARY KEY,
	event_type TEXT NOT NULL,
	payload JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS neo4j_outbox_unprocessed_idx ON neo4j_outbox (created_at) WHERE processed_at IS NULL;
`;

export const down = `
DROP INDEX IF EXISTS neo4j_outbox_unprocessed_idx;
DROP TABLE IF EXISTS neo4j_outbox;
DROP TABLE IF EXISTS memory_versions;
`;