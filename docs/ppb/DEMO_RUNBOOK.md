# CodeMind — Phase 1 Part 1 (PPB) Demo Runbook

Audience: project supervisor. Goal: show the **Project Brain** memory pipeline end to end —
ingestion → extraction → storage → retrieval/injection → grounded historical reasoning — on the
real provider, and map each step to its spec requirement and test.

Authority: `phase_1.md`. Living status: `docs/ppb/traceability.md`.

---

## 0. What is being demonstrated (30-second version)

CodeMind remembers a software project's engineering knowledge (facts, decisions, rejected
alternatives, dated events) and:

1. **Ingests** a conversation turn (IF-1) and **extracts** typed facts with an LLM (IF-2).
2. **Stores** them in PostgreSQL (source of truth) and **projects** them to a Neo4j knowledge
   graph asynchronously (§24).
3. **Retrieves** relevant memories when you chat and **ranks** them with seven signals (IF-5 →
   IF-6).
4. **Answers historical questions** ("why did we choose Clerk?", "when did we migrate?") with
   citations to the stored records, and says *"insufficient evidence"* rather than hallucinating
   (IF-8 → IF-9).
5. Exposes the same logic to the agent as a `project_brain` tool (`recall` / `store` / `list` /
   `reason`) and publishes a **tunable ranking weight profile** for Part 3 (P1-T14).

---

## 1. Prerequisites

- **Node 24** (`.nvmrc` is 24.15.0; `nvm use 24.18.0` works). Node 26 breaks the pinned mocha.
- **Docker Desktop** running.
- A working build at `vscodium/vscode/out` (see §3 to (re)build).
- The real provider key in an environment variable (never commit it):

  ```powershell
  $env:PPB_EXTRACT_API_KEY = 'sk-...'   # api.hcnsec.cn key
  ```

## 2. Provider configuration (DEV-15 / DEV-18 / DEV-19)

