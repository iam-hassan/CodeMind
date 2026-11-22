# CodeMind Design System — Constellation

**Direction:** memory made visible. A developer's workbench with a quiet graph
underneath it: hairlines, node/edge cues, one cool signal for knowledge, one warm
amber for the live agent. Native VS Code first; the identity lives in the
CodeMind webviews, never in upstream chrome.

## Surfaces and mode

| Surface | Mode | Role |
|---|---|---|
| Agent sidebar | Operate | Primary workspace: ask, watch tools, approve, continue |
| Consensus panel | Operate | Pick models, watch deliberation, read the agreed answer |
| Trace panel | Read | Per-turn input and Headroom decision |
| Project Brain dashboard | Read | Pipeline, PostgreSQL tables, Neo4j graph |
| Settings suite | Operate | Settings, MCP, Memory, Skills, Tasks, History |
| Aristotle | Experience | Companion pet; surrounding container only |

## Colour

### Webview tokens (inside VS Code)
```css
:root {
  --cm-signal: #4fc9d9;          /* recalled / persisted knowledge */
  --cm-agent:  #e0a03c;          /* live agent, Aristotle */
  --cm-signal-soft: color-mix(in srgb, var(--cm-signal) 14%, transparent);
  --cm-agent-soft:  color-mix(in srgb, var(--cm-agent) 14%, transparent);
  --cm-edge: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
  --cm-hairline: var(--vscode-widget-border, var(--vscode-panel-border));
  --cm-mono: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);
}
```
- Light themes darken signal to `#0077a3` and agent to `#9a6200`.
- High-contrast maps signal to `contrastActiveBorder`/`focusBorder`, agent to
  `foreground`, and disables decorative edge linework.
- Functional borders use `--vscode-*` tokens. `--cm-edge` is decorative only and
  is never the sole boundary of a control.
- Signal/agent are used as text only where contrast clears 4.5:1; as dots and
  icons they clear 3:1.

### Dashboard tokens (standalone page)
The dashboard receives no `--vscode-*` variables, so it carries its own set in
`scripts/brain-dashboard.html`:
- `--bg`, `--panel`, `--panel2`, `--code`, `--line`, `--text`, `--muted`
- `--accent` (signal), `--agent`, `--ok`, `--warn`, `--bad`
- Dark by default; `prefers-color-scheme: light` overrides; `forced-colors` and
  `prefers-contrast` collapse state colours to system colours.
- Canvas strokes and labels read these tokens at draw time, so the graph follows
  the theme.

## Typography

- UI text: `var(--vscode-font-family)`; body size respects
  `var(--vscode-font-size)`.
- Mono (counts, paths, tool names, statuses, metrics, `#nn`): `--cm-mono`.
- Tabular numerals on every counter, token total, cost, duration, and metric.
- Scale: 11px micro/caption, 12px code, 13px body, 14px subheading, 15–16px
  headings, 17px empty-state title. **Nothing a user reads is below 11px.**
  Two sub-11px tokens remain for disclosure triangles only.
- Dashboard title 15px, card numbers 22px mono.

## Spacing, radius, elevation

- Spacing steps: 2 / 4 / 6 / 8 / 12 / 16 / 24 (and named half-steps in the token
  block).
- Radius: 2 / 4 / 6 / 8. Inputs 2–4, chips/cards 4–6, menus/modals 6–8. No pill
  above 8.
- 1px hairlines on surfaces and dividers.
- Shadows only on floating layers (menus, modals, tooltips). Cards and in-flow
  rows are flat.

## Motion

| Token | Value | Use |
|---|---|---|
| `--cm-dur-press` | 80ms | press |
| `--cm-dur-fast` | 120ms | hover, focus, glyph cross-fade |
| `--cm-dur-base` | 180ms | menus, modals, toggles |
| `--cm-dur-slow` | 260ms | larger state changes |
| `--cm-dur-reveal` | 480ms | one-off entrance / empty-state draw |
| `--cm-ease-out` | `cubic-bezier(.22,1,.36,1)` | entrances |
| `--cm-ease-inout` | `cubic-bezier(.65,0,.35,1)` | glides |
| `--cm-ease-soft-spring` | `cubic-bezier(.34,1.4,.64,1)` | press release |

