# PPB Interface Contracts (IF-1 … IF-12) — Phase 1 Part 1

| Field | Value |
|---|---|
| Authority | `phase_1.md` §18 (IF catalogue), §18.4 (required documentation per IF), §18.5 (no invented payload fields) |
| Rule | Unspecified payload details are marked **“to be finalized during implementation”**; nothing here may be invented |
| Status | M1 — documented baseline against the real Part 2 contracts |

Each contract lists: Producer → Consumer, Purpose, Shape, Required/optional, Error behaviour, Ownership, Versioning.

---

## IF-1 — Normalized conversation segment

- **Producer → Consumer:** Part 2 → Part 1 (ingestion path).
- **Purpose:** hand over a normalized, PII-redacted conversation turn for extraction.
- **Shape:** `ConversationSegment` — `projectId`, `turnId`, `role` (`user`/`assistant`), `text`, `intent`, `timestamp` (unix ms), `editorState` snapshot (`cwd`, …) — delivered via `ISegmentSink.ingest(segments)` (`node/orchestration/segmentQueue.ts`).
- **Required/optional:** the listed fields are required; additional `editorState` fields are source-of-truth in `segmentQueue.ts`.
- **Error behaviour:** `ingest` must resolve, never reject (fire-and-forget queue semantics documented in source; §24).
- **Ownership:** Part 2 owns production, normalization and redaction; Part 1 consumes.
- **Versioning:** additive changes only; recorded per §33.
- **Part 1 implementation:** `node/ppb/sink.ts` (M2, stub extraction; M3, real extraction).

## IF-2 — Extracted fact set

- **Producer → Consumer:** Part 1 (extraction engine) → Part 1 downstream (dedup, graph, vector) + Part 3 evaluation.
- **Purpose:** structured facts extracted from a segment in the six categories (§7.4) with §7.5 metadata.
- **Shape:** fact records matching the `memories` table columns (id, project_id, category, content, confidence, importance, source_ref, author, extracted_at); exact extraction payload **to be finalized during implementation** (T04/T05).
- **Required/optional:** category + content required; confidence/importance defaults are placeholders.
- **Error behaviour:** validation failure → retry per §24; no partial writes.
- **Ownership:** Part 1.
- **Versioning:** additive; recorded per §33.

## IF-3 — Conflict confirmation request

- **Producer → Consumer:** Part 1 (conflict detector) → Part 2 transport → Part 3 dialog.
- **Purpose:** ask the developer how to resolve a contradiction between an incoming fact and stored memory.
- **Shape:** conflict report — existing memory reference, incoming payload, category, severity (**scale placeholder**, §32), question text; persisted in `conflict_reports`.
- **Error behaviour:** dialog unavailable → report stays `pending`; never blocks a chat turn (§24).
- **Ownership:** Part 1 detects/persists; Part 2 transports; Part 3 presents.
- **Versioning:** additive.

## IF-4 — Confirmation response

- **Producer → Consumer:** Part 3 dialog (via Part 2 transport) → Part 1 versioning.
- **Purpose:** the developer's resolution outcome.
- **Shape:** resolution ∈ `accept_migration` | `keep_existing` | `discard_incoming` (§12) + memory references.
- **Error behaviour:** unknown resolution → rejected and logged; stored state unchanged.
- **Ownership:** Part 1 applies the outcome (versioning).

## IF-5 — Retrieval request

- **Producer → Consumer:** Part 2 (engine/orchestration) → Part 1 retrieval engine.
- **Purpose:** request ranked memories for context injection / tool use.
- **Shape:** `RetrievalRequest` — `projectId`, `query`, `intent`, `openFiles: string[]`, `recentTurns: TurnSummary[]` (`{role, content}`), `maxResults`, `maxTokenBudget` (`node/orchestration/retrievalRequest.ts`).
- **Required/optional:** `projectId`/`query`/`intent` required; `maxResults`/`maxTokenBudget` defaults are placeholders (§26/§32).
- **Error behaviour:** wrapped by `executeRetrieval` (code default timeout — placeholder) → returns `[]` on failure/timeout; a chat turn is never broken (§24).
- **Ownership:** Part 2 produces; Part 1 consumes.
- **Part 1 implementation:** `node/ppb/retrieval/retriever.ts` (M4).

## IF-6 — Ranked memory list

