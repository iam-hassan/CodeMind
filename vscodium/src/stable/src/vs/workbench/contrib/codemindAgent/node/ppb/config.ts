/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 1 Part 1 (PPB Knowledge Core) — runtime configuration.
 *
 * NOTE (spec §26/§32): every default below is a PLACEHOLDER pending real measurement.
 * No latency, threshold, or capacity number is mandated by the specification. Override via
 * environment variables; see `infra/ppb/README.md` for the local development setup.
 */

export interface PpbConfig {
	/** PostgreSQL (pgvector) connection string. PLACEHOLDER (local dev default). */
	readonly pgUrl: string;
	/** Neo4j bolt URL. PLACEHOLDER (local dev default). */
	readonly neo4jUrl: string;
	readonly neo4jUser: string;
	readonly neo4jPassword: string;
	/** Redis connection string (IF-12 cache). PLACEHOLDER (local dev default). */
	readonly redisUrl: string;
	/** OpenAI-compatible endpoint for BGE-M3 embeddings. PLACEHOLDER (local proxy default). */
	readonly embedBaseUrl: string;
	readonly embedModel: string;
	/** Optional bearer token for the embedding endpoint (empty for a local proxy). */
	readonly embedApiKey: string;
	/** OpenAI-compatible endpoint for extraction. PLACEHOLDER — model chosen at T04 (OD-6). */
	readonly extractBaseUrl: string;
	readonly extractModel: string;
	/** Optional bearer token for the extraction endpoint (empty for a local proxy). Codemind dev only. */
	readonly extractApiKey: string;
	/** Per-attempt extraction timeout. PLACEHOLDER — reasoning models need headroom for `thinking`. */
	readonly extractTimeoutMs: number;
}

export type PpbEnv = Record<string, string | undefined>;

/**
 * Embedding configuration — the single source of truth (spec §9.2/§14). Used by the schema
 * migration (`002_embeddings`) and the seed row (`003_seed_meta`) so the dimension and model
 * cannot drift between code, schema and seed. The values are PLACEHOLDERS (OD-2) pinned at T07.
 */
export const PPB_EMBEDDING_MODEL = process.env.PPB_EMBED_MODEL ?? 'bge-m3';
/** Must match the configured embedding model. Env-overridable so a deployment can pin its model (OD-2). */
export const PPB_EMBEDDING_DIM = Number.parseInt(process.env.PPB_EMBEDDING_DIM ?? '', 10) || 1024;

/** Master feature gate. On by default: the brain is part of CodeMind now. Set
 * `CODEMIND_PPB_ENABLED=0` to turn it off entirely (zero behaviour change when off). */
export function isPpbEnabled(env: PpbEnv = process.env): boolean {
	return env.CODEMIND_PPB_ENABLED !== '0';
}

/** Load runtime configuration; environment overrides win over placeholder defaults. */
export function loadPpbConfig(env: PpbEnv = process.env): PpbConfig {
	return {
		pgUrl: env.PPB_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/codemind_ppb', // PLACEHOLDER — Route A Docker stack (infra/ppb/docker-compose.yml)
		neo4jUrl: env.PPB_NEO4J_URL ?? 'bolt://localhost:57687', // PLACEHOLDER — Route A Docker stack
		neo4jUser: env.PPB_NEO4J_USER ?? 'neo4j',
		neo4jPassword: env.PPB_NEO4J_PASSWORD ?? 'codemindppb', // PLACEHOLDER (local dev only)
		redisUrl: env.PPB_REDIS_URL ?? 'redis://localhost:56379', // PLACEHOLDER — Route A Docker stack
		embedBaseUrl: env.PPB_EMBED_BASE_URL ?? 'http://127.0.0.1:20128/v1', // PLACEHOLDER (local OpenAI-compatible proxy)
		embedModel: env.PPB_EMBED_MODEL ?? PPB_EMBEDDING_MODEL,
		embedApiKey: env.PPB_EMBED_API_KEY ?? '', // PLACEHOLDER — empty for the local proxy
		// Empty by default: the engine derives the extraction endpoint from the editor's configured
		// provider (normalised to the OpenAI /v1 shape). Set PPB_EXTRACT_BASE_URL only to override.
		extractBaseUrl: env.PPB_EXTRACT_BASE_URL ?? '',
		extractModel: env.PPB_EXTRACT_MODEL ?? '', // PLACEHOLDER — OD-6 (T04) decides
		extractApiKey: env.PPB_EXTRACT_API_KEY ?? '', // PLACEHOLDER — empty for the local proxy
		// PLACEHOLDER — a reasoning model can spend >30 s in `thinking` before the JSON answer.
		extractTimeoutMs: Number.parseInt(env.PPB_EXTRACT_TIMEOUT_MS ?? '', 10) || 120_000
	};
}
