# Redesign Changelog — Constellation

Direction: **Constellation / "Memory made visible."** Cool signal cyan marks
recalled or persisted knowledge; warm amber marks the live agent and Aristotle.
Everything else resolves through `--vscode-*` tokens so the panel follows the
workbench theme. All changes are visual; commands, shortcuts, message shapes,
timers, storage, permissions, and upstream code are unchanged.

## Files changed

### `vscodium/.../browser/media/agent.css`
- Added the Constellation token layer (`--cm-signal`, `--cm-agent`, `--cm-edge`,
  soft variants, mono token) with light and high-contrast overrides.
- Kept the full existing `--cm-*` alias scale and extended it with motion,
  spacing, radius, and type tokens.
- Added reduced-motion handling for entrances, glides, pulses, and the empty-state
  linework; added high-contrast removal of decorative linework.
- Restyled the header, empty state, transcript, assistant/user/error/shell rows,
  message rail, thinking rows, tool cards, code/output blocks, todos, diffs,
  menus, composer, queue, background tasks, context meter, modals, permission
  prompts, and settings-panel overlays.
- Raised the readable type floor: `--cm-text-xs` is now 11px and
  `--cm-text-2xs` resolves to 11px. The two remaining sub-11px tokens are
  disclosure-triangle glyphs only.
- Replaced the ported trace-card 9px labels with 11px.
- Brought the radius scale inside the 2/4/6/8 design-system ceiling:
  `--cm-radius-md` is 8px, pills/chips resolve to 6px, and the legacy
  9/12/14px corners clamp to 8px.

### `vscodium/.../browser/media/agent.js`
Visual-only markup changes. No handler, timer, message, or state change.
- `LOGO_MARK_SVG` (~line 166) and `AGENT_AVATAR_SVG` (~line 168): replaced the old
  layered-stack glyph with the connected-node Constellation mark. Same string
  contract, same render call sites.
- `renderEmptyState()` (~line 2965): added one decorative
  `<svg class="constellation-bg" aria-hidden="true" focusable="false">` with two
  groups (`.constellation-lines`, `.constellation-nodes`) behind the welcome copy.
  Pure CSS linework; no data, no interaction.
- `renderMessage()` (~line 3066): added one presentational
  `<div class="message-rail" aria-hidden="true">` with `.message-rail-line` and
  `.message-rail-node`. It is inserted before the avatar and ignored by all
  handlers. User/system/notice rows hide it in CSS.

### `vscodium/.../browser/codeMindAgentViewPane.ts`
- Header brand glyph (~line 838): swapped the stacked-pyramid SVG for the same
  connected-node Constellation glyph used by the transcript. Markup only; the
  surrounding `id`/class contracts are unchanged.

### `vscodium/.../browser/media/consensus.css`
- Added Constellation signal/agent tokens and light/high-contrast overrides.
- Flattened cards and containers to hairline surfaces; removed card shadows.
- Signal marks deliberation/final-answer state; agent marks live work.
- Added tabular numerals and mono for counts; raised `--cm-text-xs` to 11px and
  reduced `--cm-radius-lg` to 8px.

### `vscodium/.../browser/media/trace.css`
- Added Constellation tokens, state colours, and mono/tabular metrics.
- Raised every 10px label to 11px and `--cm-text-xs` to 11px.
- Kept the existing card structure, empty state, and clear action.

### `scripts/brain-dashboard.html`
- Replaced the dark-only literal palette with standalone Constellation tokens,
  including `prefers-color-scheme: light`, `forced-colors`, and
  `prefers-contrast` overrides.
- Hairline cards/sections/tables, mono tabular counters, calmer project selector
  and reset actions, and visible focus rings.
- Converted status pills, stage/check states, and table rules from literal rgba
  to `color-mix` on the standalone tokens.
- Raised `.tag` to 11px and flattened chips to a 4px radius.
- Canvas graph now reads `--line`, `--muted`, `--bad`, and `--mono` from the page
  at draw time, so edges, labels, empty text, and error text follow the theme.
  Node label text is 11px and labels skip positions they would collide with, so
  the graph stays legible without changing node placement. Graph layout,
  polling, fetch, reset, and signature caching are untouched.
- Empty-table placeholder now uses `var(--muted)` instead of a literal grey.

### `PRODUCT.md`, `REDESIGN_PLAN.md`, `DESIGN.md`, `redesign/*`
- Product truth, the approved direction, the design system, the frozen selector
  inventory, the deferred list, and this changelog.

## What deliberately did not change
- Every command, shortcut, slash command, composer mode, state machine,
  permission scope, session action, queue rule, MCP/skill/memory/task flow,
  endpoint setting, API-key path, Project Brain pipeline, Headroom path,
  Consensus logic, and dashboard endpoint.
- Message shapes, timers, handlers, storage, dependencies, and upstream
  workbench/`product.json` files.
- `opencode.json` (pre-existing local key modification; not part of this work).

## Verification performed
- `node --check` passes on `agent.js`, `consensus.js`, `trace.js`,
  `scripts/brain-dashboard.mjs`, and the dashboard's inline script.
- CSS brace/paren balance check passes over the three edited stylesheets and the
  inline dashboard style block.
- `git diff --check` passes (excluding the pre-existing `opencode.json` change).
- `scripts/setup.bat --compile` completed twice with **0 errors** after the
  redesign changes (re-overlays `vscodium/src/stable` onto `vscodium/vscode`
  and recompiles the workbench).
- Headless render of the dashboard with mocked `/api/data` (Playwright + Chrome):
  all sections and the canvas graph render at 900 / 1280 / 1920px in dark and at
  1280px in light; no console errors, no horizontal overflow, and no visible
  text under 11px. Screenshots under `redesign/screens/`.
- The project's own 81-check / 240-PPB verification suites and the Electron
  visual matrix are for the gate environment; see `DEFERRED.md` item 9.
