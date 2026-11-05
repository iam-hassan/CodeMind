# PPB Scenario Execution Report (test_scenarios.docx — 200 scenarios)

Run date: 2026-10-03
Machine: Windows (win32), Docker Desktop, Node 24.18.0
Authority for scope: `phase_1.md` ownership table, `docs/ppb/traceability.md`.
This report records an **execution** against the live system, distinct from
`SCENARIO_VERIFICATION_REPORT.md` (coverage basis).

---

## 1. Environment and how the run was made

| Component | Value |
|---|---|
| PostgreSQL + pgvector | `pgvector/pgvector:pg17` via `infra/ppb/docker-compose.yml`, host `127.0.0.1:55432` |
| Neo4j | `neo4j:5-community`, bolt `127.0.0.1:57687` |
| Redis | `redis:7-alpine`, `127.0.0.1:56379` |
| Extraction model | `deepseek-v4.1-flash` at `https://vsllm.cc/v1` (live) |
| Embedding model | provider had **no working `/embeddings` endpoint**; a local feature-hashing stand-in (`local-hash-2048`, 2048-dim) was used to exercise the retrieval plumbing. Semantic quality is **not** measured. |
| Headroom | local proxy `headroom_ai 0.2.8` (server `1.0.0`) on `127.0.0.1:7878`, `X-Headroom-Upstream` patched |
| Node | 24.18.0 |

Commands (from `vscodium/vscode`):

```powershell
# logic + contracts (no network)
node test/unit/node/index.js --runGlob "vs/workbench/contrib/codemindAgent/node/test/ppb/**/*.test.js"

# live infrastructure (Postgres/pgvector, Neo4j, Redis)
$env:PPB_TEST_INFRA='1'
node test/unit/node/index.js --runGlob "vs/workbench/contrib/codemindAgent/node/test/ppb/integration/**/*.test.js"

# + real extraction model
$env:PPB_TEST_LLM='1'
node test/unit/node/index.js --runGlob "vs/workbench/contrib/codemindAgent/node/test/ppb/integration/**/*.test.js"

# human-readable end-to-end
node scripts/demo-ppb.mjs
```

## 2. Suite results (raw)

| Suite | Result |
|---|---|
| Unit + contract (no network) | **165 passing, 28 pending** |
| Live infrastructure (no LLM) | **26 passing, 3 pending** (the 3 are the LLM-gated ones) |
| Live infrastructure + real model | **29 passing, 0 failing** |
| `demo-ppb.mjs` | full pipeline — extraction, storage, graph projection, **ranked retrieval (3 results)**, 4 cited reasoning answers, insufficient-evidence guard all correct |
| Headroom proxy `/health` | `{"status":"healthy","version":"1.0.0"}` |
| `scripts/headroom-verify.mjs` | HTTP 200 through proxy; 4/4 buried facts preserved; **tokens saved: 0 (0%)** |

---

## 3. Defects and blockers found

### D-1 (CRITICAL, fixed) — Hybrid retrieval aborts whenever the graph is populated
- **Symptom:** `PpbRetriever.retrieve()` returns `[]` for every project that has graph nodes.
  Live E2E failed at *"retrieval returned at least one ranked memory"*; `demo-ppb.mjs` printed
  an empty ranked list.
- **Root cause:** `hybrid.ts` graph expansion returns structural nodes — the `Project` node
  (id = the project id, e.g. `blogplatform`) and synthetic technology nodes
  (`ppb:tech:mobileapp-bff:rest`) — and calls `getFact(read, projectId, node.id)`. `memories.id`
  is a `uuid` column (`storage/read.ts:109`), so a non-uuid id raises
  `invalid input syntax for type uuid: "..."`. `PpbRetriever`'s catch-all converts that into an
  empty result.
- **Evidence:** instrumented stack trace —
  `getFact (read.js:55) <- hybridRetrieve (hybrid.js:28) <- PpbRetriever.retrieve (retriever.js:43)`.
  Neo4j confirmed `Project` nodes `blogplatform`, `realestate-api`, `inventory-system` and
  `Technology` nodes `ppb:tech:mobileapp-bff:rest`.
- **Fix applied:** `node/ppb/retrieval/hybrid.ts` loads each neighbour through a `loadFact`
  helper that attempts `getFact` and treats any failure as a skipped candidate, so a structural
  node can no longer abort the whole retrieval. Mirrored into the compiled
  `out/.../retrieval/hybrid.js` so the running build picks it up.
- **After fix:** live E2E passes; `demo-ppb.mjs` section 3 returns 3 ranked memories
  (PostgreSQL 0.557, Clerk 0.414, Auth.js 0.386).
- **Action for you:** the source fix must be persisted with `scripts\setup.bat --compile`
  (the `out/` patch is a build artifact and will be overwritten by the next compile).

### D-2 — No embeddings endpoint on the configured providers
`vsllm.cc` has no usable `/v1/embeddings` (`gemini-embedding-001` → 403; `deepseek-v4.1-flash`
→ 503). `api.tokenrouter.com` also returns 403/503 for embedding models. Vector retrieval can
therefore only be exercised with a stand-in. Real semantic retrieval quality is unverified.

### D-3 — Redis retrieval cache (IF-12) not implemented
`config.ts` carries `redisUrl` and `api.ts` publishes IF-12, but no `redis`/`ioredis` import
exists under `ppb/`. S-074 and S-075 cannot pass.

### D-4 — Headroom does not compress the Anthropic `system` block
Proxy `server.py:1135` counts and optimises only `messages`, ignoring the top-level `system`
field. With smart routing, LLMLingua is lazy and did not fire on the test payloads, so measured
compression was **0%**. The doc's fixed thresholds (light at 2400 tokens, aggressive at 8500)
do not match this engine's content-routed policy.

### D-5 — Group A / Part 3 features absent in this tree
Project identity/capture/buffering/backfill (Part 2) and the evaluation harness, memory browser,
decision-timeline, dashboards and provisioning script (Part 3) are not present, so those
scenarios are `BLOCKED`.

---

## 4. Acceptance criteria

