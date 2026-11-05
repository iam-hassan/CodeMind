# CodeMind

CodeMind is a VS Code distribution with a Claude Code agent panel built into the
workbench itself. The panel is not an extension: it is compiled into the editor
core, lives permanently in the secondary side bar, and talks to Anthropic's
models through the Claude Agent SDK running in one of the editor's own utility
processes.

It is built on [VSCodium](https://github.com/VSCodium/vscodium), which builds on
Microsoft's VS Code sources. This repository carries the CodeMind sources and the
VSCodium base; the VS Code checkout they are compiled against is fetched by the
setup script from the commit pinned in `vscodium/upstream/stable.json`
(VS Code 1.126.0).

CodeMind is an independent project and is not affiliated with, endorsed by, or
supported by Anthropic or Microsoft.

## What the panel does

- Streams a Claude Code turn into the panel: assistant text, thinking, tool
  calls and their results, token and cost usage.
- Runs the Claude Code tool set — read, write, edit, bash, glob, grep, web
  search, web fetch, task, todo, notebook, MCP tools — with a permission prompt
  per call (allow once, allow for the session, deny), scoped per project.
- Ports the CLI's slash commands to the GUI, including `/model`, `/context`,
  `/compact`, `/cost`, `/memory`, `/mcp`, `/doctor`, `/export`, `/feedback`,
  `/rewind`, `/review` and `/pr_comments`.
- Composer modes: normal, plan and edit, chosen from one menu; `!` sends a line
  to the shell and `#` writes to a memory file, as in the CLI.
- Sessions persist per project and can be cancelled, resumed and rewound;
  prompts sent while a turn is running are queued.
- MCP servers, skills, memory directories, tasks and a context-pressure
  indicator with auto-compaction.
- Endpoint settings: an Anthropic API key, and optionally a custom
  Anthropic-compatible base URL and model name. The key is entered in the panel
  and kept in the editor's own secret storage — nothing writes it into this
  repository or into the workspace.

## Requirements

| Tool | Why | Minimum |
| --- | --- | --- |
| git | fetches the pinned VS Code source | any recent |
| node | runs the build and the editor | `vscodium/.nvmrc` (24.15.0) |
| npm | installs the workbench dependencies | ships with node |
| jq | the prepare step rewrites `product.json` with it | 1.6 |
| curl | downloads the Electron runtime | any recent |
| python3 | node-gyp builds the native modules with it | 3.8 |
| bun | installs the Claude Agent SDK from `claude-code/bun.lock` | 1.0 |

Plus a C/C++ toolchain for the native modules: `build-essential libx11-dev
libxkbfile-dev libsecret-1-dev libkrb5-dev` on Debian/Ubuntu, the Xcode command
line tools on macOS, or the Visual Studio Build Tools with the "Desktop
development with C++" workload on Windows.

## Setup

A clone does not contain the VS Code checkout, the compiled workbench, the
Electron runtime or the SDK. `scripts/setup.sh` produces all four. The first run
downloads a VS Code checkout and its dependencies and then compiles the
workbench — budget an hour and several GB of disk.

Linux and macOS:

```bash
git clone https://github.com/iam-hassan/CodeMind.git
cd CodeMind
scripts/setup.sh --check     # check the prerequisites and stop
scripts/setup.sh             # full setup
```

Windows (from `cmd` or PowerShell — the build scripts are bash, so this checks
Git Bash and the C++ toolchain and then hands over to `scripts/setup.sh`):

```bat
git clone https://github.com/iam-hassan/CodeMind.git
cd CodeMind
scripts\setup.bat --check
scripts\setup.bat
```

What setup produces, all of it ignored by git:

| Path | What it is |
| --- | --- |
| `vscodium/vscode/` | the pinned VS Code checkout, with VSCodium's patches applied and `vscodium/src/stable` overlaid on top |
| `vscodium/vscode/out/` | the compiled workbench |
| `vscodium/vscode/.build/` | the Electron runtime the development build runs in |
| `claude-code/node_modules/` | the Claude Agent SDK the engine imports |

## Running it

```bash
scripts/run.sh [folder]      # Linux, macOS
scripts\run.bat [folder]     # Windows; starts the Project Brain stack too
```

This runs the compiled workbench through the Electron runtime; it is a
development build, not a packaged application. On first use the panel asks for an Anthropic API key and stores it in the editor's secret storage.

On Windows, `scripts\run.bat` starts PostgreSQL/pgvector, Neo4j, Redis, the local development embedding stand-in, Headroom when available, and CodeMind. It opens a new window; pass a folder to open that project:

```powershell
scripts\run.bat D:\path\to\project
```

The Project Brain is enabled by default. Its dashboard is available at `http://127.0.0.1:20200` and shows the selected project's pipeline telemetry, PostgreSQL records, and Neo4j graph. Use `/brain` in the CodeMind panel to view brain status.

After editing the panel sources, re-overlay and recompile:


```bash
scripts/setup.sh --compile
```

Windows:

```bat
scripts\setup.bat --compile
```

`vscodium/src/stable` is an overlay — nothing in the build copies it for you, so
edits there only reach the workbench through this step.

## Persistent Project Brain (PPB)

The Project Brain is integrated into CodeMind's normal launch path. It stores
project knowledge in PostgreSQL/pgvector and Neo4j, retrieves relevant memories,
and exposes the `project_brain` tool to the agent. The brain is enabled by
default; set `CODEMIND_PPB_ENABLED=0` only when you explicitly want it disabled.

### PPB prerequisites

Start Docker Desktop. The local PPB stack uses:

| Service | Host port |
|---|---:|
| PostgreSQL + pgvector | `55432` |
| Neo4j Bolt | `57687` |
| Neo4j HTTP | `57300` |
| Redis | `56379` |
| Project Brain dashboard | `20200` |

The normal Windows launcher starts the stack and the local development embedding
stand-in automatically:

```bat
scripts\run.bat [folder]
```

For PowerShell users, the equivalent explicit launcher is:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-brain.ps1 D:\path\to\project
```

The launcher reads optional provider overrides from:

```text
%USERPROFILE%\.codemind\ppb.env
```

Normally, select the chat provider, model, and API key in the CodeMind panel.
The extraction model follows the selected chat model. The panel endpoint is
normalized automatically for the OpenAI-shaped extraction request. Use a model
that returns JSON content for extraction; reasoning-only models may return empty
content. A real embedding provider can replace the local stand-in with
`PPB_EMBED_BASE_URL`, `PPB_EMBED_MODEL`, and `PPB_EMBEDDING_DIM` overrides.

### PPB dashboard

Open the read-only verification dashboard at:

```text
http://127.0.0.1:20200
```

It provides a project selector, a layer-by-layer pipeline view, telemetry rows,
PostgreSQL memories/decisions/events/conflicts, and a scoped Neo4j graph. The
Reset project and Reset all actions clear PPB data; reset also clears the relevant
CodeMind session runtime so stale todo plans do not return.

For a real-project smoke test:

1. Launch with `scripts\\run.bat D:\\path\\to\\project`.
2. In the panel, send a durable fact, for example: `We use PostgreSQL for persistence.`
3. Look for `project_brain` tool cards: `extract`, `save`, `recall`, and `inject`.
4. Select the project in the dashboard and confirm the checklist, telemetry, DB rows,
   embeddings, and Neo4j nodes are populated.

Detailed PPB testing instructions are in `docs/ppb/BRAIN_UI_QUICKSTART.md` and the
200-scenario execution report is in `docs/ppb/SCENARIO_EXECUTION_REPORT.md`.

## Project structure

```
vscodium/    — VSCodium base (build scripts, patches, rebrand)
vscodium/src/stable/src/vs/workbench/contrib/codemindAgent/
             — all CodeMind-specific source (the agent panel)
claude-code/ — Claude Agent SDK and CLI source (vendored)
scripts/     — setup, run, and dev helper scripts
```

Two more things worth knowing about that layout. `vscodium/src/stable` is
VSCodium's overlay directory: `prepare_vscode.sh` copies it over the VS Code
checkout, which is how the panel's twelve source files end up inside the
workbench tree without a fork of VS Code itself. Where the panel needs an
upstream file changed rather than added, the change is a patch under
`vscodium/patches/` — `00-codemind-agent-panel.patch` registers the
contribution, and `00-codemind-build-hygiene.patch` carries the build-side
adjustments — applied by the same prepare step.

## Architecture

The panel is five layers. A workbench contribution
(`browser/codemindAgent.contribution.ts`) registers a view container in the
secondary side bar, so the panel is present in every window without an
extension host round trip. The view pane
(`browser/codeMindAgentViewPane.ts`, with `browser/codeMindCommands.ts` for the
slash commands and `browser/codeMindBuddy.ts` for the companion) hosts a webview,
owns session state, and drives the permission flow. The UI itself is a
self-contained webview — `browser/media/agent.js`, `input.js`, `panels.js`,
`buddy.js` and `agent.css`, no bundler and no CDN, every colour a
`var(--vscode-*)` token so it follows the active theme. Below that,
`common/codeMindAgentEngineService.ts` defines the protocol both sides share and
`electron-sandbox/codeMindAgentEngineService.ts` implements the renderer half as
a thin proxy. The fifth layer, `node/codeMindAgentEngineMain.ts`, is the engine.

The engine runs in a utility process worker, started through
`IUtilityProcessWorkerWorkbenchService`, and every call and event between it and
the renderer is marshalled over IPC with `ProxyChannel`. It imports the Claude
Agent SDK in process — a dynamic `import()` of
`claude-code/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, resolved by
walking up from `import.meta.url` until it finds the sibling `claude-code`
directory — so there is no CLI subprocess: the SDK's own query loop runs inside
the worker, and its message stream is translated into the panel's event protocol.
Keeping it out of the renderer means a hung turn or a crashed SDK cannot take the
window with it. The API key never reaches the webview or the disk: the renderer
reads it from secret storage and passes it to the worker as a call argument, and
the worker puts it in the environment it hands the SDK for that query.

## Verification

The panel was verified at runtime rather than by unit tests: 81 checks (T-000
through T-156, plus four post-verification checks) driven against a live build
over the Chrome DevTools protocol — cold launch, every tool, every slash command,
the permission flow, session persistence, cancel and resume, MCP, memory, skills
and tasks. All pass except the three below, which the environment could not
complete. Contrast was swept across the dark, light, high-contrast dark and
high-contrast light themes with no element below 3.0:1.

## Known limitations

- **WebFetch through a custom endpoint.** The tool card renders the URL, the
  prompt and a result, but the body is an error when the configured endpoint is a
  third-party Anthropic-compatible gateway that refuses server-side fetches. The
  network path itself is fine; this needs a first-party `api.anthropic.com` key,
  against which it has not been verified.
- **The `/context` token breakdown through a custom endpoint.** The panel's own
  context view is correct, but the engine-side per-category breakdown (system
  prompt, tools, memory, message categories) needs
  `POST /v1/messages/count_tokens`, which not every Anthropic-compatible endpoint
  implements. Where it is missing, the breakdown is unavailable.
- **`/pr_comments` needs the GitHub CLI.** Without `gh` on `PATH` the command
  declines with an install hint instead of reading the pull request. It has not
  been exercised against a live PR.

## License

No licence has been chosen for CodeMind yet, so the CodeMind-specific work in
this repository is all rights reserved for now. Two things that sit alongside it:

- Upstream VS Code and VSCodium remain under their own MIT licences — see
  `vscodium/LICENSE`. The panel's own source files still carry the MIT file
  header inherited from VS Code's header convention; that header and this section
  need reconciling when a licence is picked.
- `claude-code/` is vendored third-party material, present because the engine
  imports the Claude Agent SDK from it. It is not covered by anything this
  project licenses.
