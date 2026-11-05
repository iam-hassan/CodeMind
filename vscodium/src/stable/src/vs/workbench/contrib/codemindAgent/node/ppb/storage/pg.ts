/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * PostgreSQL access layer (P1-T03, spec §9.1/§9.5, IF-11).
 *
 * The only place a `pg` client is constructed. Everything else — repositories, services,
 * migration glue — takes an injected query interface so it stays unit-testable and so raw SQL
 * never leaks outside the storage layer (spec §6.7/§9.5).
 */

import { Client } from 'pg';
import { loadPpbConfig, type PpbConfig } from '../config.js';
import { runMigrations, type MigrationResult } from './migrate.js';

/** Short connect timeout so a missing database degrades fast (spec §24). PLACEHOLDER (§26/§32). */
const CONNECTION_TIMEOUT_MS = 5_000;

/** Statement ceiling so a wedged query cannot hang the caller forever (§24). PLACEHOLDER (§26/§32). */
const STATEMENT_TIMEOUT_MS = 15_000;

export function createPgClient(pgUrl: string): Client {
	const client = new Client({
		connectionString: pgUrl,
		connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
		statement_timeout: STATEMENT_TIMEOUT_MS,
		query_timeout: STATEMENT_TIMEOUT_MS,
		application_name: 'codemind-ppb'
	});
	// A client-level 'error' with no listener is an uncaught exception in the engine worker;
	// absorb it here — the caller's failing query is what surfaces the problem.
	client.on('error', () => { /* handled by the awaiting caller */ });
	return client;
}

/** Open a client, run `fn`, always close — including when `connect()` itself throws. */
export async function withPgClient<T>(pgUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
	const client = createPgClient(pgUrl);
	try {
		await client.connect();
		return await fn(client);
	} finally {
		try {
			await client.end();
		} catch {
			/* closing best-effort */
		}
	}
}

/** Apply the versioned PPB migrations to the configured database (IF-11). */
export async function applyPpbMigrations(config: PpbConfig = loadPpbConfig(), log?: (message: string) => void): Promise<MigrationResult> {
	return withPgClient(config.pgUrl, client => runMigrations(client, undefined, log));
}
