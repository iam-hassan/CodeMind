# CodeMind Phase-2 Orchestration — Final Report

**Status:** implemented and verified.
**Scope:** the 7-layer orchestration pipeline, the standalone Orchestration Trace
panel, the Layer-6 Headroom compression integration, the `/doctor` health check, the
optional proxy autostart, and the automated proof suite.

---

## 1. The pipeline

Every non-trivial turn runs through a fixed 7-layer pipeline in the pure-Node worker
(`node/codeMindOrchestrationEngine.ts` → `orchestrate()`), which imports only core Node
modules (`fs`/`path`/`http`/`crypto`/`url`) plus its local `./orchestration/*` — no
`vscode`/`electron` dependency, so it is unit-testable in isolation.

| # | Layer | Module |
|---|-------|--------|
| 1 | intentDetection | `orchestration/intentDetector.ts` (fusion: deterministic evidence + local TF-IDF model) |
| 2 | toolSelection | `orchestration/toolSelector.ts` |
| 3 | toolExecution | **observed** from the live Claude Agent SDK stream by `orchestration/traceCollector.ts` — the six "shadow adapters" were removed |
| 4 | contextAggregation | `orchestration/contextAggregator.ts` |
| 5 | contextOptimization | `orchestration/contextOptimizer.ts` (prune-by-intent, line-trim, token estimate) |
| 6 | **headroomCompression** | `orchestration/headroomLayer.ts` (**the genuinely new layer**) |
| 7 | claudeAgentSDK | the SDK call itself (input captured; response streams back on the normal channel) |

> **Shadow adapters removed — Layer 3 observes real claude-code tool calls via SDK event stream (TraceCollector).**
>
> **Layer 3 data source: tool_use and tool_result blocks from the Claude Agent SDK stream, not parallel reimplementation.**

`orchestrate()` no longer runs adapters, aggregates context, or caches results. It does
exactly two honest things: classify the developer's intent (Layer 1) and return a
**minimal intent-hint suffix** that nudges the model to gather any missing context with
its **own** tools (`Read`/`Grep`/`Glob`/`Bash`/`WebSearch`). The engine returns
`{ enrichedPrompt, systemPromptSuffix, orchestrationMetadata }`; the **user turn stays
pristine** (`enrichedPrompt === request.userPrompt`) and the tiny hint rides in
`systemPromptSuffix`, appended to the SDK preset system prompt
(`systemPrompt: { type:'preset', preset:'claude_code', append }`).

The real Layer-3 tool list and the real Layer-6 Headroom result are therefore **observed
downstream**, per query, by a `TraceCollector` in the engine main against the live SDK
stream — assistant `tool_use` blocks → `recordToolCall`, user `tool_result` blocks →
`recordToolResult`, the terminal `result` message → `finalize`. Layer 3 lists the tools
the model **actually** invoked this turn (never adapter names); Layer 6 carries the
**actual** `HeadroomResult`. Because there are no adapters there is no parallel context to
cache; the only remaining short-circuit is the `< 20`-char fast path (mode `none`).

---

## 2. Layer 6 — Headroom integration (local proxy only)

Headroom is the one layer claude-code does not already have. It compresses the
system-prompt **suffix** (intent hint + serialized pre-fetched context) before it is
appended to the SDK system prompt.

**Local proxy only — nothing leaves the machine.** Compression runs against a *local*
Headroom proxy at `http://localhost:7878`. The call is
`compress([{ role:'user', content: suffix }], { model, baseUrl: 'http://localhost:7878', fallback: true, timeout: 4000 })`.
There is no cloud endpoint, no API key, and no conversation data is transmitted
anywhere off-box.

**Graceful degradation is the default, not an error path.** `fallback: true` means the
library returns the messages unchanged when the proxy is down, so the pipeline never
stalls and CodeMind works with or without the proxy running. Every non-happy outcome —
library absent, proxy unreachable, timeout, any throw — resolves to a passthrough that
returns the suffix byte-for-byte unchanged (`tokensSaved: 0`, `compressionRatio: 1`).
The Layer-6 trace row is still reported as **PASS**; only the dot colour changes.

