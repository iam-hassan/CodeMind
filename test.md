# CodeMind — Project Summary

## What it is

CodeMind is a **custom VS Code distribution** with an AI coding agent panel compiled
directly into the workbench core — not shipped as an extension. The panel lives
permanently in the secondary side bar and talks to Anthropic's models through the
**Claude Agent SDK**, which runs inside one of the editor's own utility processes.

It is built on [VSCodium](https://github.com/VSCodium/vscodium), which in turn builds on
Microsoft's VS Code sources (pinned to VS Code 1.126.0 via `vscodium/upstream/stable.json`).
This is a Final Year Project (FYP) repository.

## Repository layout

| Path | Purpose |
| --- | --- |
| `vscodium/` | VSCodium base — build scripts, patches, rebranding |
| `vscodium/src/stable/src/vs/workbench/contrib/codemindAgent/` | All CodeMind-specific source (the agent panel) |
| `vscodium/patches/` | Patches applied to upstream VS Code files |
| `claude-code/` | Vendored Claude Agent SDK and CLI source |
| `scripts/` | `setup.sh` / `setup.bat`, `run.sh` / `run.bat` |
| `README.md` | Setup, architecture, verification, limitations |
| `implementation_plan.md` | Technical plan for the LLM Consensus integration |

`vscodium/src/stable` is an **overlay directory**: `prepare_vscode.sh` copies it over the
VS Code checkout, which is how the panel's source files land inside the workbench tree
without forking VS Code. Where an upstream file must be *changed* rather than *added*, the
change ships as a patch (`00-codemind-agent-panel.patch` registers the contribution,
`00-codemind-build-hygiene.patch` carries build-side adjustments,
`00-codemind-hide-chat-view.patch` hides the built-in chat view).

## Architecture — five layers

1. **Workbench contribution** — `browser/codemindAgent.contribution.ts` (420 lines)
   Registers the view container in the secondary side bar and ~25 `codemind.*`
   configuration properties (model, endpoint, permission mode, effort, sandbox, MCP
   servers, companion, etc.). No extension host round trip.
2. **View pane** — `browser/codeMindAgentViewPane.ts` (3,867 lines)
   Hosts the webview, owns session state, drives the permission flow.
   Companions: `codeMindCommands.ts` (3,877 lines, slash commands) and
   `codeMindBuddy.ts` (the companion creature).
3. **Webview UI** — `browser/media/` — `agent.js` (4,555 lines), `input.js`, `panels.js`,
   `buddy.js`, `agent.css`. Self-contained, **no bundler and no CDN**; every colour is a
   `var(--vscode-*)` token so the UI follows the active theme.
4. **IPC protocol** — `common/codeMindAgentEngineService.ts` defines the shared protocol;
   `electron-sandbox/codeMindAgentEngineService.ts` is the renderer-side proxy.
5. **Engine** — `node/codeMindAgentEngineMain.ts` (2,833 lines)
   Runs in a utility process worker via `IUtilityProcessWorkerWorkbenchService`; all calls
   and events are marshalled with `ProxyChannel`. It **dynamically imports the Claude Agent
   SDK in-process** (`@anthropic-ai/claude-agent-sdk/sdk.mjs`) rather than spawning a CLI
   subprocess, so a hung turn or crashed SDK cannot take the window down with it.

**Key security property:** the Anthropic API key never reaches the webview or the disk. The
renderer reads it from the editor's secret storage and passes it to the worker as a call
argument; the worker injects it into the environment handed to the SDK for that one query.

## Panel features

- Streams a full agent turn: assistant text, thinking, tool calls and results, token/cost usage.
- Full Claude Code tool set — read, write, edit, bash, glob, grep, web search, web fetch,
  task, todo, notebook, MCP — each gated by a per-project permission prompt
  (allow once / allow for session / deny).
- CLI slash commands ported to the GUI: `/model`, `/context`, `/compact`, `/cost`,
  `/memory`, `/mcp`, `/doctor`, `/export`, `/feedback`, `/rewind`, `/review`, `/pr_comments`.
- Composer modes (normal, plan, edit); `!` sends a line to the shell, `#` writes to memory.
- Sessions persist per project — cancellable, resumable, rewindable; prompts sent mid-turn queue.
- MCP servers, skills, memory directories, tasks, context-pressure indicator with auto-compaction.

## Multi-Agent LLM Consensus (the FYP's distinguishing feature)

Layered on top of Plan Mode, this dispatches a prompt to **3–7 LLMs concurrently via
OpenRouter**, has them critique each other, and runs **PBFT (Practical Byzantine Fault
Tolerance)** rounds until they agree. Ported from a separate `LLM_consensus` project.

Implemented in `browser/consensus/`:

| File | Role |
| --- | --- |
| `models.ts` | Model configs, `fetchFreeModels()` (filters OpenRouter for zero-price text models), `computePBFTConfig()` — derives `f ≤ (n-1)/3` and the `(2f+1)/n` agreement threshold |
| `openRouterService.ts` | Parallel fan-out queries, critique generation, revision rounds, and a project-relevance gate (`checkRelevance`) |
| `consensusEngine.ts` | Cosine similarity, hallucination detection, `runPBFTPhase()`, reputation scoring |
| `agentRouter.ts` | Maps task type (factual_qa / reasoning / math / code / creative / multi_step) to a prompting strategy (CoT, self-consistency, ReAct, ToT, PoT, chain-of-verification) |
| `forcedConsensus.ts` | Weighted-vote synthesis when the threshold is never met naturally |
| `consensusOrchestrator.ts` | Drives the pipeline and streams events (`pbft_phase_change`, `task_spec`, `consensus_blocked`, …) |

UI side: `browser/codeMindConsensusPanel.ts` manages a standalone webview panel rendering a
phase indicator, validator network graph (SVG), model proposal cards and a live critique
feed (`media/consensus.js`, `media/consensus.css`). Commands
`workbench.action.openCodeMindConsensus` / `closeCodeMindConsensus` control it.

A **project-scope relevance gate** runs before the models do: if the question isn't about
the open project, consensus is blocked rather than executed
(`consensusOrchestrator.ts:83-112`).

## Tech stack

- **TypeScript** for all workbench code; **vanilla JS/CSS** for webviews (zero dependencies).
- **Electron / VS Code workbench** platform; Node.js utility processes for the engine.
- **Build tooling:** gulp (VS Code's own), VSCodium's bash patch/prepare scripts, node-gyp
  for native modules, `bun` for installing the Claude Agent SDK.
- **External services:** Anthropic API (or any Anthropic-compatible gateway) for the agent;
  OpenRouter API for the consensus models.

## Building and running

Prerequisites: git, node 24.15.0 (`vscodium/.nvmrc`), npm, jq 1.6, curl, python3 ≥ 3.8, bun,
plus a C/C++ toolchain. A clone contains no VS Code checkout, compiled workbench, Electron
runtime or SDK — `scripts/setup.sh` produces all four (budget an hour and several GB).

```bash
scripts/setup.sh --check     # verify prerequisites only
scripts/setup.sh             # full setup
scripts/setup.sh --compile   # re-overlay + recompile after editing panel sources
scripts/run.sh [folder]      # launch the development build
```

Windows equivalents: `scripts\setup.bat`, `scripts\run.bat` (they check the toolchain, then
hand over to the bash scripts). Note that `vscodium/src/stable` edits only reach the
workbench through `--compile` — nothing copies the overlay automatically.

## Verification status

Verified at runtime rather than by unit tests: 81 checks (T-000 → T-156 plus four
post-verification checks) driven against a live build over the Chrome DevTools protocol —
cold launch, every tool, every slash command, permissions, session persistence, cancel and
resume, MCP, memory, skills, tasks. Contrast was swept across dark, light, high-contrast
dark and high-contrast light themes with nothing below 3.0:1.

## Known limitations

- **WebFetch through a custom endpoint** returns an error body when the configured gateway
  refuses server-side fetches; needs a first-party `api.anthropic.com` key to verify.
- **`/context` token breakdown** requires `POST /v1/messages/count_tokens`, which not every
  Anthropic-compatible endpoint implements.
- **`/pr_comments`** needs the GitHub CLI (`gh`) on `PATH`; untested against a live PR.

## Licensing

No licence chosen yet — CodeMind-specific work is all rights reserved for now. Upstream
VS Code and VSCodium remain MIT (`vscodium/LICENSE`); the panel's source files still carry
the inherited MIT header, which needs reconciling when a licence is picked. `claude-code/`
is vendored third-party material not covered by this project's licensing.

## Notes / discrepancies worth flagging

1. **Hardcoded OpenRouter API key.** `browser/consensus/models.ts:84` contains a literal
   `sk-or-v1-...` key committed to the repository. It should be moved into the editor's
   secret storage (as the Anthropic key already is) and the exposed key revoked.
2. **Consensus code lives in `browser/`, not `node/`.** `implementation_plan.md` specifies
   `node/consensus/*`, but the modules were implemented under `browser/consensus/*`. This
   means the OpenRouter calls run in the renderer rather than the isolated utility worker,
   which is inconsistent with how the Anthropic path is sandboxed.
3. **Task routing is stubbed.** `consensusOrchestrator.ts:115` hardcodes `routeTask('factual_qa', …)`
   with `isCreative = false`, so `agentRouter.ts`'s other strategies (ToT, PoT,
   self-consistency) are currently unreachable.
