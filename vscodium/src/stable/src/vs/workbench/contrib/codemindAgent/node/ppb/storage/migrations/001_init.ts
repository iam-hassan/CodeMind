/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration 001 — PPB core relational schema (P1-T02, spec §9/§10/§11/§12/§13/§27).
 *
 * The pgvector-dependent objects live in 002_embeddings so the core schema can be applied on a
 * PostgreSQL instance without pgvector. PLACEHOLDER defaults and deferred decisions are marked
 * inline (spec §26/§32). Every migration carries a `down` (documented rollback path, §9.1/T02).
 *
 * 001_init (rev, 2026-09-30): added `memory_versions` version-audit table, `neo4j_outbox` for
 * eventual-consistent graph projection, and its unprocessed index. The `down` drops them.
 */

export const version = '001_init';

export const sql = `
-- §9.1 projects — Part 1 stores the project reference; project identity is produced by Part 2 (§3.2).
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §7 memories (facts/patterns/rules/standards/constraints/preferences) with §7.5 metadata
CREATE TABLE IF NOT EXISTS memories (
	id UUID PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	category TEXT NOT NULL CHECK (category IN ('technology_stack','architecture_patterns','business_rules','engineering_standards','constraints','developer_preferences')),
	content TEXT NOT NULL,
	confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
	importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
	source_ref TEXT,
	author TEXT,
	extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','superseded')),
	superseded_by UUID REFERENCES memories(id),
	access_count INTEGER NOT NULL DEFAULT 0,
	last_accessed_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_project_category_status_idx ON memories (project_id, category, status);

-- §10 decisions — §10.2 status vocabulary is Accepted/Rejected/Superseded (preserve exactly).
-- The §13 lifecycle of the decision's memory is recorded in memory_versions (§13.7).
CREATE TABLE IF NOT EXISTS decisions (
	id UUID PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	decision TEXT NOT NULL,
	reason TEXT,
	alternatives TEXT,
	status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','rejected','superseded')),
	decided_at TIMESTAMPTZ,
	source_ref TEXT,
	author TEXT,
	confidence DOUBLE PRECISION,
	importance DOUBLE PRECISION,
	superseded_by UUID REFERENCES decisions(id),
	access_count INTEGER NOT NULL DEFAULT 0,
	last_accessed_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_project_status_idx ON decisions (project_id, status);

-- §11 events (added / rejected / migrated / changed — §6.3)
CREATE TABLE IF NOT EXISTS events (
	id UUID PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	event_type TEXT NOT NULL CHECK (event_type IN ('added','rejected','migrated','changed')),
	description TEXT NOT NULL,
	occurred_at TIMESTAMPTZ NOT NULL,
	source_ref TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_project_occurred_idx ON events (project_id, occurred_at);

-- §12 conflict reports (severity scale intentionally unconstrained: PLACEHOLDER pending §32;
-- existing_memory_id is polymorphic — memories/decisions/events — so it carries no FK)
CREATE TABLE IF NOT EXISTS conflict_reports (
	id UUID PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	existing_memory_id UUID,
	incoming_payload JSONB NOT NULL,
	category TEXT,
	severity TEXT,
	question TEXT,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
	resolution TEXT CHECK (resolution IN ('accept_migration','keep_existing','discard_incoming')),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS conflict_reports_project_status_idx ON conflict_reports (project_id, status);

-- §13 version audit trail (memory_id is polymorphic — memories or decisions — so it carries no FK;
-- no in-place mutation of memories — §6.9)
CREATE TABLE IF NOT EXISTS memory_versions (
	id UUID PRIMARY KEY,
	memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
	from_status TEXT CHECK (from_status IS NULL OR from_status IN ('active','archived','superseded')),
	to_status TEXT NOT NULL CHECK (to_status IN ('active','archived','superseded')),
	reason TEXT,
	recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_versions_memory_idx ON memory_versions (memory_id, recorded_at);

-- §27 / IF-10 pipeline telemetry (no secrets or PII — §25/§27)
CREATE TABLE IF NOT EXISTS ppb_telemetry (
	id BIGSERIAL PRIMARY KEY,
	project_id TEXT,
	stage TEXT NOT NULL,
	duration_ms DOUBLE PRECISION,
	payload JSONB,
	recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- write-path outbox: eventual-consistent graph projection (§24)
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
DROP TABLE IF EXISTS ppb_telemetry;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS decisions;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS projects;
`;