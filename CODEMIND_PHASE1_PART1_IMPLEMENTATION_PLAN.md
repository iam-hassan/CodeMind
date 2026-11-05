# CodeMind — Phase 1 Part 1 (PPB Knowledge Core) — Implementation Plan

| Field | Value |
|---|---|
| Version | 1.1 (validated) |
| Date | 2026-09-21 |
| Owner | Muhammad Hassan |
| Authoritative spec | `phase_1.md` (d:\HassanSem\Semester-6\FYP\phase_1.md, 1714 lines, §1–§34) |
| Implementation base | `origin/part2-ingestion-delivery` @ `b65ef3487` (= `origin/main` @ `4bf2498c5` + Phase 1 Part 2) |
| Repo | `D:\HassanSem\Semester-6\FYP\CodeMind` |
| Validation | `CODEMIND_PHASE1_PART1_PLAN_VALIDATION.md` (same directory) — **PLAN APPROVED** |

> Authority rule (spec §28/§29): `phase_1.md` is authoritative. This plan is subordinate to it.
> No capability may be reported "implemented" except from direct repository inspection with evidence (file:line).
> No latency numbers, thresholds, or benchmarks may be invented (spec §26/§32); all such values in code
> are **placeholders pending real measurement** and must be labeled as such.

---

## 1. Verified repository context (all evidence-checked)

### 1.1 Branch topology

| Branch | Head | Content |
|---|---|---|
| `origin/main` | `4bf2498c5` | Phase 0 baseline + rebrand + GUI + Phase 3 consensus UI + Phase 2 orchestration (intent/tools/context/Headroom) + Aristotle pet + `projectBrainAdapter` **stub** |
| `origin/part2-ingestion-delivery` | `b65ef3487` | `origin/main` + 1 commit: **Phase 1 Part 2** (44 files: PPB orchestration modules, 17 tests, Claude Code `ProjectBrainTool`, `bootstrap/ppb.ts`) |
| `feature/aristotle-pet` (current checkout) | `36b305e4d` | Divergent parallel Aristotle commit; **no Part 2 files** — switch before starting |
| `origin/Phase-3_LLM-Consensus`, `origin/feature/consensus-relevance-and-voice` | — | Phase 3 work (out of scope) |

Working tree note: `implementation_plan.md` is deleted (pre-existing, unrelated Phase 3 artifact). Restore or ignore before branching.

### 1.2 Runtime architecture (verified)

- CodeMind = VSCodium fork; panel compiled into the workbench core (`vscodium/src/stable` overlay → `vscodium/vscode` checkout → `out/`).
- Engine (`node/codeMindAgentEngineMain.ts`) runs in an Electron utility process and drives the Claude Agent SDK **imported in-process** from `claude-code/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`.
- `sdk.mjs` spawns its bundled `cli.js` (the agent runtime). The vendored `claude-code/src/` is the reference source for that bundle; runtime changes to it require a bundle rebuild or a patch script (established pattern: `claude-code/patches/*.mjs` = exact-string surgery on `cli.js`).
- **The installed SDK bundle does NOT contain `ProjectBrain`/`CODEMIND_PPB`** — Part 2's `claude-code/src/tools.ts` registration is canonical source but not live at runtime. See AD-1 for the resolution.
- SDK runtime exports (verified by importing `sdk.mjs`): `query`, `tool`, `createSdkMcpServer`, `unstable_v2_*` — in-process MCP servers are available in this exact build.
- Dev loop: `scripts/setup.sh` (fetch+patch VS Code checkout, overlay `cp -rp src/stable/* vscode/`, `npm ci`, compile) → `scripts/run.bat` (Electron dev).

### 1.3 Integration sockets Part 1 must fill (verified contracts)

