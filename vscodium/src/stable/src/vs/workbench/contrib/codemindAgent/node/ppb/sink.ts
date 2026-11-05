/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConversationSegment, ISegmentSink } from '../orchestration/segmentQueue.js';
import { StubExtractor } from './extraction/stubExtractor.js';
import type { ExtractedFact, Extractor } from './extraction/types.js';
import { projectOutbox, type GraphProjectionTarget } from './graph/projector.js';
import type { WriteQueryable } from './storage/write.js';

export interface PpbSinkOptions {
	/** Extraction implementation; defaults to the M2 stub (empty fact set). */
	readonly extractor?: Extractor;
	/** PostgreSQL write surface (P1-T04/T05). When present, facts are persisted (§24 wired). */
	readonly write?: WriteQueryable;
	/** Graph projection target applied after a successful persist (§9.3/§24). */
	readonly projector?: GraphProjectionTarget;
	/** Embedding client for the stored facts (P1-T07). Optional — storage succeeds without it (§14.8). */
	readonly embedder?: { embed(texts: readonly string[]): Promise<number[][]> };
	/** Structured logging hook (IF-10 telemetry lands with the storage layer, M3). */
	readonly log?: (message: string) => void;
	/** Optional observer so the UI can surface ingestion as tool activity. */
	readonly onEvent?: (event: PpbSinkEvent) => void;
}

/** One step of the ingestion pipeline, reported to `options.onEvent`. */
export interface PpbSinkEvent {
	readonly turnId: string;
	readonly stage: 'extract' | 'persist' | 'embed' | 'project' | 'supersede' | 'error';
	readonly ok: boolean;
	readonly count?: number;
	readonly durationMs?: number;
	readonly detail?: string;
}

/** Milliseconds elapsed since `startedAt`. */
function took(startedAt: number): number {
	return Date.now() - startedAt;
}

/**
 * Keep only durable, high-signal facts from one turn (§ efficiency).
 * - Drops facts the extractor itself rated below `MIN_FACT_IMPORTANCE`.
 * - Drops trivial scraps (too short to be self-contained).
 * - Caps to `MAX_FACTS_PER_TURN`, keeping the most important.
 * This is what keeps the store and graph traversable across a long project.
 */
const MIN_FACT_IMPORTANCE = 0.5;
const MAX_FACTS_PER_TURN = 6;

function selectFactsToStore(facts: readonly ExtractedFact[]): ExtractedFact[] {
	return [...facts]
		.filter(fact => fact.importance >= MIN_FACT_IMPORTANCE && fact.content.trim().length >= 8)
		.sort((a, b) => b.importance - a.importance)
		.slice(0, MAX_FACTS_PER_TURN);
}

/**
 * The PPB ingestion sink — extraction + persistence.
 *
 * A segment is extracted into facts (§7), persisted to PostgreSQL (the source of truth, §24) and
 * projected to Neo4j via the outbox (§9.3). Persistence and projection are best-effort: the queue
 * is fire-and-forget, so a storage failure is logged and never rejected (§24). With no `write`
 * surface configured the sink keeps the M2 behaviour (extract + log, nothing persisted).
 */
export class PpbSegmentSink implements ISegmentSink {

	private readonly _extractor: Extractor;
	private readonly _write: WriteQueryable | undefined;
	private readonly _projector: GraphProjectionTarget | undefined;
	private readonly _embedder: PpbSinkOptions['embedder'] | undefined;
	private readonly _log: (message: string) => void;
	private readonly _onEvent: ((event: PpbSinkEvent) => void) | undefined;

	constructor(options: PpbSinkOptions = {}) {
		this._extractor = options.extractor ?? new StubExtractor();
		this._write = options.write;
		this._projector = options.projector;
		this._embedder = options.embedder;
		this._log = options.log ?? (() => { });
		this._onEvent = options.onEvent;
	}

	private _emit(event: PpbSinkEvent): void {
		try { this._onEvent?.(event); } catch { /* observers must never break ingestion */ }
	}