Rules:
- Animate transform/opacity, plus colour/background/border-colour on small
  elements. Never animate width/height/top/left.
- Expand/collapse uses `grid-template-rows: 0fr → 1fr`.
- Menus open with opacity + 4px translate + `.98 → 1` scale from the anchor.
- Modals: backdrop fade, dialog 8px rise + `.97 → 1`; controls are interactive
  immediately.
- Running tool cards use a slow travelling hairline; status glyphs cross-fade.
- No per-token animation while streaming.
- Reduced motion collapses durations to `.01ms`, removes shimmer/pulse, and draws
  edges/nodes pre-resolved. The product is fully usable with motion off.
- No exit animation where code removes the element immediately.

## Components

- **Node glyph:** inline SVG, 16/24px grid, stroke 1–2, `currentColor`, three
  peripheral nodes joined to one hub. Used for the header, empty state, and agent
  avatar. Aristotle is the only place warm amber lives outside live agent state.
- **Message row:** optional 8px rail with a 1px edge and a node at the assistant
  start; user/system/notice rows hide the rail. Assistant bubbles are transparent
  (no card), user bubbles use the input surface.
- **Tool card:** mono tool name, status glyph, clipped output behind show-more,
  hairline edge. Running/done/error are distinguishable by glyph and text, not
  colour alone.
- **Chips/pills:** 4–6px radius, hairline border, mono where they carry numeric or
  path data.
- **Tables:** hairline rules, sticky header, mono values, tabular numerals.
- **Canvas graph:** category dots keep their label colours; edges, labels, empty
  text, and errors follow the page tokens; 11px labels; one bounded layout pass.

## Accessibility

- Keyboard-first: every interactive element keeps its existing tab order and has
  a visible `:focus-visible` ring using `--vscode-focusBorder` (dashboard:
  `--accent`), 2px, 1–2px offset.
- WCAG AA target in all four themes: text 4.5:1, non-text UI 3:1.
- Decorative linework is `aria-hidden`, `pointer-events: none`, and removed in
  high-contrast.
- No information is conveyed by colour alone: status has a glyph and a label.
- `prefers-reduced-motion` and the workbench's high-contrast body classes are
  both honoured.
- Dashboard tables use real `<table>` semantics; controls are native
  `select`/`input`/`button`.

## File map

| Concern | File |
|---|---|
| Agent tokens, layout, components | `vscodium/.../media/agent.css` |
| Agent transcript/empty-state markup | `vscodium/.../media/agent.js` |
| Agent webview shell | `vscodium/.../browser/codeMindAgentViewPane.ts` |
| Consensus | `vscodium/.../media/consensus.css` |
| Trace | `vscodium/.../media/trace.css` |
| Settings/MCP/Memory/Skills/Tasks/History | `vscodium/.../media/panels.js` + `agent.css` |
| Dashboard | `scripts/brain-dashboard.html` |
| Frozen DOM contract | `redesign/frozen-selectors.md` |
| Deferred items | `redesign/DEFERRED.md` |
| Change log | `redesign/REDESIGN_CHANGELOG.md` |

## Running and verification

1. Apply source edits, then compile the workbench:
   `scripts\setup.bat --compile`.
2. Launch with `scripts\run.bat` (or `run-editor.bat`).
3. Open the CodeMind views in the secondary side bar.
4. Check each surface in Dark Modern, Light Modern, High Contrast Dark, and High
   Contrast Light; at ~300, ~420, and ~640px panel widths.
5. Dashboard: run the Project Brain server, open `http://127.0.0.1:20200`, check
   900 / 1280 / 1920px, and toggle the OS light/dark preference.
6. Keyboard pass: Tab through every control, open/close menus and modals with
   Enter/Escape, confirm focus returns as before.
7. Enable Reduce Motion at the OS level and confirm entrances are instant and the
   product remains usable.