| # | Socket | Location | Contract |
|---|---|---|---|
| A | Orchestration retriever | `node/orchestration/retrievalRequest.ts` | `IProjectBrainRetriever.retrieve(RetrievalRequest) → RetrievedFact[]`; `RetrievalRequest {projectId, query, intent, openFiles, recentTurns, maxResults, maxTokenBudget}`; `RetrievedFact {id, projectId, content, score, category: 'decision'|'pattern'|'fact'|'convention', sourceRef?}`; `executeRetrieval(retriever, req, timeoutMs=800)` — **800 ms is a Part 2 code default (placeholder), not a spec requirement**; `NullRetriever` fallback exists |
| B | Segment sink | `node/orchestration/segmentQueue.ts` (+ `segmentFilter.ts`) | `ISegmentSink { ingest(segments): Promise<void>; scheduleBackfill?(projectId, {scope: 'project'|'dependency'|'structure', changedPaths, reason}) }`; async drain; `NoopSegmentSink` fallback; segments arrive PII-redacted/normalized |
| C | Injection consumer | `node/orchestration/injectionBlock.ts` | Builds `[PPB CONTEXT]` block from `RetrievedFact[]` (score-sorted, cross-project leak filter, token budget from prefs `maxInjectionTokens` default 2000 — **placeholder**) |
| D | Tool adapter | `node/orchestration/toolAdapters/projectBrainAdapter.ts` | **STUB** ("replaced when Phase 1 (Project Brain) is implemented"); returns `{available:false, reason:/Phase 1/}`; capabilities `['project_memory','architecture_history','decision_history']`; `TIMEOUT_MS = 50` (asserted by drift test `node/test/toolAdapters.test.ts`) |
| E | Claude Code tool | `claude-code/src/tools/ProjectBrainTool/` + `bootstrap/ppb.ts` | Ops `recall|store|list`; env gates `CODEMIND_PPB_ENABLED=1`, `CODEMIND_CURRENT_PROJECT_ID`; `executeProjectBrainOperation(input, projectId, retriever, sink)`; `setRetriever`/`setSink` injection points; Null/Noop defaults |
| F | Project identity/prefs | `node/orchestration/projectRegistry.ts`, `projectIdentity.ts` | `~/.codemind/projects.json` v1; `ppbEnabled:false` default; `resolvePreferences(projectId)`; `getOrCreateProject(cwd)` |
| G | Learning loop | `node/orchestration/learningLoop.ts` | Triggers `scheduleBackfill` (first turn, cost > $0.01, every 10 turns, repo changes) — Part 1 implements the backfill target |
| H | Engine wiring | `node/codeMindAgentEngineMain.ts` | Appends `ppbSuffix` to `systemPromptSuffix`; enqueues segments per turn; imports `NullRetriever`, `NoopSegmentSink`, `projectBrainAdapter` — the swap-in points for Part 1 |
| I | Conflict transport | `node/orchestration/conflictTransport.ts` | `ConflictReport {path, conflictCount, resolution: 'kept_local'|'kept_remote'|'merged'}` — Part 2's transport contract for the M5 conflict loop |

### 1.4 Test infrastructure (verified)

- VS Code test infra: `vscodium/vscode` → `npm run test-node` = `mocha test/unit/node/index.js --delay --ui=tdd --timeout=5000 --exit`; runner glob `**/test/**/*.test.js` under `out/`.
- Part 2 tests live at `node/test/*.test.ts` (17 files) → compiled to `out/vs/workbench/contrib/codemindAgent/node/test/*.test.js` → auto-collected.
- Part 1 tests follow the same convention: `node/test/ppb/*.test.ts`.

---

## 2. Architecture decisions (blocking questions — resolved)

**AD-1 — Agent-side activation: in-process SDK MCP server.**
The engine registers an in-process MCP server (`createSdkMcpServer` + `mcpServers` query option, both confirmed available) exposing a `project_brain` tool (ops `recall | store | list` mirroring `ProjectBrainLogic`) backed directly by Part 1 core running in the engine process. No bundle rebuild, no `cli.js` patching, no divergence.
Part 2's `claude-code/src` tool remains the canonical source/interface record; its env gates and op names are mirrored.
Fallbacks (documented, not selected): rebuild `cli.js` from src via bun (bun present; would invalidate the existing byte-level patch) or bundle patch (unsuited for whole-tool injection).