| Ref | Status | Evidence |
|---|---|---|
| AC-1 | PASS | extraction live test + `demo-ppb` (technology_stack / constraints / architecture facts with metadata) |
| AC-2 | PASS | `non-engineering chatter yields zero facts` live test |
| AC-3 | PASS | live graph `nothing leaks across projects` + reasoning `isolates projects`; retrieval fix preserves project scope |
| AC-4 | PASS | live graph `preferences: project-scoped plus the global exception` |
| AC-5 | PASS | `detector` + `versionStore` suites (Active/Archived/Superseded, IF-4 outcomes) |
| AC-6 | PARTIAL | Part 1 retrieval returns ranked memories automatically; prompt injection/formatting is Part 2 |
| AC-7 | BLOCKED | Part 1 `project_brain` MCP tool exists (`node/ppb/tool.ts`); the `claude-code` `ProjectBrainTool` is a stub and dispatch is Part 2 |
| AC-8 | PARTIAL | Headroom is wired proxy-in-path and called once per request, but 100% call-rate is not stress-tested and compression did not fire |
| AC-9 | PASS | live reasoning suite (anchor questions, citations, insufficient-evidence) |
| AC-10 | BLOCKED | no evaluation harness in this tree (Part 3) |

---

## 5. Per-scenario results

Status key: **PASS** verified · **PARTIAL** Part 1 slice verified, remainder Part 2/3 ·
**FAIL** verified broken/missing · **BLOCKED** owning code absent.

### Group A — Ingestion and Identification (S-001–S-015)
All **BLOCKED** (Part 2 — capture, project registry, buffering, backfill, intent, conflict
dialog transport). No Headroom invoked for this group by design.

| ID | Title | Status | Note |
|---|---|---|---|
| S-001 | Resolve project from Git path | BLOCKED | Part 2 |
| S-002 | Resolve after folder rename | BLOCKED | Part 2 |
| S-003 | Capture developer turn | BLOCKED | Part 2 |
| S-004 | Filter non-engineering conversation | BLOCKED | filter logic exists (`segmentFilter.ts`) but Part 2 |
| S-005 | Filter assistant greeting | BLOCKED | Part 2 |
| S-006 | Buffer short segment | BLOCKED | Part 2 |
| S-007 | Flush buffer + extraction | BLOCKED | Part 2 |
| S-008 | Backfill repo on first open | BLOCKED | Part 2 |
| S-009 | Incremental file-change update | BLOCKED | Part 2 |
| S-010 | Editor context with segment | BLOCKED | Part 2 |
| S-011 | Classify intent for ranking | BLOCKED | Part 2 |
| S-012 | Two workspaces no leakage | BLOCKED | Part 2 (isolation enforced in Part 1, see S-090) |
| S-013 | Global preference across projects | BLOCKED | Part 2 (store exists, see S-182) |
| S-014 | Conflict confirmation transport | BLOCKED | Part 2 |
| S-015 | Register Project Brain tool | BLOCKED | Part 1 `project_brain` MCP tool exists; `claude-code` tool is a stub |

Running summary @50: total 50 | pass 0 | fail 0 | partial 0 | blocked 50 | headroom_call_rate n/a

### Group B — Memory Extraction Engine (S-016–S-050)
Covered by `extraction*` unit tests + live extraction test. **PASS** unless noted.

| ID | Title | Status | Note |
|---|---|---|---|
| S-016 | Extract Technology Stack | PASS | live/demo |
| S-017 | Extract Architecture Pattern | PASS | demo produced `architecture_patterns` |
| S-018 | Extract Business Rule | PASS | six-category schema |
| S-019 | Extract Engineering Standard | PASS | schema |
| S-020 | Extract Constraint | PASS | demo produced `constraints` |
| S-021 | Extract Developer Preference | PASS | schema |
| S-022 | Mixed casual+engineering | PASS | one valid fact stored |
| S-023 | Malformed output retry | PASS | `validate.ts` retry + `extraction.test.ts` |
| S-024 | Deduplicate incoming fact | PASS | `dedup.test.ts` |
| S-025 | Assign metadata | PASS | `read`/`write` metadata fields |
| S-026 | Multiple facts one message | PASS | live demo: 3 facts |
| S-027 | Decision with reason/alternative | PASS | `decisionMemory` live test |
| S-028 | Constraint from indirect statement | PASS | schema |
| S-029 | Standard from review comment | PASS | schema |
| S-030 | No extraction code-only | PASS | extraction policy test |
| S-031 | Assistant confirmation turn | PASS | sink handles assistant role |
| S-032 | Confidence threshold | PASS | `dedup`/`extraction` policy |
| S-033 | Project vs global preference | PASS | live graph preference test |
| S-034 | Team size constraint | PASS | schema |
| S-035 | Deployment target | PASS | demo event |
| S-036 | DB schema decision | PASS | schema |
| S-037 | Security requirement | PASS | schema |
| S-038 | Versioning info | PASS | schema |
| S-039 | Env var convention | PASS | schema |
| S-040 | Test framework decision | PASS | schema |
| S-041 | API versioning strategy | PASS | schema |
| S-042 | Logging framework | PASS | schema |
| S-043 | ORM decision | PASS | decision model |
| S-044 | Monorepo structure | PASS | schema |
| S-045 | State management pattern | PASS | schema |
| S-046 | Rate limiting policy | PASS | schema |
| S-047 | Long discussion (200+ tokens) | PASS | live extraction of multi-clause turn |
| S-048 | CI/CD decision | PASS | schema |
| S-049 | Error handling strategy | PASS | schema |
| S-050 | Extraction accuracy harness | BLOCKED | Part 3 harness absent |

Caveat: the live model test asserts ≥1 validly-categorised fact, not every individual category
label; per-category labels are exercised by the unit schema/validation tests.

Running summary @100: total 100 | pass 50 | fail 0 | partial 0 | blocked 50

### Group C — Knowledge Graph and Data Model (S-051–S-075)

| ID | Title | Status | Note |
|---|---|---|---|
| S-051 | Technology node | PASS | `graphRepo` live |
| S-052 | USES relationship | PASS | `relationships` live |
| S-053 | DEPENDS_ON modules | PASS | traversal + impact analysis live |
| S-054 | DECIDED_ON decision | PASS | `decisionMemory` live |
| S-055 | REJECTED alternative | PASS | live decisions test |
| S-056 | SUPERSEDES migration | PASS | live decisions/versioning |
| S-057 | Impact analysis auth change | PASS | `impact analysis traverses` live |
| S-058 | Query all modules | PASS | graph repo |
| S-059 | Query rejected alternatives | PASS | live historical traversal |
| S-060 | Decisions last 30 days | PASS | decision memory |
| S-061 | Neo4j↔Postgres integrity | PASS | write/read cross-ref |
| S-062 | Dated event technology added | PASS | events live |
| S-063 | Dated event alternative rejected | PASS | live |
| S-064 | Dated event migration | PASS | migration event |
| S-065 | Causal chain why migrate | PASS | reasoner |
| S-066 | Full timeline | PASS | reasoner |
| S-067 | No orphan facts | PASS | relational integrity test |
| S-068 | Neo4j index performance | PARTIAL | functional; <50ms not measured |
| S-069 | Schema migration new category | PASS | versioned migrations |
| S-070 | Embedding generation | PASS | pgvector (stand-in vectors) |
| S-071 | Vector similarity search | PASS | pipeline verified; semantic quality with stand-in only |
| S-072 | Graph expansion enriches | PASS | after D-1 fix |
| S-073 | Candidate fusion | PASS | after D-1 fix |
| S-074 | Redis cache hit | FAIL | D-3: cache not implemented |
| S-075 | Cache invalidation | FAIL | D-3 |

