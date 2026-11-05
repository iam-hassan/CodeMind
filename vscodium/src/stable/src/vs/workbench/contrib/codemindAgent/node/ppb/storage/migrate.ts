/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * PPB schema migration runner (P1-T02).
 *
 * Operates on an injected minimal query interface so it is unit-testable without a live
 * database; the PostgreSQL client is constructed by the storage layer (M3, `storage/pg.ts`).
 * Each migration is applied inside a transaction and recorded in `schema_migrations`; the
 * rollback path reverts in reverse order using each migration's `down` SQL (§9.1: "versioned
 * migrations, seed data and a documented rollback path").
 */

import { PPB_MIGRATIONS, type PpbMigration } from './migrations/index.js';

export interface MigrationQueryable {
	query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MigrationResult {
	readonly applied: string[];
	readonly skipped: string[];
}

export interface RollbackResult {
	readonly reverted: string[];
}

export interface RollbackOptions {
	/** Target state: roll back to (and keep) this version, i.e. revert everything after it. */
	readonly toVersion?: string;
	readonly migrations?: readonly PpbMigration[];
}

const ENSURE_MIGRATIONS_TABLE =
	'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())';

async function appliedVersions(db: MigrationQueryable): Promise<Set<string>> {
	const existing = await db.query('SELECT version FROM schema_migrations');
	return new Set(existing.rows.map(row => String(row.version)));
}

export async function runMigrations(
	db: MigrationQueryable,
	migrations: readonly PpbMigration[] = PPB_MIGRATIONS,
	log: (message: string) => void = () => { }
): Promise<MigrationResult> {
	await db.query(ENSURE_MIGRATIONS_TABLE);
	const applied = await appliedVersions(db);

	const result: MigrationResult = { applied: [], skipped: [] };
	for (const migration of migrations) {
		if (applied.has(migration.version)) {
			result.skipped.push(migration.version);
			continue;
		}
		log(`ppb: applying migration ${migration.version}`);
		await db.query('BEGIN');
		try {
			await db.query(migration.sql);
			await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
			await db.query('COMMIT');
			result.applied.push(migration.version);
		} catch (error) {
			await db.query('ROLLBACK');
			throw error;
		}
	}
	return result;
}

/** Reverts applied migrations in reverse order; each revert is transactional. */
export async function rollbackMigrations(
	db: MigrationQueryable,
	options: RollbackOptions = {},
	log: (message: string) => void = () => { }
): Promise<RollbackResult> {
	const migrations = options.migrations ?? PPB_MIGRATIONS;
	await db.query(ENSURE_MIGRATIONS_TABLE);
	const applied = await appliedVersions(db);

	if (options.toVersion !== undefined && !applied.has(options.toVersion)) {
		// Never guess: an unknown or never-applied target must not silently revert the whole schema.
		throw new Error(`rollback target '${options.toVersion}' has not been applied`);
	}
	const reverted: string[] = [];
	for (const migration of [...migrations].reverse()) {
		if (!applied.has(migration.version)) {
			continue;
		}
		if (options.toVersion !== undefined && migration.version === options.toVersion) {
			break;
		}
		log(`ppb: reverting migration ${migration.version}`);
		await db.query('BEGIN');
		try {
			await db.query(migration.down);
			await db.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
			await db.query('COMMIT');
			reverted.push(migration.version);
		} catch (error) {
			await db.query('ROLLBACK');
			throw error;
		}
	}
	return { reverted };
}