**AD-2 — Language/runtime & dependency placement.**
All Part 1 code = TypeScript in-repo: `vscodium/src/stable/src/vs/workbench/contrib/codemindAgent/node/ppb/` (engine-process modules) + edits to existing Part 2 files.
Dependencies: `pg`, `neo4j-driver`, `ioredis` (all pure JS, no native builds) installed into `vscodium/vscode` via a new step in `scripts/setup.sh` (after `prepare_vscode.sh`; note `npm ci` is used there — deps are installed into the checkout, not by editing the lockfile). M0 closes two details: esbuild externalization (`pg-native` external if needed) and the exact install command.

**AD-3 — Storage infrastructure.**
`infra/ppb/docker-compose.yml`: PostgreSQL + pgvector, Neo4j, Redis (dev/demo). Config via env (`PPB_*`), placeholder-marked defaults. Absence of infra must degrade gracefully (Null/Noop fallbacks retained — spec §24).

**AD-4 — Model endpoints.**
Extraction LLM + BGE-M3 embeddings via OpenAI-compatible endpoints (configurable base URL/model; e.g., the local proxy at `localhost:20128`). No model or dimension values are spec-mandated; placeholders marked (spec §32).

**AD-5 — Milestone labeling.**
Spec §21 defines exactly **five** Phase 1 milestones (M1–M5; no M0/M6 in the spec — verified). This plan adds two plan-level labels: **M0** (environment/setup, pre-work) and **M6** (T13/T14 + close-out). Mapping to spec milestones is 1:1 for M1–M5.

---

## 3. Milestones, tasks, files, tests

### M0 — Environment & Integration Setup (plan-level; not a spec milestone)

| # | Item | Artifacts |
|---|---|---|
| 0.1 | Housekeeping: restore deleted `implementation_plan.md` (or leave; record), create branch `phase1-part1-ppb` from `origin/part2-ingestion-delivery` | git |
| 0.2 | Dependency step in `scripts/setup.sh` (`npm install --save pg neo4j-driver ioredis` in `vscodium/vscode`); esbuild external smoke test | `scripts/setup.sh` |
| 0.3 | Dev infra | `infra/ppb/docker-compose.yml`, `infra/ppb/README.md` |
| 0.4 | Config module + feature flags (all values placeholder-marked per §26/§32) | `node/ppb/config.ts` |
| 0.5 | Test scaffolding; verify `test-node` collects `node/test/ppb/*.test.ts` | `node/test/ppb/config.test.ts` |
| 0.6 | Engine wiring skeleton: init/shutdown hooks, DI points, MCP server registration behind `ppbEnabled` — inert, zero behavior change | `node/codeMindAgentEngineMain.ts` |

Exit: infra up, tests collected, workbench compiles, flags off, existing tests green.

### M1 — Contracts & Data Model (spec M1) — tasks P1-T01, P1-T02

| Task | Deliverables | Tests |
|---|---|---|
| P1-T01 Ontology | `node/ppb/ontology.ts`; `docs/ppb/schema.md` (node labels, relationship types, constraints — spec §6) | none required (spec M1: no runtime tests) |
| P1-T02 Schemas & migrations | `node/ppb/storage/migrations/*.sql` (memory, embeddings/pgvector, decisions, events, conflicts, versions, telemetry — spec §9); `node/ppb/storage/migrate.ts`; Neo4j constraint bootstrap | migration dry-run lint (optional) |
| IF contracts | `docs/ppb/if-contracts.md` — IF-1…IF-12 (spec §18) mapped to the real Part 2 contracts (§1.3 table) | — |
| Traceability | `docs/ppb/traceability.md` seed | — |