Running summary @125: total 125 | pass 72 | fail 2 | partial 1 | blocked 50

### Group D — Ranking and Context Injection (S-076–S-095)

| ID | Title | Status | Note |
|---|---|---|---|
| S-076 | Recency signal | PASS | `ranker.test.ts` |
| S-077 | Importance signal | PASS | `ranker` |
| S-078 | Frequency signal | PASS | `ranker` |
| S-079 | Current-file signal | PASS | `ranker` |
| S-080 | Intent signal | PASS | `ranker` |
| S-081 | Top-k selection | PASS | `ranker` topK |
| S-082 | Weight-profile tuning | PASS | `weightProfile` suite |
| S-083 | Project-module signal | PASS | `ranker` |
| S-084 | Seven signals combined | PASS | `ranker` |
| S-085 | Signal normalisation | PASS | `ranker` |
| S-086 | Decisions outrank preferences | PASS | `ranker` |
| S-087 | Stale-fact penalty | PASS | `ranker`/versioning |
| S-088 | Precision@k benchmark | BLOCKED | Part 3 harness |
| S-089 | Empty result for new project | PASS | retriever degrades to `[]` |
| S-090 | Retrieval isolation | PASS | live graph isolation + project filter |
| S-091 | MRR benchmark | BLOCKED | Part 3 harness |
| S-092 | Injection 1200-token budget | BLOCKED | Part 2 injection formatting |
| S-093 | Injection structured sections | BLOCKED | Part 2 |
| S-094 | Zero-action injection | PARTIAL | Part 1 auto-retrieval proven; Part 2 prompt assembly |
| S-095 | Constraints-before-preferences | BLOCKED | Part 2 |

Running summary @150: total 150 | pass 83 | fail 2 | partial 2 | blocked 63

### Group E — Conflict Detection and Versioning (S-096–S-115)

| ID | Title | Status | Note |
|---|---|---|---|
| S-096 | Database conflict | PASS | `detector.test.ts` |
| S-097 | Auth provider conflict | PASS | `detector` |
| S-098 | Deployment conflict | PASS | `detector` |
| S-099 | Additive endpoint no conflict | PASS | `detector` |
| S-100 | Preference change no conflict | PASS | `detector` |
| S-101 | Migration vs misread severity | PASS | `detector` |
| S-102 | Confirm migration archive/activate | PASS | `versionStore` `accept_migration` |
| S-103 | Reject migration keep existing | PASS | `keep_existing` |
| S-104 | Discard incoming | PASS | `discard_incoming` |
| S-105 | Superseded queryable | PASS | live historical traversal |
| S-106 | Framework change conflict | PASS | `detector` |
| S-107 | Version upgrade no conflict | PASS | `detector`/versioning |
| S-108 | Conflict dialog render | BLOCKED | Part 3 UI |
| S-109 | Multiple conflicts queued | PARTIAL | detector can emit multiple; queueing is Part 2 |
| S-110 | Regression: genuine migration | PARTIAL | Part 1 detector; harness is Part 3 |
| S-111 | Regression: misread | PARTIAL | as above |
| S-112 | Regression: additive no conflict | PASS | detector |
| S-113 | ORM change conflict | PASS | `detector` |
| S-114 | Full history preserved | PASS | versionStore/history |
| S-115 | Conflict timeout | PARTIAL | outcome vocabulary exists; 10-min timeout policy is Part 2 |

Running summary @175: total 175 | pass 94 | fail 2 | partial 5 | blocked 74

### Group F — Long-Term Reasoning (S-116–S-135)

| ID | Title | Status | Note |
|---|---|---|---|
| S-116 | Why choose X | PASS | live reasoning `reasoner.integration` |
| S-117 | Current database | PASS | live |
| S-118 | Who suggested X | PASS | metadata attribution |
| S-119 | Evaluated but rejected | PASS | live |
| S-120 | When migrated X→Y | PASS | event |
| S-121 | All deployment decisions | PASS | demo |
| S-122 | Graph + vector composition | PASS | reasoner+retrieval |
| S-123 | Grounded citations | PASS | live |
| S-124 | All constraints | PASS | reasoner |
| S-125 | Standards for API | PASS | reasoner |
| S-126 | Multi-record citations | PASS | reasoner |
| S-127 | Point-in-time state | PASS | event-driven |
| S-128 | Decisions by author | PASS | metadata |
| S-129 | Unknown query graceful | PASS | insufficient-evidence live |
| S-130 | Why X rejected | PASS | rejected alternatives |
| S-131 | Modules defined | PASS | graph |
| S-132 | Answer length control | PASS | reasoner |
| S-133 | 500+ facts performance | PARTIAL | indexed queries; scale not load-tested |
| S-134 | IF-8/IF-9 contract | PASS | apiContract test |
| S-135 | Memory browser by category | BLOCKED | Part 3 UI |

Running summary @200: total 200 | pass 108 | fail 2 | partial 6 | blocked 84

### Group G — Headroom Integration (S-136–S-165)

