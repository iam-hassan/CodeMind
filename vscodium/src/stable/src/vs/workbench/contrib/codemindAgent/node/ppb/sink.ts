/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConversationSegment, ISegmentSink } from '../orchestration/segmentQueue.js';
import { StubExtractor } from './extraction/stubExtractor.js';
import { contentTokens, lexicalSimilarity, normaliseContent } from './extraction/dedup.js';
import type { ExtractedFact, Extractor } from './extraction/types.js';
import type { ConflictReport } from './conflict/detector.js';
import { projectOutbox, type GraphProjectionTarget } from './graph/projector.js';
import { redact, redactJson } from './redact.js';
import type { RetrievalCache } from './storage/redis.js';
import type { WriteQueryable } from './storage/write.js';

export interface PpbSinkOptions {
	/** Extraction implementation; defaults to the M2 stub (empty fact set). */
	readonly extractor?: Extractor;
	/** PostgreSQL write surface (P1-T04/T05). When present, facts are persisted (§24 wired). */
	readonly write?: WriteQueryable;
	/** Graph projection target applied after a successful persist (§9.3/§24). */
	readonly projector?: GraphProjectionTarget;
	/**
	 * §6.6 — the shared-preferences exception. When present, a conversation statement of a *global*
	 * developer preference is written as a global Preference node (visible in every project) instead
	 * of a project-scoped memory. Satisfied by the graph repository.
	 */
	readonly preferences?: { saveGlobalPreference(input: { id: string; [property: string]: unknown }): Promise<unknown> };
	/** Embedding client for the stored facts (P1-T07). Optional — storage succeeds without it (§14.8). */
	readonly embedder?: { embed(texts: readonly string[]): Promise<number[][]> };
	/** Structured logging hook (IF-10 telemetry lands with the storage layer, M3). */
	readonly log?: (message: string) => void;
	/** Optional observer so the UI can surface ingestion as tool activity. */
	readonly onEvent?: (event: PpbSinkEvent) => void;
	/** Optional IF-12 ranked-result cache; dropped after a write so retrieval sees new knowledge. */
	readonly cache?: RetrievalCache;
}