Exit: schema + migrations reviewed; IF-1…IF-12 documented and agreed; traceability seed (spec §21 M1).

### M2 — Ingestion Path (spec M2) — stub extraction

| Item | Deliverables | Tests |
|---|---|---|
| Sink plumbing | `node/ppb/sink.ts` implementing `ISegmentSink` (`ingest`, `scheduleBackfill`); pipeline scaffold (filter → extraction boundary) | `node/test/ppb/sink.test.ts` |
| Stub extractor | `node/ppb/extraction/stubExtractor.ts` — returns **empty fact set** (spec §21 M2; source §7.2) | unit |
| Engine wiring | `setSink(real)` when enabled, else `NoopSegmentSink`; retriever may remain Null/stub (spec §21 M2 allows stub IF-5/IF-7 input for development) | extend `node/test/ppbEndToEnd.test.ts` |
| Latency guard | no chat-turn latency regression (placeholder budget, spec §26) | smoke test |

Exit: normalized segments reach the extraction boundary end-to-end; no chat-turn latency regression; all existing tests green.

### M3 — Knowledge Core (spec M3; Part 1 leads) — tasks P1-T03, T04, T05, T06, T07, T12

| Task | Deliverables | Tests |
|---|---|---|
| P1-T03 Graph repository | `node/ppb/graph/graphRepo.ts` (Neo4j repository API — IF-11 read/write, expansion queries); `node/ppb/storage/neo4j.ts` | unit (fakes) + gated integration |
| P1-T04 Extraction | `node/ppb/extraction/extractor.ts` — prompt + structured-output schema for the six categories (spec §7); OpenAI-compatible client | unit + gated integration |
| P1-T05 Validation | `node/ppb/extraction/validate.ts` — schema validation, retry, metadata enrichment | unit |
| P1-T06 Dedup | `node/ppb/extraction/dedup.ts` (spec §8) | unit |
| P1-T07 Embeddings | `node/ppb/embeddings/embedder.ts` (BGE-M3 client, batching); `node/ppb/embeddings/vectorStore.ts` (pgvector upsert; index choice = OD-1) | unit + gated integration |
| P1-T12 Decision & event memory | `node/ppb/decisions/decisionMemory.ts` (spec §10/§11) | unit |
| Real extraction replaces stub (flag) | writes to graph + vector store | extraction accuracy harness (placeholder baseline) |
| Adapter flip | `node/orchestration/toolAdapters/projectBrainAdapter.ts` → `available:true` with facts/decisions; **update `node/test/toolAdapters.test.ts` drift assertions in the same change** | drift tests |
| Isolation | cross-project scoping in repository API (spec §24) | scoping tests |

Exit: extraction accuracy measured (placeholder); facts queryable through IF-11; adapter live; no regressions.

### M4 — Retrieval & Injection (spec M4) — tasks P1-T08, P1-T09

| Task | Deliverables | Tests |
|---|---|---|
| P1-T08 Hybrid retrieval | `node/ppb/retrieval/hybrid.ts` (vector + graph expansion + fusion, spec §15) | unit + gated integration |
| P1-T09 Ranking | `node/ppb/retrieval/ranker.ts` (seven signals, spec §16; top-k default = placeholder) | unit |
| Retriever wiring | `node/ppb/retrieval/retriever.ts` behind engine `executeRetrieval` path; Redis cache (IF-12, spec §15) | `retrievalRequest`-level tests |
| Injection E2E | real `[PPB CONTEXT]` blocks; token budget honored (`maxInjectionTokens` — placeholder) | injection tests |
| Headroom check | confirm injection passes through Headroom as the **final stage** on every request (spec §21 M4) | extend `headroomLayer`/orchestration tests |
| Precision baseline | precision@k harness — placeholder pending measurement | harness + recorded baseline |

Exit: IF-6 answers IF-5/IF-7; ranked memories injected into real prompts via Headroom; precision@k baseline recorded; token budget respected.