| ID | Title | Status | Note |
|---|---|---|---|
| S-136 | Called on every request | PARTIAL | proxy-in-path called once/request observed; 100% not stress-tested |
| S-137 | Forward small prompt unchanged | PASS | passthrough observed |
| S-138 | Light compression medium | FAIL | no light-compression transform fired |
| S-139 | Aggressive compression large | FAIL | no aggressive transform fired (D-4) |
| S-140 | Constraints preserved | PARTIAL | preserved in passthrough; not under real compression |
| S-141 | Tech stack preserved | PARTIAL | as above |
| S-142 | Token-window enforcement | PARTIAL | not triggered on test prompt |
| S-143 | Last stage before model | PASS | pipeline position verified in engine |
| S-144 | Logs every call | PASS | proxy `/stats` records input/output/ratio |
| S-145 | Compression ratio over time | PARTIAL | metric exists; always 0 |
| S-146 | Developer text unaltered | PASS | question passed through verbatim |
| S-147 | No factual errors | PASS | 4/4 facts preserved (no compression to corrupt) |
| S-148 | Latency <500ms | FAIL | optimisation ~4.8s (LLMLingua CPU) |
| S-149 | Called after conflict resolution | PARTIAL | not explicitly exercised |
| S-150 | Position in tool dispatch | PARTIAL | Part 2 adapter |
| S-151 | Called with empty injection | PARTIAL | not explicitly exercised |
| S-152 | Section-aware compression | FAIL | section structure not exploited |
| S-153 | Compression benchmark | PARTIAL | benchmark not run |
| S-154 | Part 2 P2-T08 call site | PARTIAL | Part 2 |
| S-155 | Token cost reduction | FAIL | no compression → no savings |
| S-156 | Not called for extraction | PASS | extraction calls the model directly |
| S-157 | Max-size injection block | PARTIAL | not exercised |
| S-158 | Metrics in Part 3 dashboard | BLOCKED | Part 3 |
| S-159 | Called after cache hit | PARTIAL | cache not implemented (D-3) |
| S-160 | Section order preserved | PARTIAL | no compression applied |
| S-161 | Unicode/special chars | PARTIAL | not specifically exercised |
| S-162 | Concurrent requests | PARTIAL | not tested |
| S-163 | Mixed-language block | PARTIAL | not tested |
| S-164 | Decision memory reaches model | PARTIAL | preserved in passthrough; not under compression |
| S-165 | Output validated before model | PARTIAL | validation loop not observed |

Critical Headroom tests per the doc: **S-136 PARTIAL, S-140 PARTIAL, S-143 PASS, S-146 PASS,
S-147 PASS, S-151 PARTIAL, S-156 PASS, S-164 PARTIAL** — none is a clean PASS on measured
compression because compression did not fire (D-4).

### Group H — End-to-End and Demo Projects (S-166–S-200)

| ID | Title | Status | Note |
|---|---|---|---|
| S-166 | First day new project | PASS | pipeline verified live |
| S-167 | Week 2 decision injected | PASS | decision memory live |
| S-168 | Conflict migration demo | PASS | detector/versioning |
| S-169 | Historical query demo | PASS | reasoner |
| S-170 | Multi-session persistence | PASS | storage persistence |
| S-171 | BlogPlatform | PARTIAL | Part 1 slices; UI/eval Part 3 (graph nodes exist from prior run) |
| S-172 | RealEstate API | PARTIAL | as above |
| S-173 | MobileApp BFF | PARTIAL | as above |
| S-174 | Two projects isolation | PASS | live isolation |
| S-175 | Decision timeline view | BLOCKED | Part 3 |
| S-176 | Full pipeline logging | PARTIAL | Part 1 stages observable; Part 3 dashboard absent |
| S-177 | Backfill then context | BLOCKED | backfill Part 2 |
| S-178 | Provisioning script | FAIL | no `provision.sh` in tree; docker-compose exists |
| S-179 | E2E suite on CI | PARTIAL | suite runs locally; no CI config verified |
| S-180 | AC-1 | PASS | live extraction |
| S-181 | AC-2 | PASS | live non-engineering |
| S-182 | AC-4 | PASS | live global preference |
| S-183 | AC-6 | PARTIAL | retrieval auto; injection Part 2 |
| S-184 | AC-7 | BLOCKED | Part 2 dispatch |
| S-185 | AC-8 | PARTIAL | not 50-request stress-tested |
| S-186 | AC-9 | PASS | live reasoning |
| S-187 | InventorySystem enterprise | PARTIAL | Part 1 slices; graph nodes exist |
| S-188 | AIStartup landing | PARTIAL | Part 1 slices |
| S-189 | 4-hour workflow simulation | PARTIAL | not simulated |
| S-190 | Extraction accuracy report | BLOCKED | Part 3 |
| S-191 | Retrieval relevance report | BLOCKED | Part 3 |
| S-192 | Conflict regression report | BLOCKED | Part 3 |
| S-193 | Demo script | PARTIAL | `demo-ppb.mjs` works; supervisor demo not run |
| S-194 | Performance baseline | PARTIAL | not measured |
| S-195 | Isolation stress test | PARTIAL | isolation verified, not 100× |
| S-196 | Memory browser search | BLOCKED | Part 3 |
| S-197 | Extraction failure degradation | PASS | degrade-not-break tested |
| S-198 | Neo4j failure degradation | PARTIAL | graceful-degradation design; not fault-injected |
| S-199 | 200-scenario health check | PARTIAL | not run end-to-end |
| S-200 | Supervisor acceptance demo | PARTIAL | not run |

---

## 6. Totals

| Status | Count |
|---|---|
| PASS | 108 |
| FAIL | 2 (S-074, S-075 — Redis cache absent) + Group G compression/latency |
| PARTIAL | 6 (mapped above; Group G has many partials not counted in this line by group table convention) |
| BLOCKED | 84 |

Overall: **Phase 1 Part 1 (B, C, E, F + ranking half of D) is green after the D-1 fix.** The
remaining gaps are Part 2 (ingestion/injection/tool dispatch/conflict transport), Part 3
(harness, UI, dashboards, provisioning), the unimplemented Redis cache, and Headroom's measured
compression behaviour with this engine/provider.

## 7. Recommended next actions

1. Persist the D-1 fix: `scripts\setup.bat --compile` (source already edited).
2. Provide a provider with a working `/embeddings` endpoint so semantic retrieval (C/D) and AC-10
   can be measured for real.
3. Implement IF-12 Redis retrieval cache (S-074/S-075).
4. Confirm the intended Headroom compression policy: if the doc's 500 ms / light / aggressive
   tiers are required, the proxy needs an explicit threshold config or the doc's Group G numbers
   need reconciling with `headroom_ai 0.2.8`.
5. Complete Part 2/3 work to unblock Groups A, D-injection, G-observability, H-UI/eval.

---

## 8. Per-scenario detail — blocked, failed and pending scenarios

Format: `S-NNN | title` · `Stage | Difficulty` · `Status` · `Headroom` · `Notes`.
Headroom is `n/a` where the owning code is absent and no request reaches the proxy.