/** One step of the ingestion pipeline, reported to `options.onEvent`. */
export interface PpbSinkEvent {
	readonly turnId: string;
	readonly stage: 'extract' | 'persist' | 'embed' | 'project' | 'supersede' | 'conflict' | 'decision' | 'error';
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
// D56: a single rich turn ("we chose X, which means Y, and Z must change") routinely extracts more
// than six distinct, durable facts; the previous cap of 6 silently discarded the lower-importance
// ones (e.g. the constraint or provenance fact), so they were never retrievable later. Raised to
// keep a full turn's worth. The importance threshold, not the cap, is what filters noise.
const MAX_FACTS_PER_TURN = 12;

function selectFactsToStore(facts: readonly ExtractedFact[]): ExtractedFact[] {
	return [...facts]
		.filter(fact => fact.importance >= MIN_FACT_IMPORTANCE && fact.content.trim().length >= 8)
		.sort((a, b) => b.importance - a.importance)
		.slice(0, MAX_FACTS_PER_TURN);
}

// ── Deduplication channel (§8) ────────────────────────────────────────────────
//
// The extraction contract has no embeddings, and re-extracting the same turn routinely yields a
// paraphrase ("No paid services are allowed in the MVP." vs "...in the MVP"). Exact-equality dedup
// alone would store both. The shared lexical channel in `dedup.ts` compares content-word sets; at
// or above this overlap two statements are treated as the same fact.
/** At/above this Jaccard overlap two statements are treated as one (§8.4). PLACEHOLDER. */
const NEAR_DUPLICATE_SIMILARITY = 0.6;

// ── Global developer preferences (§6.6 shared-preferences exception) ──────────
//
// A developer preference that is stated as applying to *every* project must be visible in every
// project and must NOT be stored as project-scoped knowledge. The extraction contract carries only
// a category, so "global" is recognised from the statement's scope wording; anything less explicit
// stays a normal project-scoped preference.
const GLOBAL_PREFERENCE_PATTERN = /\b(all (?:my |our |the )?projects?|every project|across projects?|projects? in general|in general|generally|globally|global preference|always|universally|regardless of (?:the )?project|as a rule|by default)\b/i;

/** True when a fact states a preference for all projects rather than this one (§6.6). */
export function isGlobalPreference(fact: Pick<ExtractedFact, 'category' | 'content'>): boolean {
	return fact.category === 'developer_preferences' && GLOBAL_PREFERENCE_PATTERN.test(fact.content);
}

/** Stable id for a global preference so re-ingesting the same statement updates, never duplicates. */
export function globalPreferenceId(content: string): string {
	const normalised = normaliseContent(content);
	let hash = 2166136261;
	for (let i = 0; i < normalised.length; i++) {
		hash ^= normalised.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `ppb:global-pref:${(hash >>> 0).toString(16)}`;
}

/** Split facts into global preferences (stored globally) and ordinary project facts. */
export function splitGlobalPreferences(facts: readonly ExtractedFact[]): { global: ExtractedFact[]; local: ExtractedFact[] } {
	const global: ExtractedFact[] = [];
	const local: ExtractedFact[] = [];
	for (const fact of facts) {
		(isGlobalPreference(fact) ? global : local).push(fact);
	}
	return { global, local };
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
	private readonly _preferences: PpbSinkOptions['preferences'] | undefined;
	private readonly _embedder: PpbSinkOptions['embedder'] | undefined;
	private readonly _log: (message: string) => void;
	private readonly _onEvent: ((event: PpbSinkEvent) => void) | undefined;
	private readonly _cache: RetrievalCache | undefined;

	constructor(options: PpbSinkOptions = {}) {
		this._extractor = options.extractor ?? new StubExtractor();
		this._write = options.write;
		this._projector = options.projector;
		this._preferences = options.preferences;
		this._embedder = options.embedder;
		this._log = options.log ?? (() => { });
		this._onEvent = options.onEvent;
		this._cache = options.cache;
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
				const selected = selectFactsToStore(result.facts);
				if (selected.length === 0 || !this._write) {
					this._log(`ppb: turn ${segment.turnId} -> ${result.facts.length} extracted, ${selected.length} kept`);
					continue;
				}
				// §8 — drop facts the store already knows (exact or a close paraphrase). Without this
				// the same knowledge accumulates one near-copy per turn, which /list and retrieval
				// both surface.
				// §6.6 — a preference stated for *all* projects is written to the shared Preference
				// store (visible in every project) and is NOT persisted as project-scoped knowledge.
				const { global: globalPrefs, local: localFacts } = splitGlobalPreferences(selected);
				if (globalPrefs.length > 0) {
					await this._recordGlobalPreferences(globalPrefs);
				}
				const kept = await this._dropDuplicates(segment.projectId, localFacts);
				if (kept.length === 0) {
					this._log(`ppb: turn ${segment.turnId} -> ${selected.length} selected (${globalPrefs.length} global preference(s)); nothing to persist locally`);
					continue;
				}
				// A fact that replaces existing same-category knowledge (a plan change: "build Y
				// instead of X") archives the old memory, so two contradictory plans are never both
				// active and retrieval surfaces only the current direction.
				const superseded: Array<{ id: string; reason: string }> = [];
				// IF-3: every detected contradiction is recorded as a pending confirmation request so
				// the audit trail exists and Part 2 can transport it to the dialog (§12.6). Previously
				// the report was discarded after the id was read.
				const conflicts: ConflictReport[] = [];
				try {
					const { findConflict } = await import('./conflict/detector.js');
					const { findFacts } = await import('./storage/read.js');
					// Distinctive content words only (the shared tokenizer drops generic verbs like
					// "used"), so a plan change archives only memories about the same subject — not
					// every fact that happens to share a common word.
					const words = (text: string): string[] => [...contentTokens(text)];
					const REPLACE = /\b(instead of|no longer|now builds|now build|switch(?:ed|ing)?|replac(?:e|ed|ing)|chang(?:e|ed|ing)|drop(?:ped|ping)?|migrat(?:e|ed|ing)|not going to|abandon(?:ed|ing)?|previously|used to|decommission(?:ed)?|retir(?:e|ed)|discontinu(?:e|ed)|superseded|phased out)\b/i;
					const push = (id: string | undefined, content: string): void => {
						if (id && !superseded.some(entry => entry.id === id)) { superseded.push({ id, reason: `replaced by: ${content}` }); }
					};
					for (const fact of kept) {
						const conflict = await findConflict(this._write, segment.projectId, fact);
						if (conflict) {
							push(conflict.existing.id, fact.content);
							if (!conflicts.some(entry => entry.existing.id === conflict.existing.id)) {
								conflicts.push(conflict);
							}
						}
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
				// IF-3 (§12.6): record each detected contradiction as a pending confirmation request.
				// Best-effort — a missing audit row must never fail ingestion.
				if (conflicts.length > 0) {
					try {
						const { persistConflictReport } = await import('./conflict/detector.js');
						for (const report of conflicts) {
							await persistConflictReport(this._write, report);
						}
						this._emit({ turnId: segment.turnId, stage: 'conflict', ok: true, count: conflicts.length });
						this._log(`ppb: turn ${segment.turnId} -> ${conflicts.length} conflict report(s) recorded`);
					} catch { /* conflict audit is best-effort */ }
				}
				// §10/§11: project decision-shaped and change-shaped facts into Decision/Event memory so
				// the reasoning surface (§17) can answer "why/when/which rejected" from a real
				// conversation. Idempotent — re-ingesting a turn does not duplicate records.
				started = Date.now();
				const recorded = await this._recordDecisionMemory(segment, kept);
				if (recorded.decisions > 0 || recorded.events > 0) {
					this._emit({ turnId: segment.turnId, stage: 'decision', ok: true, count: recorded.decisions + recorded.events, durationMs: took(started) });
					this._log(`ppb: turn ${segment.turnId} -> ${recorded.decisions} decision(s), ${recorded.events} event(s) recorded`);
				}
				// Project LAST: every write above (memory, relationship, archive, decision, event)
				// queued an outbox row, so one drain here leaves nothing pending for the next turn.
				started = Date.now();
				await this._project();
				this._emit({ turnId: segment.turnId, stage: 'project', ok: true, durationMs: took(started) });
				// IF-12: stored knowledge changed, so any cached ranked list for this project is stale.
				await this._invalidateCache(segment.projectId);
			} catch (error) {
				// Never reject: a failed segment must not break the queue (§24).
				const detail = redact(String(error));
				this._emit({ turnId: segment.turnId, stage: 'error', ok: false, durationMs: took(started), detail });
				this._log(`ppb: ingestion failed for turn ${segment.turnId}: ${detail}`);
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
			this._log(`ppb: backfill requested for ${projectId} (${redactJson(options ?? {})})`);
		} catch {
			// Never throw — the learning loop calls this fire-and-forget.
		}
	}

	/**
	 * §10/§11 bridge: project decision-shaped and change-shaped facts into Decision/Event memory.
	 * Idempotent per (project, text) — a re-ingested turn records nothing new. Best-effort: a failure
	 * here never fails ingestion. Returns how many records were newly created.
	 */
	private async _recordDecisionMemory(segment: ConversationSegment, facts: readonly ExtractedFact[]): Promise<{ decisions: number; events: number }> {
		if (!this._write || facts.length === 0) {
			return { decisions: 0, events: 0 };
		}
		const occurredAt = new Date(segment.timestamp || Date.now()).toISOString();
		let decisions = 0;
		let events = 0;
		try {
			const { deriveDecision, deriveEvent } = await import('./decisions/derive.js');
			const { createDecision, recordEvent, findDecisionByText, findEventByDescription } = await import('./decisions/decisionMemory.js');
			for (const fact of facts) {
				const decision = deriveDecision(fact);
				if (decision) {
					const existing = await findDecisionByText(this._write, segment.projectId, decision.decision);
					if (!existing) {
						await createDecision(this._write, { ...decision, projectId: segment.projectId });
						decisions++;
					}
				}
				const event = deriveEvent(fact, occurredAt);
				if (event) {
					const existing = await findEventByDescription(this._write, segment.projectId, event.eventType, event.description);
					if (!existing) {
						await recordEvent(this._write, { ...event, projectId: segment.projectId });
						events++;
					}
				}
			}
		} catch (error) {
			this._log(`ppb: decision/event recording failed: ${redact(String(error))}`);
		}
		return { decisions, events };
	}

	/**
	 * §6.6 — write each global developer preference as a shared `Preference` node. Idempotent by a
	 * content-derived id, so re-ingesting the same statement updates rather than duplicates. Best-effort:
	 * a missing graph surface is logged, not fatal.
	 */
	private async _recordGlobalPreferences(facts: readonly ExtractedFact[]): Promise<void> {
		if (!this._preferences) {
			this._log(`ppb: ${facts.length} global preference(s) seen but no preference store is configured`);
			return;
		}
		for (const fact of facts) {
			try {
				await this._preferences.saveGlobalPreference({
					id: globalPreferenceId(fact.content),
					content: fact.content,
					category: fact.category,
					author: fact.author,
					sourceRef: fact.sourceRef
				});
				this._log(`ppb: recorded global preference: ${fact.content.slice(0, 80)}`);
			} catch (error) {
				this._log(`ppb: failed to record global preference: ${redact(String(error))}`);
			}
		}
	}

	/**
	 * §8 dedup: keep a fact only when it is not already stored. Compares against every active memory
	 * in the project — not just the same category — because re-extracting the same turn can classify
	 * an identical statement under a different category, and a redundant statement is redundant
	 * wherever it lands. Also compares against facts already accepted this turn. Best-effort: on any
	 * failure every fact is kept rather than risking data loss.
	 */
	private async _dropDuplicates(projectId: string, facts: readonly ExtractedFact[]): Promise<ExtractedFact[]> {
		if (!this._write || facts.length === 0) {
			return [...facts];
		}
		try {
			const { findFacts } = await import('./storage/read.js');
			const stored = await findFacts(this._write, projectId, { status: 'active', limit: 500 });
			const pool = stored.map(memory => ({ content: memory.content }));
			const accepted: ExtractedFact[] = [];
			for (const fact of facts) {
				const normalised = normaliseContent(fact.content);
				const duplicate = pool.some(candidate =>
					normaliseContent(candidate.content) === normalised
					|| lexicalSimilarity(fact.content, candidate.content) >= NEAR_DUPLICATE_SIMILARITY
				);
				if (duplicate) {
					this._log(`ppb: dropped duplicate fact: ${fact.content.slice(0, 80)}`);
					continue;
				}
				accepted.push(fact);
				pool.push({ content: fact.content });
			}
			return accepted;
		} catch (error) {
			this._log(`ppb: dedup check failed, keeping all facts: ${redact(String(error))}`);
			return [...facts];
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
			this._log(`ppb: embedding failed: ${redact(String(error))}`);
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
			this._log(`ppb: projection failed: ${redact(String(error))}`);
		}
	}

	/** IF-12 — drop this project's cached ranked lists after stored knowledge changed. */
	private async _invalidateCache(projectId: string): Promise<void> {
		if (!this._cache) {
			return;
		}
		try {
			await this._cache.invalidate(projectId);
		} catch {
			/* a failed invalidation must never fail ingestion; entries expire via TTL */
		}
	}
}