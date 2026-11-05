# Project Brain — UI quickstart (development)

This wires the Phase 1 Project Brain into CodeMind so the **`project_brain` tool works in the
editor** and memories are injected automatically. Plain-English steps.

## What was added for this

| Change | File |
|---|---|
| Brain is **on by default** (no switch; `CODEMIND_PPB_ENABLED=0` disables) | `node/ppb/config.ts`, `node/orchestration/projectRegistry.ts` |
| `run.bat` now starts the brain automatically (services + env + prefs), then the editor | `scripts/run.bat`, `scripts/run-brain.ps1`, `scripts/run-editor.bat` |
| Retrieval and injection are emitted as **`project_brain` tool calls** in the panel | `node/codeMindAgentEngineMain.ts` |
| Ingestion (extract / save) is emitted as tool calls via a sink observer | `node/ppb/sink.ts` + engine |
| The project row is upserted before writes (fixes silent FK drops) | `node/codeMindAgentEngineMain.ts` |
| The in-process tool sees the active project | `node/codeMindAgentEngineMain.ts` |
| `/brain` slash command (status / on / off) | `browser/codeMindCommands.ts` |
| Dashboard + dev embeddings stand-in | `scripts/brain-dashboard.*`, `scripts/embed-standin.mjs` |

## One-time setup

1. Docker Desktop installed and able to run.
2. Provider key file created at `%USERPROFILE%\.codemind\ppb.env`:
   ```
   PPB_EXTRACT_API_KEY=sk-your-key
   ```
3. Nothing else: the brain is on by default and `run.bat` starts its services.

## Launch (one command)

Just start CodeMind normally — the brain comes with it:

```powershell
cd D:\HassanSem\Semester-6\FYP\CodeMind
scripts\run.bat D:\path\to\your\real\project
```

`run.bat` loads your key → starts PostgreSQL/Neo4j/Redis → starts the embedding stand-in on `:20129`
→ starts the Headroom proxy and the dashboard → opens CodeMind on your project. It always starts a
**new window**; with no folder it opens a fresh empty one.

## In the CodeMind panel

1. Set your chat provider once (base URL + API key + model) as you normally do. Chat itself is
   unchanged; the brain runs beside it.
2. Type **`/brain`** — you should see `Project Brain: ON`.
3. **Teach it:** chat normally, e.g. *"We use PostgreSQL for persistence and we chose Clerk for
   authentication."* Facts are extracted and stored in the background (a few seconds; the model
   can take 5–60 s).
4. **Ask it back:**
   - *"Recall what you know about this project's authentication."* → the agent calls
     `project_brain` with `recall`.
   - *"Why did we choose Clerk?"* → `project_brain` with `reason` returns a cited answer.
   - *"List everything you remember."* → `project_brain` with `list`.
   - Or say *"Remember that we deploy to AWS EC2."* → `project_brain` with `store`.
5. **Automatic injection:** if memories exist, the relevant ones are prepended to your turn. You
   don't attach anything.

## Brain activity shows as tool calls

The brain's work appears in the transcript like any other tool — look for a **`project_brain`**
card:

- `project_brain` · `recall` — "N memory(ies) recalled" (memory lookup before the answer)
- `project_brain` · `inject` — "injected N memory(ies) (~X tokens, Y dropped)"
- `project_brain` · `extract` — "extracted N fact(s)" (from your message)
- `project_brain` · `save` — "stored N memory(ies)" (written to PostgreSQL)
- `project_brain` · `store` / `list` / `reason` — when the agent calls the tool directly

So every time the brain remembers something or looks something up, you see it called.

## Check the machinery (optional)

```powershell
docker exec ppb-postgres psql -U postgres -d codemind_ppb -c "select project_id, category, content from memories order by updated_at desc limit 20;"
docker exec ppb-neo4j cypher-shell -u neo4j -p codemindppb "MATCH (n) RETURN labels(n), n.id LIMIT 20"
```

## What works and what does not (be honest with markers)

**Works**
- `project_brain` tool: `recall`, `store`, `list`, `reason` (verified headlessly against the
  compiled build — see the execution report §12).
- Automatic capture + extraction + storage + graph projection for the active project.
- Automatic memory injection (with a local embedding service).
- Multi-project isolation; `/brain` status.

**Limitations**
- **No memory browser / decision timeline / dashboards** — Part 3, not built.
- **Conflict pop-ups** (PostgreSQL → MySQL etc.) are Part 2, not wired.
- **Embeddings are a dev stand-in** (`scripts/embed-standin.mjs`): recall matches on shared
  words, not meaning. Swap `PPB_EMBED_*` for a real embedding endpoint when you have one.
- **Headroom** is in the request path but does not compress with this engine version.
- The auto-injection retrieval has an 800 ms budget; if it times out the agent can still use
  `project_brain` explicitly.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/brain` says OFF | Run through `run-brain.ps1`, or `/brain on`. |
| Tool says "No active project." | Send one normal chat message first (the project is resolved on the first turn). |
| Nothing stored | Check Docker is up and `CODEMIND_PPB_ENABLED=1`; the extraction model can take 5–60 s. |
| Recall returns nothing | Ensure the embedding stand-in is running (`:20129`) and `PPB_EMBEDDING_DIM=2048`. |
| `docker compose` error at launch | Start Docker Desktop and re-run the launcher. |

## Dashboard — see what is actually stored

A local, read-only view of the brain's real contents (PostgreSQL + Neo4j) and the layer map:

```powershell
node scripts/brain-dashboard.mjs      # then open http://127.0.0.1:20200
```

`run-brain.ps1` starts it automatically. It shows: projects, memories, decisions, events,
conflicts, embeddings, pending outbox rows, and a live **Neo4j graph**. If a project you used is
missing from the Projects table, its facts were not persisted.

## Known issues (as of this build)

1. **The agent sometimes stops mid-task and needs "Continue".** This is model behaviour, not the
   brain: `maxTurns` is 40, but third-party models (e.g. `deepseek-v4.1-flash`) often end a turn
   after one or two tool calls instead of chaining to completion. Options: use a stronger
   agentic model, or raise `codemind.maxTurns` in Settings, or just send "continue".
2. **Repeated work is not warned about yet.** The extractor stores *engineering knowledge*
   (tech stack, decisions, constraints…) — not task history like "build me a game". So asking for
   Angry Birds again after building it will not be flagged. Catching that needs a task/event
   capture or a pre-task brain consultation (a design extension, not yet built).
3. **Embeddings are the dev stand-in** — recall matches shared words, not meaning.
4. After the FK fix, a project's first turn creates its `projects` row automatically; until this
   build, every write was silently dropped.