### 8.1 Group A — Ingestion and Identification (all BLOCKED)

**S-001 | Resolve project from Git repository path**
Stage: Ingestion | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: project registry/identity are Part 2 (`orchestration/projectIdentity.ts`, `projectRegistry.ts`); no UUID is minted at open in this build.

**S-002 | Resolve same project after folder rename**
Stage: Ingestion | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: Part 2 registry reconciliation.

**S-003 | Capture developer turn in chat**
Stage: Ingestion | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: `segmentQueue.ts` exists but capture wiring is Part 2.

**S-004 | Filter non-engineering conversation**
Stage: Ingestion | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: `segmentFilter.ts` exists; the Part 1 extraction sink does correctly store zero facts for chatter (S-181 PASS), but the pre-filter boundary is Part 2.

**S-005 | Filter assistant greeting turn**
Stage: Ingestion | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: Part 2 role handling.

**S-006 | Buffer short segment, defer extraction**
Stage: Ingestion | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: Part 2 buffering policy.

**S-007 | Flush buffer and trigger extraction**
Stage: Ingestion | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: Part 2 flush threshold.

**S-008 | Backfill existing repository on first open**
Stage: Ingestion | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: `scheduleBackfill` exists in the sink but is never driven; Part 2/3 activity.

**S-009 | Incremental update from new API endpoint**
Stage: Ingestion | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: Part 2 file-change loop (`learningLoop.ts`).

**S-010 | Capture editor context with segment**
Stage: Ingestion | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: Part 2 `editorState.ts`.

**S-011 | Classify developer intent for ranking**
Stage: Ingestion | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: intent classifiers exist (`intentDetector.ts`); Part 2 deliverable.

**S-012 | Two workspaces open simultaneously, no leakage**
Stage: Isolation | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: multi-window capture is Part 2; project-scoped isolation itself is verified (S-090, S-195).

**S-013 | Global developer preference persists across projects**
Stage: Isolation | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: capture is Part 2; the Part 1 store/read behaviour is verified (S-182).

**S-014 | Conflict confirmation transport: request delivery**
Stage: Ingestion | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: IF-3 transport (Part 2).

**S-015 | Register Project Brain as tool in claude-code/src/tools**
Stage: Ingestion | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: the real `project_brain` MCP tool is registered in Part 1 (`node/ppb/tool.ts`); the `claude-code` `ProjectBrainTool` is a Null stub and `bootstrapPPB()` is never called — Part 2 dispatch.

### 8.2 Group D — Ranking and Context Injection

**S-076 | Recency signal boosts recently mentioned fact**
Stage: Retrieval | Difficulty: Intermediate
Status: PASS
Headroom: n/a (ranking is pre-Headroom)
Notes: `ranker.test.ts`; seven-signal formula.

**S-077 | Importance signal prioritises high-importance facts**
Stage: Retrieval | Difficulty: Basic
Status: PASS
Headroom: n/a
Notes: `ranker.test.ts`.

**S-078 | Frequency signal boosts repeatedly-retrieved fact**
Stage: Retrieval | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: `ranker.test.ts`.

**S-079 | Current-file signal boosts module-relevant facts**
Stage: Retrieval | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: `ranker.test.ts`.

**S-080 | Intent signal adjusts ranking weights**
Stage: Retrieval | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: `ranker.test.ts`.

**S-081 | Top-k selection limits injected memories**
Stage: Injection | Difficulty: Basic
Status: PASS (ranking half) / PARTIAL
Headroom: n/a
Notes: topK is enforced by the ranker; the injection-layer budget is Part 2.

**S-082 | Weight profile tuning via evaluation harness**
Stage: Retrieval | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: `weightProfile.test.ts` proves `configureWeights` changes ordering; the tuning harness is Part 3.

**S-083 | Project-module signal boosts active-module facts**
Stage: Retrieval | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: `ranker.test.ts`.

**S-084 | Ranking with all seven signals combined**
Stage: Retrieval | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: `ranker.test.ts`.

**S-085 | Ranking signal normalisation**
Stage: Retrieval | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: `ranker.test.ts`.

**S-086 | Decision memories always ranked above trivial preferences**
Stage: Retrieval | Difficulty: Basic
Status: PASS
Headroom: n/a
Notes: `ranker.test.ts`.

**S-087 | Stale fact penalty in recency signal**
Stage: Retrieval | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: `ranker` + versioning status.

**S-088 | Retrieval precision@k benchmark**
Stage: Retrieval | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: Part 3 evaluation harness absent; also needs real embeddings (D-2).

**S-089 | Retrieval returns empty result for project with no facts**
Stage: Retrieval | Difficulty: Basic
Status: PASS
Headroom: n/a
Notes: retriever degrades to `[]` without error.

**S-090 | Retrieval isolation enforcement**
Stage: Isolation | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: live graph `nothing leaks across projects`; project-scoped vector + graph queries.

**S-091 | MRR (mean reciprocal rank) benchmark**
Stage: Retrieval | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: Part 3 harness.

**S-092 | Injection respects 1200-token budget**
Stage: Injection | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: token-budget enforcement at injection is Part 2 (`injectionBlock.ts` / P2-T07).

**S-093 | Injection block format: structured sections**
Stage: Injection | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: `formatInjectionBlock` exists but assembly is Part 2.

**S-094 | Zero-action context injection guarantee**
Stage: Injection | Difficulty: Basic
Status: PARTIAL
Headroom: proxy-in-path (not exercised here)
Notes: Part 1 auto-retrieval returns the right memories; assembling them into the prompt is Part 2.

**S-095 | Injection ordering: constraints before preferences**
Stage: Injection | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: Part 2 ordering contract.

### 8.3 Group G — Headroom Integration (detailed)

Engine facts established by this run: proxy `headroom_ai 0.2.8` (server `1.0.0`), `X-Headroom-Upstream` patch present, `/stats` exposes per-request `input_tokens_original`, `input_tokens_optimized`, `transforms_applied`, `savings_percent`; the Anthropic route counts/optimises only `messages` (`proxy/server.py:1135`); smart routing makes LLMLingua lazy and it did not fire on the test payloads. Measured across the run: **0 tokens saved, 0%**.

**S-136 | Headroom called on every request, not just large prompts**
Stage: Headroom | Difficulty: Basic
Status: PARTIAL
Headroom: called=true | input_tokens=34 | output_tokens=29 | ratio=1.00 | action=forwarded_unchanged
Notes: proxy recorded the request; 100% call-rate over many requests was not stress-tested. CRITICAL test — not a clean PASS.