### M5 — Conflict Loop & Hardening (spec M5) — tasks P1-T10, P1-T11

| Task | Deliverables | Tests |
|---|---|---|
| P1-T10 Conflict detection | `node/ppb/conflict/detector.ts` (contradiction candidates + per-category rules, spec §12); IF-3 request | conflict regression suite (spec §12.11) |
| P1-T11 Versioning | `node/ppb/versioning/versionStore.ts` (Active/Archived/Superseded, spec §13); IF-4 handling | versioning tests (spec §13.10) |
| Transport integration | speak `ConflictReport` (`conflictTransport.ts`) — transport simulated; Part 3 dialog out of scope | loop E2E (simulated dialog) |
| Isolation & hardening | cross-project leak tests (spec §24) | E2E isolation |
| Full E2E | real components through `ppbEndToEnd` (infra-gated) | E2E suite |

Exit: conflict loop E2E (transport simulation); regression suite green; no cross-project leakage; demo path works.

### M6 — Reasoning, API Publication & Close-out (plan-level) — tasks P1-T13, P1-T14

| Task | Deliverables | Tests |
|---|---|---|
| P1-T13 Long-term reasoning | `node/ppb/reasoning/reasoner.ts` (query layer + answer composition with citations, spec §17; IF-8/IF-9) | unit + gated integration |
| P1-T14 Weight profile & APIs | ranking weight profile exposure; internal API publication (IF-11 final; spec §16) | unit + contract tests |
| Close-out | spec §22 acceptance suite complete; §34 DoD checklist; full `docs/ppb/traceability.md`; final E2E demo through editor + agent (MCP `project_brain` live: recall/store/list) | acceptance run |

Exit: reasoning with citations; weight profile exposed; acceptance + DoD signed off.

---

## 4. File map (new + edited)

```
vscodium/src/stable/src/vs/workbench/contrib/codemindAgent/
  node/ppb/
    config.ts                     types.ts                ontology.ts
    telemetry.ts                  sink.ts                 index.ts
    storage/    pg.ts  migrate.ts  neo4j.ts  redis.ts  migrations/*.sql
    graph/      graphRepo.ts
    extraction/ extractor.ts  validate.ts  dedup.ts  stubExtractor.ts
    embeddings/ embedder.ts  vectorStore.ts
    retrieval/  hybrid.ts  ranker.ts  retriever.ts
    conflict/   detector.ts  confirm.ts
    versioning/ versionStore.ts
    decisions/  decisionMemory.ts
    reasoning/  reasoner.ts
  node/test/ppb/                *.test.ts (+ gated *.integration.test.ts)
  node/test/ppbEndToEnd.test.ts (extended)

Edited (existing):
  node/codeMindAgentEngineMain.ts                       (M0/M2/M4/M6 wiring)
  node/orchestration/toolAdapters/projectBrainAdapter.ts (M3 flip)
  node/test/toolAdapters.test.ts                        (M3 drift updates)
  scripts/setup.sh                                      (M0 deps step)

New (non-source):
  infra/ppb/docker-compose.yml  infra/ppb/README.md
  docs/ppb/if-contracts.md  docs/ppb/schema.md  docs/ppb/traceability.md
  CODEMIND_PHASE1_PART1_IMPLEMENTATION_PLAN.md  CODEMIND_PHASE1_PART1_PLAN_VALIDATION.md

Untouched unless fallback path chosen (AD-1): claude-code/src/** (canonical reference)
```

---

## 5. Testing strategy (spec §23)

1. **Unit** — pure logic with fakes; `node/test/ppb/*.test.ts`; mocha tdd via existing `test-node` infra.
2. **Integration** — real Postgres/Neo4j/Redis; gated by env (`PPB_TEST_INFRA=1`); skipped by default; no invented perf assertions.
3. **E2E** — extended `ppbEndToEnd.test.ts`; real sink/retriever when infra present, Null-path tests stay green.
4. **Contract/drift** — `toolAdapters.test.ts` updated in the same change as the adapter flip (M3).
5. **Isolation** — cross-project scoping (M3 repo API, M5 E2E) per spec §24.
6. **Degradation** — retrieval/sink failure must never break a chat turn (spec §24); Null/Noop fallbacks retained and tested.
7. **Telemetry** — IF-10 assertions (spec §27): no secrets/PII in logs.