	async ingest(segments: ConversationSegment[]): Promise<void> {
		for (const segment of segments) {
			let started = Date.now();
			try {
				const result = await this._extractor.extract(segment);
				this._emit({ turnId: segment.turnId, stage: 'extract', ok: true, count: result.facts.length, durationMs: took(started) });
				// Keep only durable, high-signal facts: drop low-importance noise and cap volume so
				// the store (and the graph) stays traversable over a long project.
				const kept = selectFactsToStore(result.facts);
				if (kept.length === 0 || !this._write) {
					this._log(`ppb: turn ${segment.turnId} -> ${result.facts.length} extracted, ${kept.length} kept`);
					continue;
				}
				// A fact that replaces existing same-category knowledge (a plan change: "build Y
				// instead of X") archives the old memory, so two contradictory plans are never both
				// active and retrieval surfaces only the current direction.
				const superseded: Array<{ id: string; reason: string }> = [];
				try {
					const { findConflict } = await import('./conflict/detector.js');
					const { findFacts } = await import('./storage/read.js');
					// Distinctive words only, so a plan change archives every existing memory that is
					// about the same subject (both "Angry Birds" facts), not the whole category.
					const STOP = new Set(['this', 'that', 'with', 'from', 'they', 'them', 'have', 'will', 'must', 'should', 'uses', 'using', 'build', 'built', 'game', 'games', 'project', 'code', 'when', 'then', 'into', 'also', 'more', 'some', 'only', 'very', 'been', 'were', 'does', 'the', 'and', 'for', 'are', 'was', 'our', 'you', 'your']);
					const words = (text: string): string[] => (text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(word => !STOP.has(word));
					const REPLACE = /\b(instead of|no longer|now builds|now build|switch(?:ed|ing)?|replac(?:e|ed|ing)|chang(?:e|ed|ing)|drop(?:ped|ping)?|migrat(?:e|ed|ing)|not going to)\b/i;
					const push = (id: string | undefined, content: string): void => {
						if (id && !superseded.some(entry => entry.id === id)) { superseded.push({ id, reason: `replaced by: ${content}` }); }
					};
					for (const fact of kept) {
						const conflict = await findConflict(this._write, segment.projectId, fact);
						if (conflict) { push(conflict.existing.id, fact.content); }
						if (REPLACE.test(fact.content)) {
							const fw = words(fact.content);
							const candidates = await findFacts(this._write, segment.projectId, { category: fact.category, status: 'active' });
							for (const candidate of candidates) {
								if (words(candidate.content).some(word => fw.includes(word))) { push(candidate.id, fact.content); }
							}
						}
					}
				} catch { /* conflict detection is best-effort */ }
				const { persistFacts, persistRelationships, resolveRelationships } = await import('./storage/write.js');
				started = Date.now();
				const written = await persistFacts(this._write, segment.projectId, kept);
				const factIds = written.results.map(entry => entry.factId);
				this._log(`ppb: turn ${segment.turnId} -> ${kept.length} fact(s) persisted`);
				this._emit({ turnId: segment.turnId, stage: 'persist', ok: true, count: written.results.length, durationMs: took(started) });
				const relationships = resolveRelationships(segment.projectId, result.relationships ?? [], kept, factIds);
				if (relationships.length > 0) {
					await persistRelationships(this._write, segment.projectId, relationships);
					this._log(`ppb: turn ${segment.turnId} -> ${relationships.length} relationship(s) persisted`);
				}
				started = Date.now();
				await this._embedFacts(kept, factIds);
				this._emit({ turnId: segment.turnId, stage: 'embed', ok: true, count: factIds.length, durationMs: took(started) });
				started = Date.now();
				await this._project();
				this._emit({ turnId: segment.turnId, stage: 'project', ok: true, durationMs: took(started) });
				if (superseded.length > 0) {
					try {
						const { archiveMemory } = await import('./versioning/versionStore.js');
						for (const entry of superseded) {
							await archiveMemory(this._write, segment.projectId, entry.id, { reason: entry.reason });
						}
						this._emit({ turnId: segment.turnId, stage: 'supersede', ok: true, count: superseded.length });
						this._log(`ppb: turn ${segment.turnId} -> archived ${superseded.length} superseded memory(ies)`);
					} catch { /* archiving is best-effort */ }
				}
			} catch (error) {
				// Never reject: a failed segment must not break the queue (§24).
				this._emit({ turnId: segment.turnId, stage: 'error', ok: false, durationMs: took(started), detail: String(error) });
				this._log(`ppb: ingestion failed for turn ${segment.turnId}: ${String(error)}`);
			}
		}
	}

	/** IF-1 store path used by the `project_brain` tool (Part 2 calls with a raw text segment). */
	async store(segment: { readonly projectId: string; readonly text: string; readonly role?: string; readonly intent?: string; readonly timestamp?: number }): Promise<void> {
		await this.ingest([{
			projectId: segment.projectId,
			turnId: `tool-${Date.now()}`,
			role: segment.role === 'user' ? 'user' : 'assistant',
			text: segment.text,
			intent: segment.intent ?? 'store',
			timestamp: segment.timestamp ?? Date.now(),
			editorState: { cwd: '', openFiles: [], workspaceName: '' }
		}]);
	}

	scheduleBackfill(projectId: string, options: any): void {
		try {
			this._log(`ppb: backfill requested for ${projectId} (${JSON.stringify(options ?? {})})`);
		} catch {
			// Never throw — the learning loop calls this fire-and-forget.
		}
	}

	/** Best-effort embeddings for freshly written facts (§14.8: storage already succeeded). */
	private async _embedFacts(facts: readonly ExtractedFact[], factIds: readonly string[]): Promise<void> {
		if (!this._embedder || !this._write || factIds.length === 0) {
			return;
		}
		try {
			const { upsertEmbedding } = await import('./embeddings/vectorStore.js');
			const contents = facts.map(fact => fact.content);
			const vectors = await this._embedder.embed(contents);
			for (let index = 0; index < vectors.length && index < factIds.length; index++) {
				await upsertEmbedding(this._write, {
					ownerKind: 'fact', ownerId: factIds[index], embedding: vectors[index], embeddedText: contents[index]
				});
			}
		} catch (error) {
			this._log(`ppb: embedding failed: ${String(error)}`);
		}
	}

	/** Best-effort asynchronous projection to the graph (§9.3/§24 — failures retry next pass). */
	private async _project(): Promise<void> {
		if (!this._write || !this._projector) {
			return;
		}
		try {
			await projectOutbox(this._write, this._projector);
		} catch (error) {
			this._log(`ppb: projection failed: ${String(error)}`);
		}
	}
}