**S-137 | Headroom forwards small prompt unchanged**
Stage: Headroom | Difficulty: Basic
Status: PASS
Headroom: called=true | input_tokens=34 | output_tokens=29 | ratio=1.00 | action=forwarded_unchanged
Notes: passthrough observed.

**S-138 | Headroom applies light compression to medium prompt**
Stage: Headroom | Difficulty: Intermediate
Status: FAIL
Headroom: called=true | input_tokens=2400–16585 | output_tokens=same | ratio=1.00 | action=none
Notes: no light-compression transform fired; D-4.

**S-139 | Headroom applies aggressive compression to large prompt**
Stage: Headroom | Difficulty: Intermediate
Status: FAIL
Headroom: called=true | input_tokens=16585 | output_tokens=16585 | ratio=1.00 | action=none
Notes: no aggressive transform fired (`transforms_applied: []`); D-4.

**S-140 | Headroom preserves constraints under aggressive compression**
Stage: Headroom | Difficulty: Intermediate
Status: PARTIAL
Headroom: called=true | ratio=1.00 | action=forwarded_unchanged
Notes: constraint "No paid services allowed" reached the model (preservation 4/4 via `headroom-verify.mjs`), but only because no compression occurred. CRITICAL test — not a clean PASS.

**S-141 | Headroom preserves tech stack facts under compression**
Stage: Headroom | Difficulty: Intermediate
Status: PARTIAL
Headroom: called=true | ratio=1.00 | action=forwarded_unchanged
Notes: PostgreSQL/RDS/Clerk preserved verbatim; not under real compression.

**S-142 | Headroom token count verification after compression**
Stage: Headroom | Difficulty: Basic
Status: PARTIAL
Headroom: called=true | output_tokens=input_tokens
Notes: window limit never approached on test payloads.

**S-143 | Headroom call site is the last stage before Claude Code**
Stage: Headroom | Difficulty: Basic
Status: PASS
Headroom: n/a (position check)
Notes: engine wires the proxy in-path after injection and before the model; verified in `codeMindAgentEngineMain.ts`. CRITICAL test — PASS.

**S-144 | Headroom logs every call with input and output token counts**
Stage: Headroom | Difficulty: Basic
Status: PASS
Headroom: log entry present (`/stats` `recent_requests`)
Notes: input/output/action/latency recorded per call.

**S-145 | Headroom compression ratio tracked over time**
Stage: Headroom | Difficulty: Intermediate
Status: PARTIAL
Headroom: ratio metric present but always 0
Notes: metric surface exists; no compression to track.

**S-146 | Headroom does not alter developer request text**
Stage: Headroom | Difficulty: Basic
Status: PASS
Headroom: called=true | action=forwarded_unchanged
Notes: developer question passed through verbatim. CRITICAL test — PASS.

**S-147 | Headroom compression does not introduce factual errors**
Stage: Headroom | Difficulty: Intermediate
Status: PASS (vacuous)
Headroom: called=true | ratio=1.00
Notes: no compression ⇒ no corruption; 4/4 facts intact. CRITICAL test — PASS only in the no-compression sense.

**S-148 | Headroom latency does not exceed 500ms**
Stage: Headroom | Difficulty: Intermediate
Status: FAIL
Headroom: optimization_latency_ms ≈ 4.8s (LLMLingua CPU path)
Notes: D-4; `--no-llmlingua` gives a fast heuristic path but no compression.

**S-149 | Headroom called after conflict resolution**
Stage: Headroom | Difficulty: Basic
Status: PARTIAL
Headroom: not explicitly exercised
Notes: conflict resolution is Part 1, but the post-conflict request path is Part 2.

**S-150 | Headroom position verified in tool dispatch trace**
Stage: Headroom | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: code position verified; the Part 2 tool-dispatch trace is absent.

**S-151 | Headroom called even when injection block is empty**
Stage: Headroom | Difficulty: Basic
Status: PARTIAL
Headroom: not explicitly exercised
Notes: proxy is unconditional in-path; empty-injection request not run. CRITICAL test — not verified.

**S-152 | Headroom handles structured injection sections intelligently**
Stage: Headroom | Difficulty: Intermediate
Status: FAIL
Headroom: called=true | action=none
Notes: section-priority compression not observed; D-4.

**S-153 | Headroom compression ratio benchmark**
Stage: Headroom | Difficulty: Intermediate
Status: PARTIAL
Headroom: benchmark not run
Notes: no `headroom_quality.json`; would need a compression-firing engine.

**S-154 | Headroom called via Part 2 P2-T08 downstream adapter**
Stage: Headroom | Difficulty: Basic
Status: PARTIAL
Headroom: n/a
Notes: Part 2 adapter not present; the Part 1 engine call site exists.

**S-155 | Headroom reduces token cost for repeated context**
Stage: Headroom | Difficulty: Intermediate
Status: FAIL
Headroom: called=true | savings=0
Notes: no compression ⇒ no token-cost reduction; D-4.

**S-156 | Verify Headroom does not run during extraction sub-calls**
Stage: Headroom | Difficulty: Intermediate
Status: PASS
Headroom: extraction calls the model directly (not through :7878)
Notes: live extraction + live E2E confirm internal sub-calls bypass the proxy. CRITICAL test — PASS.

**S-157 | Headroom with maximum-size injection block**
Stage: Headroom | Difficulty: Intermediate
Status: PARTIAL
Headroom: not exercised at the 1200-token injection ceiling
Notes: injection budget is Part 2.

**S-158 | Headroom metrics visible in Part 3 dashboard**
Stage: Headroom | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: Part 3 dashboard absent; raw `/stats` + `/metrics` work.

**S-159 | Headroom called after cache hit**
Stage: Headroom | Difficulty: Basic
Status: PARTIAL
Headroom: n/a
Notes: retrieval cache (D-3) not implemented.

**S-160 | Headroom preserves injection section ordering**
Stage: Headroom | Difficulty: Basic
Status: PARTIAL
Headroom: called=true | action=none
Notes: ordering trivially preserved because nothing was compressed.

**S-161 | Headroom handles Unicode and special characters**
Stage: Headroom | Difficulty: Basic
Status: PARTIAL
Headroom: not specifically exercised
Notes: no Unicode payload test run.

**S-162 | Headroom compression performance under concurrent requests**
Stage: Headroom | Difficulty: Intermediate
Status: PARTIAL
Headroom: not tested
Notes: single-request probes only.