---

## 6. Open decisions register (spec §32) — all non-blocking, placeholder-marked

| ID | Decision | Resolve at |
|---|---|---|
| OD-1 | pgvector index type (HNSW vs IVFFlat) + params | T07 |
| OD-2 | Embedding model pin + dimension confirmation (BGE-M3) | T07 |
| OD-3 | top-k defaults, similarity thresholds, conflict confidence, decay | T08/T09/T10 |
| OD-4 | Adapter `TIMEOUT_MS` (currently 50) — revisit with real measurements | M4 |
| OD-5 | Retrieval timeout (code default 800 ms) — revisit with real measurements | M4 |
| OD-6 | Extraction prompt/model choice (config-driven) | T04 |
| OD-7 | Backfill scope policy details (`scheduleBackfill`) | M3 |

Rule: every placeholder is labeled in code + recorded in `docs/ppb/traceability.md`; changes logged per spec §33.

## 7. Risks & mitigations

| ID | Risk | Mitigation |
|---|---|---|
| R1 | esbuild bundling of `pg` (dynamic requires) | M0 smoke test; mark `pg-native` external if needed |
| R2 | `npm ci` lockfile constraint in `prepare_vscode.sh` | install deps as a setup.sh step (AD-2); never hand-edit the lockfile |
| R3 | New tests not collected by mocha | naming/paths match verified glob (`node/test/**/*.test.ts`) |
| R4 | MCP tool naming vs Part 2's `ProjectBrainTool` | canonical src kept; ops/env-gates mirrored; documented |
| R5 | DB unavailable during demo | graceful degradation (Null/Noop retained); compose healthchecks |
| R6 | Turn-path latency | stub first (M2); async ingest; synchronous retrieval budget placeholder-measured |
| R7 | T13/T14 + close-out scope | parallelizable after M4; M6 explicitly separated |

## 8. Traceability seed (spec § → artifact)

| Spec | Task | Artifact | Test | Milestone |
|---|---|---|---|---|
| §6 | T01 | `ontology.ts`, `docs/ppb/schema.md` | — | M1 |
| §9 | T02 | `storage/migrations/*`, `migrate.ts` | lint | M1 |
| §18 | — | `docs/ppb/if-contracts.md` | — | M1 |
| §7.2 | — | `stubExtractor.ts`, `sink.ts` | E2E | M2 |
| §7/§8 | T04/T05/T06 | `extraction/*` | unit/integration | M3 |
| §9/§6 | T03 | `graphRepo.ts` | unit/integration | M3 |
| §14 | T07 | `embeddings/*` | unit/integration | M3 |
| §10/§11 | T12 | `decisionMemory.ts` | unit | M3 |
| §15 | T08 | `hybrid.ts` | unit/integration | M4 |
| §16 | T09/T14 | `ranker.ts` + profile | unit | M4/M6 |
| §12 | T10 | `conflict/detector.ts` | regression | M5 |
| §13 | T11 | `versionStore.ts` | unit | M5 |
| §17 | T13 | `reasoner.ts` | unit/integration | M6 |
| §23/§24/§27 | — | test suites | — | all |

Full living traceability: `docs/ppb/traceability.md` (created M1, maintained through M6).

## 9. Change management (spec §33)

- Amendments to this plan are versioned here; the spec always wins on conflict.
- Deviations discovered during implementation are recorded in the validation report lineage + `docs/ppb/traceability.md`.
- Status: v1.0 → v1.1 after validation (corrections C1–C9 in the validation report). **APPROVED** — see validation report.
