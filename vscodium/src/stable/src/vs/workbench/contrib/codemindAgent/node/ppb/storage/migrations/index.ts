/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ordered migration registry (P1-T02).
 *
 * Migrations are TypeScript modules (not `.sql` files) so they survive the workbench bundling
 * step — the build does not copy loose files into `out/`. Recorded as an M1 implementation
 * deviation in docs/ppb/schema.md.
 *
 * Every migration carries a `down` so the rollback path is executable and testable (§9.1/T02).
 */

import { down as initDown, sql as init, version as initVersion } from './001_init.js';
import { down as embeddingsDown, sql as embeddings, version as embeddingsVersion } from './002_embeddings.js';
import { down as seedDown, sql as seed, version as seedVersion } from './003_seed_meta.js';
import { down as writeDown, sql as writeSql, version as writeVersion } from './004_write_path.js';
import { down as indexDown, sql as indexSql, version as indexVersion } from './005_embedding_index.js';
import { down as relDown, sql as relSql, version as relVersion } from './006_relationships.js';

export interface PpbMigration {
	readonly version: string;
	readonly sql: string;
	/** Rollback SQL — reverses exactly what `sql` created (documented rollback path, A9.1/T02). */
	readonly down: string;
}

export const PPB_MIGRATIONS: readonly PpbMigration[] = [
	{ version: initVersion, sql: init, down: initDown },
	{ version: embeddingsVersion, sql: embeddings, down: embeddingsDown },
	{ version: seedVersion, sql: seed, down: seedDown },
	{ version: writeVersion, sql: writeSql, down: writeDown },
	{ version: indexVersion, sql: indexSql, down: indexDown },
	{ version: relVersion, sql: relSql, down: relDown }
];