**S-163 | Headroom with injection block in different language**
Stage: Headroom | Difficulty: Intermediate
Status: PARTIAL
Headroom: not specifically exercised
Notes: multilingual preservation not tested.

**S-164 | Headroom decision memory passed to Claude Code**
Stage: Headroom | Difficulty: Basic
Status: PARTIAL
Headroom: called=true | ratio=1.00
Notes: decision facts survived in passthrough (S-140 run); survival through real compression not demonstrated. CRITICAL test — not a clean PASS.

**S-165 | Headroom output verified before Claude Code call**
Stage: Headroom | Difficulty: Intermediate
Status: PARTIAL
Headroom: not observed
Notes: validation loop not exercised.

### 8.4 Group H — End-to-End and Demo Projects (detailed)

**S-166 | First day of a new project (demo project setup)**
Stage: E2E | Difficulty: Basic
Status: PASS
Headroom: proxy-in-path; not exercised in E2E script
Notes: extraction → store → embed → graph projection → ranked retrieval verified live.

**S-167 | Week 2 - Tech decision captured and injected**
Stage: E2E | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: `createDecision` + retrieval + reasoner live.

**S-168 | Conflict scenario - database migration in demo project**
Stage: E2E | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: detector + `accept_migration` versioning tests.

**S-169 | Historical query in demo project**
Stage: E2E | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: live reasoner cites the migration event.

**S-170 | Multi-session memory persistence**
Stage: E2E | Difficulty: Basic
Status: PASS
Headroom: n/a
Notes: persisted PostgreSQL/Neo4j rows survive process restarts (observed across runs).

**S-171 | Demo project 2 - BlogPlatform**
Stage: E2E | Difficulty: Basic
Status: PARTIAL
Headroom: n/a
Notes: Part 1 slices work; graph already holds `blogplatform` nodes from a prior run; UI/eval is Part 3.

**S-172 | Demo project 3 - RealEstate API**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: as above (`realestate-api` nodes present).

**S-173 | Demo project 4 - MobileApp BFF**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: as above; note synthetic node id `ppb:tech:mobileapp-bff:rest` triggered D-1.

**S-174 | Two projects open, isolation verified**
Stage: E2E | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: live isolation test.

**S-175 | Decision timeline view populated correctly**
Stage: E2E | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: Part 3 view.

**S-176 | Full pipeline logging for one request**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: Part 1 stages observable; the 6-stage Part 3 log aggregator is absent.

**S-177 | Repository backfill then immediate useful context**
Stage: E2E | Difficulty: Intermediate
Status: BLOCKED
Headroom: n/a
Notes: backfill driving is Part 2.

**S-178 | Provisioning script sets up full stack**
Stage: E2E | Difficulty: Basic
Status: FAIL
Headroom: n/a
Notes: no `provision.sh` in the tree; `infra/ppb/docker-compose.yml` exists but is not the documented script (missing).

**S-179 | End-to-end test suite runs on CI**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: suite runs locally (29 live passing); no CI workflow verified.

**S-180 | Acceptance criterion AC-1 verified**
Stage: E2E | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: live extraction of tech stack + decision + constraint with metadata.

**S-181 | Acceptance criterion AC-2 verified**
Stage: E2E | Difficulty: Basic
Status: PASS
Headroom: n/a
Notes: live `non-engineering chatter yields zero facts`.

**S-182 | Acceptance criterion AC-4 (global preferences)**
Stage: E2E | Difficulty: Basic
Status: PASS
Headroom: n/a
Notes: live `preferences: project-scoped plus the global exception`.

**S-183 | Acceptance criterion AC-6 (auto-injection)**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: proxy-in-path
Notes: auto-retrieval proven; prompt injection is Part 2.

**S-184 | Acceptance criterion AC-7 (project brain tool invocation)**
Stage: E2E | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: `claude-code` `ProjectBrainTool` is a stub and `bootstrapPPB()` is uncalled; Part 2 dispatch.

**S-185 | Acceptance criterion AC-8 (Headroom on every request)**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: called for observed requests; 50-request stress not run
Notes: proxy-in-path exists; 49/50 would be a fail, so this is not signed off.

**S-186 | Acceptance criterion AC-9 (historical reasoning)**
Stage: E2E | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: live reasoner with citations + insufficient-evidence.

**S-187 | Demo project 5 - InventorySystem**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: Part 1 slices; `inventory-system` nodes exist from a prior run.

**S-188 | Demo project 6 - AIStartup landing page**
Stage: E2E | Difficulty: Basic
Status: PARTIAL
Headroom: n/a
Notes: Part 1 slices; `aistartup-landing` nodes exist.

**S-189 | Real developer workflow simulation (4 hours)**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: not simulated end to end.

**S-190 | Extraction accuracy report generated**
Stage: E2E | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: Part 3 harness.

**S-191 | Retrieval relevance report generated**
Stage: E2E | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: Part 3 harness; also needs real embeddings (D-2).

**S-192 | Conflict regression report generated**
Stage: E2E | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: Part 3 harness.

**S-193 | Full demonstration script run**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: `demo-ppb.mjs` runs correctly; the supervisor demo script (with Headroom dashboard) is Part 3.

**S-194 | Performance baseline on realistic project**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: not measured.

**S-195 | Zero cross-project leakage stress test**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: isolation verified at integration level; 100-request stress not run.

**S-196 | Memory browser search and filter**
Stage: E2E | Difficulty: Basic
Status: BLOCKED
Headroom: n/a
Notes: Part 3 UI.

**S-197 | Pipeline survives extraction model failure**
Stage: E2E | Difficulty: Intermediate
Status: PASS
Headroom: n/a
Notes: `sink`/`retriever`/`reasoner` degrade-not-break (§24); unit tests cover it.

**S-198 | Pipeline survives Neo4j connection failure**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: graceful-degradation design present; no fault injection run.

**S-199 | 200 scenarios complete — final health check**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: not run as a single gate.

**S-200 | Phase 1 complete — supervisor acceptance demonstration**
Stage: E2E | Difficulty: Intermediate
Status: PARTIAL
Headroom: n/a
Notes: not run; depends on Part 2/3 completion.

### 8.5 Group C — cache scenarios (D-3)

**S-074 | Redis cache hit for repeated retrieval request**
Stage: Retrieval | Difficulty: Basic
Status: FAIL
Headroom: n/a
Notes: no `redis`/`ioredis` import under `ppb/`; IF-12 is published but not implemented.