- **Producer → Consumer:** Part 1 → Part 2 (injection block + tool adapter).
- **Purpose:** ranked, project-scoped memories for injection and tool selection.
- **Shape:** `RetrievedFact[]` — `id`, `content`, `score` (0–1, used by the token-budget drop policy), `category` (`decision`/`pattern`/`fact`/`convention`), optional `sourceRef`, and the required `projectId` (`retrievalRequest.ts`).
- **Error behaviour:** empty list is valid; cross-project entries are filtered and counted (leak counter).
- **Ownership:** Part 1 produces; Part 2 consumes.
- **Part 1 implementation:** `node/ppb/retrieval/hybrid.ts` + `ranker.ts` (M4).

## IF-7 — Editor and intent signals

- **Producer → Consumer:** Part 2 → Part 1.
- **Purpose:** situational context for retrieval (`openFiles`, detected intent).
- **Shape:** `openFiles: string[]`, `intent: string` (carried inside IF-5); editor snapshot rides along IF-1 segments.
- **Error behaviour:** absent signals → retrieval proceeds without them.

## IF-8 — Reasoning query

- **Producer → Consumer:** Part 2/Part 3 → Part 1 long-term reasoning layer.
- **Purpose:** natural-language question over historical decisions/events.
- **Shape:** `{ projectId: string, question: string }` — implemented as `ReasoningQuery` (`node/ppb/reasoning/reasoner.ts`); also reachable as the `reason` operation of the `project_brain` MCP tool (`ppb/tool.ts`).
- **Required/optional:** both fields required; an empty `projectId`/`question` is rejected (`ReasoningError`, §17.8).
- **Error behaviour:** a storage failure degrades per §24; an unanswerable question yields the defined insufficient-evidence result, never a fabricated answer (§17.9).
- **Ownership:** Part 1 consumes; Part 2/3 produce.
- **Versioning:** additive; recorded per §33.

## IF-9 — Reasoning answer

- **Producer → Consumer:** Part 1 → Part 2/Part 3.
- **Purpose:** composed answer citing stored memories.
- **Shape:** `ReasoningAnswer` (`reasoner.ts`) — `{ projectId, question, status: 'answered' | 'insufficient-evidence', answer: string, citations: ReasoningCitation[], plan: { questionType, … } }`. Each `ReasoningCitation` is `{ sourceType: 'fact'|'decision'|'event', id, content, sourceRef?, occurredAt?, reason?, alternatives?, status?, rejectedAlternatives? }` and names one stored record, so every claim is traceable (§17.7). The deterministic composer ends with a `Sources:` line listing every citation.
- **Error behaviour:** `status: 'insufficient-evidence'` + `REASONING_INSUFFICIENT_MESSAGE` + empty citations (§17.9/§24); an optional composer is constrained to the evidence and falls back to the deterministic composer on failure.
- **Ownership:** Part 1 produces.
- **Versioning:** additive; recorded per §33.

## IF-10 — Pipeline telemetry

- **Producer → Consumer:** Part 1 stages → Part 3 evaluation + logs.
- **Purpose:** stage-level observability (extraction yield, retrieval latency, cache hits, …).
- **Shape:** `ppb_telemetry` rows (`stage`, `duration_ms`, `payload` JSONB) — **no secrets or PII** (§25/§27).
- **Error behaviour:** telemetry failure must never affect the pipeline (fire-and-forget).

## IF-11 — Schema and repository API

- **Producer → Consumer:** Part 1 → Parts 2/3 (consume only; no direct table access — §9.5/§3.2).
- **Purpose:** versioned schema, migrations and repository interfaces.
- **Shape:** `PPB_MIGRATIONS` + `runMigrations` (`storage/migrations`, `storage/migrate.ts`); repository interfaces over Neo4j/Postgres land with T03/T14.
- **Error behaviour:** migrations are transactional; failed migration rolls back and rethrows.
- **Versioning:** migrations are ordered and recorded in `schema_migrations`; changes per §33.

## IF-12 — Cache read and write

- **Producer/implementer → Consumer:** Part 1 (read/write in the retrieval path) → Part 1 retrieval.
- **Purpose:** serve ranked retrieval results without recomputation.
- **Shape:** keyed by retrieval-request signature; exact key/value schema **to be finalized during implementation** (§18.5).
- **Error behaviour:** cache unavailable → direct path; retrieval never fails because of the cache (§9.4).
- **Ownership:** Part 3 owns cache policy; Part 1 implements read/write.
- **Part 1 implementation:** `node/ppb/storage/redis.ts` (M4).

---

### Cross-cutting rules (§18.4)

- Every IF documents producer/consumer, purpose, shape, required/optional, error behaviour, ownership and versioning — the seven sections above per interface.
- Payload fields not specified in `phase_1.md` are explicitly marked “to be finalized during implementation” (§18.5).
- Contract changes are additive where possible and recorded per §33; the spec wins on conflict.