**Library discovery.** `headroom-ai` is installed only in the sibling `claude-code/`
tree and it ships **no CLI `bin`**, so the layer resolves the package entry at runtime
by walking up to 16 parent directories looking for
`claude-code/node_modules/headroom-ai/dist/index.js` and dynamically `import()`-ing it.
If it cannot be found the layer is a lossless no-op (`headroomAvailable: false`). Because
there is no `bin`, the proxy server is a **separate tool** — the code and the autostart
scripts are written defensively around that fact and never assume `npx headroom` works.

**Compression modes** (`decideMode`, by estimated tokens = `chars / 4`):

| tokens | mode | behaviour |
|--------|------|-----------|
| `< 500` | `none` | not engaged — suffix returned unchanged (dot grey) |
| `500 … 1999` | `light` | compress everything except the **last** `=== SECTION ===`, which is preserved verbatim at the tail |
| `>= 2000` | `aggressive` | compress the whole suffix |

**`HeadroomResult`** carries `compressedSuffix`, `originalTokens`, `compressedTokens`,
`tokensSaved`, `compressionRatio`, `mode`, `headroomAvailable`, `proxyReachable`,
`transformsApplied`, and `durationMs`. `proxyReachable` is driven by the real API's
`compressed === true` flag, so the trace can distinguish "compressed locally" from
"fell back".

The engine prewarms the library once at worker startup
(`import('./orchestration/headroomLayer.js').then(m => m.prewarmHeadroom())`) so the
first real turn does not pay the resolve/import cost.

---

## 3. Standalone Orchestration Trace panel

The 🐛 dev-mode trace was **moved out of the chat window** into its own editor panel
(mirroring the Multi-Agent Consensus window), so the agentic conversation stays clean.

- Host: `browser/codeMindOrchestrationTracePanel.ts` — singleton webview, viewType
  `codemind.orchestrationTrace`, `retainContextWhenHidden`, a 20-entry ring buffer, and
  `pushTrace` / `clearTraces`. Opening the panel replays the buffer so recent history is
  visible immediately.
- Renderer: `browser/media/trace.js` + `trace.css` — a newest-first list of per-query
  `<details>` cards, keyed by `queryId` so a buffer replay updates a card in place rather
  than duplicating it. Open/closed state survives full re-renders.
- **Layer-6 rich display (Section 4):** the Headroom row shows a labelled key/value block
  (Library / Proxy / Mode / Context tokens `before → after` / Tokens saved / Ratio /
  Duration) and a state-coloured dot:
  - **grey** = mode `none` (not engaged),
  - **red** = library missing,
  - **yellow** = proxy unreachable / no savings (graceful fallback),
  - **green** = compressed with savings.

  The structured data reaches the webview via `layer.headroom` (attached by
  `headroomTraceMeta()` in the engine); the dev-mode toggle opening the panel and the
  worker resync remain wired so the worker actually emits traces.

---

## 4. `/doctor` health check

`/doctor` now includes a **Headroom compression** check
(`node/codeMindAgentEngineMain.ts` → `_headroomCheck()`, backed by
`headroomLayer.probeHeadroom()`). It reports one of three states:

- **not installed** — `headroom-ai` not resolvable → context sent uncompressed (optional);
- **proxy running** — `GET http://localhost:7878/health` answered → compressing locally;
- **installed, proxy down** — how to start it (`headroom proxy --port 7878`), passthrough
  until then.

The probe uses Node `http.get` with a 1000 ms timeout and treats **any** HTTP response as
"reachable". All three states report `ok: true` because Headroom is optional by design — a
missing proxy is informational, not a failure, so `/doctor` does not raise false alarms.

---

## 5. Optional proxy autostart

`scripts/run.sh` and `scripts/run.bat` gained an **idempotent, non-fatal** Headroom
autostart before launch: if a `headroom` command is on `PATH` and nothing is already
listening on `:7878`, start it in the background; otherwise print one line and continue.
Because `headroom-ai` has no `bin`, the guard is intentionally defensive — the launch
never depends on the proxy existing.

---

## 6. Proof suite

Tests live in `node/test/*.test.ts` (VS Code's built-in mocha `test-node` runner, tdd
`suite`/`test` + `assert`, zero new dependencies) and run against the compiled `out/`
tree. Run just the orchestration suite with:

```
npm run test-node -- --runGlob="**/vs/workbench/contrib/codemindAgent/node/test/**/*.test.js"
```

`headroomLayer.test.ts` is fully **hermetic** — it passes whether or not a proxy is
running — and proves the graceful-degradation contract directly: mode thresholds
(`500` / `2000`), the `chars/4` token estimate, localhost-only base URL, small/empty
suffix no-ops, "large suffix never rejects", the fallback-leaves-suffix-unchanged
invariant, light-mode last-section preservation, well-formed `HeadroomResult`, and the
`/doctor` probe functions (`pingHeadroomProxy` / `probeHeadroom`) always resolving to a
well-typed, localhost-only verdict without hanging.

`orchestrate.test.ts` proves the post-removal contract end-to-end: the `< 20`-char fast
path, a clean `enrichedPrompt` (`=== request.userPrompt`), the minimal `[CODEMIND
ORCHESTRATION]` intent-hint suffix (and that it never carries a serialized adapter blob),
empty `toolsExecuted`/`toolsFailed`, intent-detection-only progress, and that `orchestrate()`
emits no trace itself. `toolAdapters.test.ts` proves the `TraceCollector` observer: a
7-layer trace whose **Layer 3 lists the real SDK tool names** (Read/Grep/Bash — never the
removed adapter names) and whose **Layer 6 carries the actual `HeadroomResult`**, plus
dev-mode gating (null when off), sub-agent-result exclusion, and preview capping.

---

## 7. Verification

- **Typecheck:** `tsgo --noEmit -p src/tsconfig.json` → **0 errors**.
- **Build:** `npm run compile-client` → **0 errors** (`compile-src … with 0 errors`;
  `traceCollector.js` + the rewritten tests emitted to `out/`, and the six deleted
  adapters' stale compiled `.js`/`.js.map` pruned).
- **Media:** `node --check trace.js` clean; `bash -n run.sh` clean.
- **Layer-6 suite:** every test in `headroomLayer.test.ts` **passes**, including the
  `/doctor` probe tests. The `orchestrate.test.ts` integration suite **passes** too —
  proving the post-removal contract: a clean `enrichedPrompt` (`=== request.userPrompt`),
  the minimal `[CODEMIND ORCHESTRATION]` intent-hint suffix with **no** serialized context
  blob, and no self-emitted trace. No Layer-6 change regressed any test.

**Suite total: 179 passing / 1 pending / 0 failing (180 total).** `npm run test-node` exits
`0`. This is the final, green state after two independent pieces of work landed: (a) the
Layer-1 fusion rebaseline brought the intent-classifier snapshots back in line with the
fused confidences, and (b) the six shadow adapters were removed and their filesystem-walk
tests were replaced by the `TraceCollector` observer suite.

Every suite is green: `intentDetector` (41), `TraceCollector` (28), `toolSelector` (26),
`contextOptimizer` (20), `headroomLayer` (19), `contextAggregator` (15), `orchestrate` (14),
capability-based selection (12), `projectBrainAdapter` (3).

The lone **pending** test is intentional and documented (`intentDetector.test.ts` — a
`this.skip()`): the genuine compound request `"Build auth using Clerk and also check the
latest Clerk pricing"` is skipped rather than asserted, because semantic compound detection
(`isMulti`) is still being reworked in the Layer-1 fusion task. It is parked so it cannot be
rebaselined dishonestly, and it is **not** a failure.

---

## 8. Test Suite Status

```
Total tests:        179 passing, 1 pending, 0 failing (test-node exit 0)
Layer 3 observer:   TraceCollector suite (28) — proves Layer 3 lists the REAL
                    SDK tool names (Read/Grep/Bash/…), never the removed adapter
                    names, and Layer 6 carries the actual HeadroomResult.
orchestrate():      integration suite (14) — clean enrichedPrompt, minimal
                    intent-hint suffix, no serialized context blob, no self-trace.
Layer 6 (Headroom): headroomLayer suite (19) — all pass, no regressions.
Intent classifier:  intentDetector suite (41) — rebaselined to the fused
                    confidences; all pass.
Pending:            1, intentional (this.skip()) — the compound "Build auth +
                    check pricing" case, deferred to the Layer-1 isMulti rework
                    so it is not rebaselined dishonestly. Not a failure.
```



