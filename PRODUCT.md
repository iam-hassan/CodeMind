# CodeMind — Product Truth

> This file owns **durable product truth** only. It does not invent a visual
> world. Visual decisions live in the design-brief that follows the redesign
> direction choice, and eventually in `DESIGN.md`.

## Platform

- A **desktop Electron application**: a VS Code distribution built on
  VSCodium, which builds on Microsoft's VS Code sources (pinned at VS Code
  1.126.0).
- The agent panel is **compiled into the editor core** — not an extension. It
  lives permanently in the secondary side bar, present in every window without
  an extension-host round trip.
- Panel UI is a **self-contained webview** (no bundler, no CDN): `agent.js`,
  `input.js`, `panels.js`, `buddy.js`, `agent.css`.
- A companion **read-only web dashboard** ("Project Brain") is served at
  `http://127.0.0.1:20200` from `scripts/brain-dashboard.html`.
- Design target is a typical desktop IDE window (no mobile/web target is part of
  this project's promise).

## Users

- **Primary:** the student author of this FYP, demonstrating CodeMind to
  **evaluators and first-time viewers**. First-run impression and clarity carry
  the most weight.
- **Secondary:** a solo developer using CodeMind on real projects — long
  sessions, many files, permission prompts, sessions per project.

## Purpose

CodeMind folds a Claude Code agent into the IDE itself. A developer asks for
work, watches the assistant think, call tools (read/write/edit/bash/glob/grep/web
search/web fetch/task/todo/notebook/MCP), and approve or deny each call, all
inside the editor's own chrome. The Project Brain underneath remembers project
knowledge (PostgreSQL/pgvector + Neo4j) and injects relevant memories back into
later turns.

## Positioning

- **Native-to-VS-Code** agent experience: it must feel like part of the editor,
  not a web app bolted on. Theme tokens, side-bar layout, native menus, editor
  typography all matter.
- **A developer's workbench**, not a consumer chatbot. Density, precision and
  calm win over marketing loudness.
- **Independent:** not affiliated with or endorsed by Anthropic or Microsoft.

## Capabilities (what must keep working — UI changes only)

- Streaming a Claude Code turn: assistant text, thinking, tool calls/results,
  token and cost usage.
- Claude Code tool set: read, write, edit, bash, glob, grep, web search, web
  fetch, task, todo, notebook, MCP tools — with a per-call permission prompt
  (allow once / allow for the session / deny), scoped per project.
- Slash commands: `/model`, `/context`, `/compact`, `/cost`, `/memory`, `/mcp`,
  `/doctor`, `/export`, `/feedback`, `/rewind`, `/review`, `/pr_comments`,
  `/brain`, `/rename`, `/tag`, `/color`.
- Composer modes: normal, plan, edit (one menu); `!` sends a line to the shell;
  `#` writes to a memory file.
- Sessions persist per project; cancel, resume, rewind; queued prompts while a
  turn runs.
- MCP servers, skills, memory directories, tasks, and a context-pressure
  indicator with auto-compaction.
- Endpoint settings: Anthropic API key (stored in the editor's secret storage,
  never written to disk/repo), optional custom Anthropic-compatible base URL and
  model name.
- Multi-Agent Consensus panel: pick 3/5/7 models, watch deliberation, agreed
  answer.
- Orchestration Trace panel: per-turn input with Headroom compression decisions.
- Project Brain dashboard: pipeline telemetry, PostgreSQL tables
  (memories/decisions/events/conflicts), Neo4j graph, project selector.
- Six settings-style panels: Settings, MCP, Memory, Skills, Tasks, Chat History.
- **Aristotle**, the animated companion pet (idle/sleep/stretch/play frames).

## Constraints (binding)

- **UI-only redesign.** No feature or behaviour change: every command, shortcut,
  state machine, message shape, permission flow, and data flow stays exactly as
  it is.
- **Native VS Code feel** is a hard requirement — stay inside workbench
  conventions, theme tokens, native menus, editor typography.
- **Accessibility baseline:** keyboard-first, WCAG AA contrast, visible focus,
  reduced-motion support. (The incumbent already sweeps contrast across
  dark/light/high-contrast themes at ≥ 3.0:1.)
- **Desktop only.**

## Existing brand & assets

- **Name**: CodeMind. **Panel wordmark**: "CodeMind".
- **Pet**: Aristotle — animation frames under
  `vscodium/src/stable/src/vs/workbench/contrib/codemindAgent/browser/media/aristotle/`.
- **Incumbent visual language** (replacement candidates must supersede, not
  polish): full token scale of `--vscode-*` colour aliases; typography 8–17 px;
  spacing 2–16 px; a motion scale with reduced-motion support; an indigo accent
  used sparingly. This is the old world's evidence of what the subject *is*, not
  authority over what it *becomes*.
- **Licence**: none chosen yet for CodeMind-specific work (all rights reserved
  for now).

## Non-goals

- No feature additions, no new surfaces, no new commands, no behaviour changes.
- No web/mobile responsive target.
- No packaging/release work — this is a development build, not a shipped app.
- No API-key handling changes (security posture stays exactly as it is).