| Variable | Value used for the demo |
|---|---|
| `PPB_EXTRACT_BASE_URL` | `https://api.hcnsec.cn/v1` |
| `PPB_EXTRACT_MODEL` | `space-bunny-free` (reasoning model; falls back to `sensenova-6.8-flash-lite` / `auto` when its channel is unavailable — see note) |
| `PPB_EXTRACT_TIMEOUT_MS` | `180000` for `space-bunny-free` (8–32 s/call); `90000` is plenty for `sensenova-6.8-flash-lite` |
| `PPB_EMBED_BASE_URL` | `https://api.hcnsec.cn/v1` |
| `PPB_EMBED_MODEL` | `Qwen3-Embedding-8B` |
| `PPB_EMBEDDING_DIM` | `2048` (this model's width; pgvector >2000 ⇒ exact search, DEV-18) |
| `PPB_EMBED_API_KEY` | same key |
| `CODEMIND_PPB_ENABLED` | `1` (master gate; unset ⇒ zero behaviour change) |

One-shot setup for a PowerShell session:

```powershell
$env:PPB_TEST_INFRA = '1'; $env:PPB_TEST_LLM = '1'
$env:PPB_EMBEDDING_DIM = '2048'; $env:PPB_EMBED_MODEL = 'Qwen3-Embedding-8B'
$env:PPB_EXTRACT_MODEL = 'space-bunny-free'; $env:PPB_EXTRACT_TIMEOUT_MS = '180000'
$env:PPB_EXTRACT_BASE_URL = 'https://api.hcnsec.cn/v1'
$env:PPB_EMBED_BASE_URL   = 'https://api.hcnsec.cn/v1'
$env:PPB_EXTRACT_API_KEY  = 'sk-...'
$env:PPB_EMBED_API_KEY    = 'sk-...'
```

> **Provider availability note.** The host's free channels rotate, so `space-bunny-free` can stop
> responding for a while (requests hang until the timeout). If that happens during a demo, pick a
> responsive model from `GET /v1/models` — `sensenova-6.8-flash-lite` and `auto` are fast and work
> with the extraction schema. The embedding model (`Qwen3-Embedding-8B`) has been stable. Check with
> a one-line probe before presenting:
>
> ```powershell
> (Invoke-RestMethod https://api.hcnsec.cn/v1/models -Headers @{Authorization="Bearer $env:PPB_EXTRACT_API_KEY"}).data.id
> ```

## 3. Bring up the stack and (re)build

```powershell
# 1. PostgreSQL + pgvector, Neo4j, Redis (Route A)
docker compose -f infra/ppb/docker-compose.yml up -d
docker ps    # all three should be healthy

# 2. (Only after editing sources) overlay + compile the workbench
scripts\setup.bat --compile      # or: cd vscodium\vscode; npm run compile-client
```

> Build note (DEV-5): the full compile is memory-sensitive. If it exits with `tsgo exited with
> code 1` and **no** `error TS` lines, free memory (close apps / `wsl --shutdown`) and retry.

---

## 4. Demo A — Headless, fully reproducible (recommended)

**Best for presenting:** a script that prints every pipeline stage with real content and citations.
It cannot be affected by editor state, and it cleans up the rows it creates.

```powershell
# from the repo root, with the §2 env vars set
node scripts/demo-ppb.mjs
```

It prints: schema/migrations → ingest + extract the facts → store a decision/event + project to
Neo4j → ranked retrieval → four reasoning answers with citations → the insufficient-evidence guard.

The same path is also enforced as a test (one green line, for the audit trail):

```powershell
cd vscodium\vscode
node test/unit/node/index.js --runGlob "vs/workbench/contrib/codemindAgent/node/test/ppb/integration/liveE2E.integration.test.js"
```

What it proves (§23.2):

1. A conversation turn is **extracted** by the live model (IF-1 → IF-2).
2. Facts are **persisted + embedded** and the outbox is **projected** to Neo4j.
3. A Clerk/Auth.js/Better-Auth decision + an AWS deployment event are stored.
4. **Hybrid retrieval + seven-signal ranking** returns the PostgreSQL fact (IF-5 → IF-6).
5. **Reasoning** answers *"Why did we choose Clerk for authentication?"* with a citation to the
   decision and its recorded reason (IF-8 → IF-9).

Expected: `2 passing (~30s)`.

Other suites for the audit trail:

```powershell
# All PPB unit + contract tests (no network): ~157 passing
node test/unit/node/index.js --runGlob "vs/workbench/contrib/codemindAgent/node/test/ppb/**/*.test.js"

# Live infrastructure tests (PostgreSQL/Neo4j/Redis): ~26 passing
$env:PPB_TEST_INFRA = '1'
node test/unit/node/index.js --runGlob "vs/workbench/contrib/codemindAgent/node/test/ppb/integration/**/*.test.js"
```

---

## 5. Demo B — In the editor (agent uses the brain)

1. Launch the dev build:

   ```powershell
   cd vscodium\vscode
   .\.build\electron\CodeMind.exe .        # Windows
   ```

2. In the CodeMind panel, pick the model/provider (this is what PPB extraction follows, OD-6).
   Under PPB settings, **enable the brain** for the project (`CODEMIND_PPB_ENABLED=1` and the
   project's `ppbEnabled` preference).

3. **Teach it something** (chat normally):

   > We use PostgreSQL for persistence. We chose Clerk for authentication; we rejected Auth.js
   > because it lacked the features we needed.

   The turn is queued, the facts are extracted, stored, embedded and projected to the graph.

4. **Recall** — ask the agent to use the tool (or just ask a question that triggers retrieval):

   > Recall what you know about this project's authentication.

   The agent calls `project_brain` with `operation: "recall"` and gets the ranked memories.

5. **Reason over history**:

   > Why did we choose Clerk, and what did we reject?

   `project_brain` with `operation: "reason"` returns a grounded answer plus citations to the
   underlying decision/event records.

6. **List** the stored memories: `project_brain` with `operation: "list"`.

7. **Ask something it cannot know** (hallucination check):

   > Why did we choose Stripe for payments?

   Expected: the defined *insufficient evidence* answer, with **no** fabricated content.

8. **Show the tuning surface** (P1-T14): in code, `PpbRetriever#configureWeights({ importance: 5,
   recency: 0 })` changes which memory ranks first — the hook Part 3's harness will tune.

---

## 6. Spec-conformance cheat sheet

| Spec | Requirement | Where it lives | Test |
|---|---|---|---|
| §6/§9 | Graph/relational/vector schema + repositories, project-scoped | `ppb/storage/*`, `ppb/graph/graphRepo.ts` | `migrations`, `graphRepo`, `read`/`write` |
| §7/§8 | Six-category extraction + dedup | `ppb/extraction/*` | `extraction`, `dedup` |
| §12/§13 | Conflict detection + Active/Archived/Superseded versioning | `ppb/conflict/detector.ts`, `ppb/versioning/versionStore.ts` | `detector`, `versionStore` |
| §14 | Embeddings + pgvector search | `ppb/embeddings/*`, migration 005 | `embeddings` (live) |
| §15/§16 | Hybrid retrieval + seven-signal ranking | `ppb/retrieval/*` | `hybrid`, `ranker`, `retriever` |
| §16.7 | Tunable, versioned weight profile | `ppb/retrieval/weightProfile.ts` | `weightProfile`, `apiContract` |
| §17 | Long-term reasoning with citations + insufficient-evidence | `ppb/reasoning/reasoner.ts` | `reasoner`, `reasoning` (live) |
| §18 | Published internal API surface (IF-1…IF-12) | `ppb/api.ts`, `docs/ppb/if-contracts.md` | `apiContract` |
| §24 | Degrade, never break a turn; invalid project rejected | all services | `retriever`, `reasoner`, live suites |

Full per-task table: `docs/ppb/traceability.md` §1. Deviations: §3 (DEV-1…DEV-20).

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ppb-neo4j` won't start (`WSAEACCES`) | Windows-reserved port. Set `PPB_NEO4J_HTTP_PORT=57300` and recreate (DEV-14). |
| Live tests connect-refuse | Docker not running, or `docker compose ... up -d` not run. |
| Extraction returns 0 facts | Reasoning model exceeded the timeout — set `PPB_EXTRACT_TIMEOUT_MS=180000` (DEV-19). |
| Extraction hangs for minutes, then 0 facts | `space-bunny-free`'s channel is down at the provider. Switch `PPB_EXTRACT_MODEL` to `sensenova-6.8-flash-lite` or `auto` (see §2 note). |
| `column cannot have more than 2000 dimensions for hnsw index` | `PPB_EMBEDDING_DIM` >2000: migration 005 already guards this (DEV-18); ensure the build is current. |
| `require is not defined in ES module scope` from mocha | Node 26 in use — `nvm use 24`. |
| Compile exits 1 with no `error TS` lines | Memory pressure — free RAM and retry (DEV-5). |
| `project_brain` returns `No results found.` | The project has no stored memories yet — run Demo B step 3, or check `CODEMIND_PPB_ENABLED=1`. |
| Editor injection empty | Retrieval degrades to `NullRetriever` when the stack is unreachable; check Docker + env (§24 by design). |

---

## 8. What is intentionally *not* in Part 1

Conversation capture/UI, context-injection **formatting into prompts** and Headroom, the conflict
dialog, the evaluation harness and observability tooling belong to Parts 2/3. Part 1 ends at IF-2,
IF-6, IF-9 and the IF-11 repository surface (see `phase_1.md` §3 ownership table).
