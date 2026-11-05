# CodeMind — Phase 1 Part 1 — Plan Validation Report

| Field | Value |
|---|---|
| Subject | `CODEMIND_PHASE1_PART1_IMPLEMENTATION_PLAN.md` v1.1 |
| Validated against | `phase_1.md` (authoritative spec, 1714 lines, §1–§34) |
| Date | 2026-09-21 |
| Method | (1) full-text cross-check of the plan against every spec section; (2) repository + runtime spikes for the blocking architectural questions only (AD-1, AD-2); (3) evidence-based corrections applied to the plan before verdict |
| Scope note | Validation + spikes only. **No product code, no M0/M1 implementation.** |

---

## 1. Validation matrix (spec → plan coverage)

| Spec | Requirement checked | Plan coverage | Status |
|---|---|---|---|
| §3 | Part 1 scope: extraction, graph, decision memory, conflict, versioning, embeddings, hybrid retrieval, ranking, reasoning, storage, internal APIs; boundaries vs Parts 2/3 | §3 M1–M6 task map; sockets §1.3 | Covered |
| §4 | Three paths (storage / retrieval / reasoning); stub-first M2 | AD-1…AD-5; M2 | Covered |
| §6 | Knowledge graph model, node/relationship types, constraints | T01, T03 | Covered |
| §7 | Extraction engine, six categories, IF-1 input, IF-2 output, M2 empty-fact-set stub | T04/T05/T06 + `stubExtractor.ts` (C2) | Covered |
| §8 | Deduplication | T06 | Covered |
| §9 | PostgreSQL+pgvector + Neo4j storage model, migrations | T02, AD-3, `infra/ppb` | Covered |
| §10 | Decision memory model | T12 | Covered |
| §11 | Events & evolution | T12 | Covered |
| §12 | Conflict detection + per-category rules + §12.11 tests | T10 + M5 regression suite | Covered |
| §13 | Memory versioning (Active/Archived/Superseded) + §13.10 tests | T11 + M5 | Covered |
| §14 | BGE-M3 embeddings via OpenAI-compatible API | T07, AD-4 | Covered |
| §15 | Hybrid retrieval (vector + graph + fusion), caching | T08, Redis (IF-12) | Covered |
| §16 | Seven-signal ranking; weight profile | T09, T14 | Covered |
| §17 | Long-term reasoning layer, citations, IF-8/IF-9 | T13 | Covered |
| §18 | IF-1…IF-12 internal API layer | `docs/ppb/if-contracts.md` (M1); implementations mapped to real Part 2 contracts (§1.3) | Covered |
| §19 | Tasks P1-T01…T14 | All 14 mapped to files/tests/milestones | Covered |
| §20 | Dependency order; write-path correction (T10/T11 independent of T08/T09); T13 after T03/T08/T12; T14 last | §3 milestone ordering (C3) | Covered |
| §21 | Milestones M1–M5 exactly; M2 stub exit; M4 Headroom final stage; M5 conflict loop + isolation | M1–M5 map 1:1; M0/M6 plan-level labels (C1, C7, C8) | Covered |
| §22 | Acceptance criteria A1–A10 | M6 close-out + per-milestone exits | Covered |
| §23 | Unit / integration / E2E testing | §5 strategy (convention verified, S3) | Covered |
| §24 | Error handling: graceful degradation; cross-project isolation | §5 items 6, 5; M3/M5 isolation tests | Covered |
| §25 | Security: secrets, parameterized queries, least privilege | AD-3/AD-4 config handling; §5 telemetry rule | Covered |
| §26 | Performance: **no invented numbers**; placeholders marked | Number policy (header) + OD register (C5) | Covered |
| §27 | Logging / IF-10 telemetry | `telemetry.ts`; §5 item 7 | Covered |
| §28/§29 | Agent rules: repo-inspection before claims; extend-not-duplicate | Plan header; AD-1/AD-2 reuse of existing sockets | Covered |
| §30 | Traceability | §8 seed + living doc | Covered |
| §31 | Glossary/terminology consistency | Plan uses spec terms (projectId, segment, fact, decision, version states) | Covered |
| §32 | Open decisions register | §6 OD-1…OD-7, all placeholder-marked | Covered |
| §33 | Change management | §9 | Covered |
| §34 | Definition of Done | M6 close-out checklist | Covered |

No uncovered spec requirement remains.

---

## 2. Spike log (blocking questions only)

### S1 — AD-1: agent-side activation mechanism — **RESOLVED**

Evidence:
1. Runtime import of the exact installed SDK: `node -e "import('.../claude-agent-sdk/sdk.mjs')..."` → `EXPORTS: AbortError, EXIT_REASONS, HOOK_EVENTS, createSdkMcpServer, query, tool, unstable_v2_*` — **in-process MCP servers are available in this build**.
2. `sdk.mjs` spawns its bundled agent: `pathToClaudeCodeExecutable = join4(dirname2, "cli.js")` (L8590) — the runtime agent is the SDK's `cli.js`, not `claude-code/src`.
3. `cli.js` supports MCP servers (contains `mcpServers`).
4. The engine passes no executable override and no MCP config today; grep of the installed bundle for `ProjectBrain|CODEMIND_PPB` → **zero hits** — Part 2's `src` tool registration is not live at runtime.
5. Existing patch pattern (`claude-code/patches/read-file-state-path-normalization.mjs`) is exact-string surgery on the minified bundle — suitable for small fixes, not whole-tool injection.