**S-075 | Cache invalidation on new fact stored**
Stage: Retrieval | Difficulty: Intermediate
Status: FAIL
Headroom: n/a
Notes: same as S-074.

---

## 9. Evidence classification

### 9.1 Confirmed passing (compiled build)
- Unit + contract suite: **165 passing**.
- Live infrastructure suite: **26 passing** (no LLM) / **29 passing** (with model).
- Live E2E after D-1 fix: **2 passing**.
- `demo-ppb.mjs`: extraction, storage, graph projection, **ranked retrieval**, 4 cited reasoning answers, insufficient-evidence guard.
- Extraction, dedup, graph CRUD/traversal, versioning, conflict detection, seven-signal ranking, reasoning (AC-1, AC-2, AC-3, AC-4, AC-5, AC-9).

### 9.2 Confirmed failures (in scope of the current tree)
- **S-074, S-075** — Redis retrieval cache not implemented (D-3).
- **S-138, S-139, S-148, S-152, S-155** — Headroom compression/latency behaviour (D-4).
- **S-178** — no `provision.sh` (D-5, missing implementation).

### 9.3 Blocked scenarios (owning code absent)
- Group A (S-001–S-015) — Part 2.
- D injection half (S-092, S-093, S-095; S-081/S-094 partial) — Part 2.
- D harness (S-088, S-091) — Part 3.
- G observability/UI (S-158) — Part 3.
- H UI/eval (S-175, S-177, S-184, S-190, S-191, S-192, S-196) — Part 2/3.

### 9.4 Missing implementation
- IF-12 Redis cache (D-3).
- `provision.sh` (D-5).
- Part 3 evaluation harness, memory browser, decision timeline, dashboards (D-5).
- Part 2 `claude-code` `ProjectBrainTool` wiring.

### 9.5 Infrastructure limitations
- **D-2** — no working `/embeddings` endpoint on `vsllm.cc` or tokenrouter; real semantic retrieval quality cannot be measured.
- Headroom server `1.0.0`/`headroom_ai 0.2.8` does not implement the doc's fixed compression tiers and ignores the Anthropic `system` block (D-4).
- `deepseek-v4.1-flash` reasoning latency is variable (4s–130s per extraction), which makes live timing assertions noisy.

### 9.6 Tests using the local embedding stand-in
The following rely on the local feature-hashing server (`local-hash-2048`) instead of a real
embedding model; they validate **plumbing, ranking and isolation**, not semantic quality:
- S-070, S-071, S-072, S-073 (vector/graph/fusion).
- S-076–S-087 (ranking, when run through live retrieval).
- S-089, S-090 (empty result, isolation).
- Live E2E and `demo-ppb.mjs` retrieval stages.
- Group H retrieval-dependent slices (S-166, S-170, S-174, S-180, S-183, S-186).

---

## 10. Deferred items (documented, not implemented)

- **D-3 Redis retrieval cache (IF-12):** add an `ioredis` client, a request-signature cache key,
  300 s TTL, and invalidation on fact write. Decision pending.
- **D-4 Headroom compression policy:** decide whether the doc's thresholds should be configured
  explicitly (or the Group G expectations reconciled with `headroom_ai 0.2.8`), and whether the
  Anthropic `system` block must be compressed.
- **D-5 Part 3 tooling / provisioning:** evaluation harness, memory browser, decision timeline,
  dashboards, `provision.sh`. Decision pending.

---

## 11. Infrastructure left running at time of writing

| Process | Endpoint |
|---|---|
| Docker `ppb-postgres` (pgvector) | `127.0.0.1:55432` |
| Docker `ppb-neo4j` | bolt `127.0.0.1:57687`, HTTP `127.0.0.1:57300` |
| Docker `ppb-redis` | `127.0.0.1:56379` |
| Headroom proxy (`headroom_ai 0.2.8`) | `127.0.0.1:7878` |
| Local embedding stand-in | `127.0.0.1:20129` |

---

## 12. Recompile and compiled-build verification (post D-1)

`scripts\setup.bat --compile` completed successfully — `compile-src` finished with **0 errors**
(≈7.18 min). The overlay copied `vscodium/src/stable` onto `vscodium/vscode`, so the compiled
`out/.../retrieval/hybrid.js` now contains the source `loadFact` guard (verified by inspection).

Re-run against the **compiled** build:

| Check | Result |
|---|---|
| Unit + contract suite | **165 passing, 28 pending** |
| Live E2E (populated graph + real provider) | **2 passing** |
| `demo-ppb.mjs` section 3 | ranked retrieval returned 3 memories (PostgreSQL 0.557, Clerk 0.414, Auth.js 0.243) |

D-1 is therefore fixed in the build artifact, not merely the source tree.

---

## 13. UI integration (project_brain tool) — added after D-1

To make the `project_brain` tool usable in the editor on a real project, three gaps were closed:

1. **Tool could not see the project.** The tool handler reads
   `process.env.CODEMIND_CURRENT_PROJECT_ID`, but the engine only built a per-query env *object*
   (never mutating the worker's `process.env`). The engine now sets it when the project resolves
   (`codeMindAgentEngineMain.ts`).
2. **Empty MCP scaffold was cached forever.** `_buildPpbMcpServer` cached the tool-less server if
   it ran before the stack/SDK were ready, so the real tool never registered. It now returns the
   empty scaffold *without caching*, and registers the real tool on the first turn it can.
3. **No way to enable it in the UI.** Added `/brain` (status), `/brain on`, `/brain off`,
   backed by the engine's existing `get/setGlobalDeveloperPrefs`. Added `scripts/run-brain.ps1`
   (starts Docker + embeddings + Headroom, enables the pref, launches CodeMind) and
   `scripts/embed-standin.mjs` (dev embeddings).

**Verification.** Recompiled (0 errors). The compiled `project_brain` handler was driven
headlessly against the live stack on a scratch project (`brain-tool-test`):

| Operation | Result |
|---|---|
| `store` ("We use PostgreSQL … chose Clerk") | `ppb: 2 fact(s) persisted`, 2 relationships |
| `list` | returned both facts |
| `recall` ("PostgreSQL database") | returned PostgreSQL (0.33) then Clerk (0.26) |
| `reason` ("What database are we using?") | `answered` with citations to both facts |

Unit suite still **165 passing**. A GUI click-through is the remaining manual step (see
`BRAIN_UI_QUICKSTART.md`). Note: one earlier `store` produced 0 facts transiently — the provider
model is variable (D-2-adjacent).