Decision: engine-hosted **in-process MCP server** (`createSdkMcpServer`) exposing `project_brain` (ops `recall|store|list` mirroring `ProjectBrainLogic`), backed by Part 1 core in the engine process. Fallbacks documented (bundle rebuild via bun — present at `C:\Users\Dell\.bun\bin\bun.exe`; or bundle patch) — neither selected, neither required.

### S2 — AD-2: dependency/build placement — **RESOLVED (approach fixed; M0 closes details)**

Evidence:
1. Overlay mechanics: `setup.sh` does `cp -rp src/stable/* vscode/`; overlay contains only `resources/`, `src/`, `tsconfig.json` — **no `package.json`** (would overwrite the checkout's if added).
2. Checkout install uses `npm ci` (`vscodium/prepare_vscode.sh` L215/217) — lockfile-exact; dep additions must be installed into the checkout via a setup step, not by hand-editing the lockfile.
3. `vscodium/patches/user/` exists (VSCodium user-patch convention) — noted as an alternative, not needed.
4. All three deps (`pg`, `neo4j-driver`, `ioredis`) are pure JS — no native compilation.

Decision: add a `scripts/setup.sh` step installing the three deps into `vscodium/vscode` (`npm install --save`). M0 closes: exact command + esbuild externalization check (`pg-native` external if required). Not architecture-blocking.

### S3 — Test infrastructure convention — **CONFIRMED**

Evidence: `vscodium/vscode/package.json` → `"test-node": "mocha test/unit/node/index.js --delay --ui=tdd --timeout=5000 --exit"`; runner glob `**/test/**/*.test.js` under `out/`. Part 2's `node/test/*.test.ts` convention matches; Part 1 uses `node/test/ppb/*.test.ts`.

### S4 — Milestone structure — **CORRECTED IN PLAN**

Evidence: spec §21 (L1341–1383) defines exactly M1–M5; grep for `M0|M6` in the spec → no matches. Plan v1.1 labels M0 (setup) and M6 (T13/T14 + close-out) as **plan-level only**, with explicit 1:1 mapping for M1–M5. M2's "stub extraction path returning an empty fact set" requirement (spec §21, source §7.2) was added as an explicit M2 deliverable.

### S5 — Task dependency order — **CORRECTED IN PLAN**

Evidence: spec §20 — T01→T02→T03; T04–T06 after T02/T03; T07 parallel to T04 after T02/T03; T08 after T07; T09 after T08; T10/T11 on the write path (do not depend on T08/T09); T12 parallel to T04–T06 after T01/T03; T13 after T03/T08/T12; T14 last. Plan ordering matches.

---

## 3. Corrections applied to the plan during validation

| # | Correction |
|---|---|
| C1 | Milestone labels reconciled with spec: M1–M5 = spec milestones; M0/M6 declared plan-level (AD-5) |
| C2 | M2 stub-extraction (empty fact set) added as explicit deliverable (spec §21 M2) |
| C3 | T10/T11 write-path ordering fixed (not dependent on T08/T09) per spec §20 |
| C4 | Test convention fixed to verified infra (`node/test/ppb/*.test.ts` → mocha via `test-node`) |
| C5 | Numbers policy enforced: 800 ms / 50 ms / 2000 tokens etc. labeled as code-side placeholders pending measurement (spec §26/§32) — not spec requirements |
| C6 | Adapter flip point (M3) + drift-test update choreography documented (`toolAdapters.test.ts` updated in the same change) |
| C7 | Headroom final-stage verification added to M4 exit (spec §21 M4) |
| C8 | Cross-project isolation tests placed at M3 (repo scoping) + M5 (E2E) per spec §24 |
| C9 | AD-1 resolved: agent-side activation = in-process SDK MCP server (evidence S1); Part 2's `src` tool kept as canonical reference; fallbacks documented |

---

## 4. Non-blocking open items (deferred per spec §32)

OD-1 pgvector index type/params (T07) · OD-2 embedding model/dimension pin (T07) · OD-3 top-k/thresholds/decay (T08/T09/T10) · OD-4 adapter `TIMEOUT_MS` revisit (M4) · OD-5 retrieval timeout revisit (M4) · OD-6 extraction prompt/model (T04) · OD-7 backfill scope policy (M3). All must be labeled placeholders in code and recorded in traceability; none blocks plan approval.

---

## 5. VERDICT

**PLAN APPROVED (v1.1).**

The implementation plan is validated against `phase_1.md` with no uncovered requirements. Both blocking architectural questions are resolved by direct repository/runtime evidence (S1, S2); remaining items are explicitly deferred per spec §32 and do not affect architecture.

**Conditions (non-blocking, to close inside M0):**
1. Dependency install step finalized in `scripts/setup.sh` + esbuild externalization check.
2. `test-node` collection of `node/test/ppb/*.test.ts` verified after first compile.

**Gate status:** per owner instruction, M0/M1 implementation was not started before this report; the approval gate condition is now satisfied. Implementation may begin on owner's go.

---

*Validation performed read-only against the repository at `origin/part2-ingestion-delivery` (`b65ef3487`) with working tree on `feature/aristotle-pet`. No files were modified except this report and the plan document.*
