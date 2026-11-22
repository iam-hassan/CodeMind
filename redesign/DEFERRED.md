# Deferred Work — Constellation Redesign

Everything here needed new data, new messages, changed handlers/timers, a new
dependency, or a change to upstream code. Per the brief's stop condition, none of
it was built.

## 1. Recall thread / lit memory nodes (signature reveal)
**Why deferred:** the Agent webview does not currently receive a recalled-memory
payload (which facts were injected into the turn, or their node ids). Rendering a
lit node plus an edge drawn to a memory chip would require a new host→webview
message and new state.

**Smallest proposed change:** add an optional `recalledMemories` field to the
existing turn message (`{ id, label, confidence }`) from the Project Brain recall
step, then render chips beside the assistant turn and light the existing
`.message-rail-node` for that turn. No layout or handler change is needed.

## 2. Per-turn context sparkline
**Why deferred:** the context meter has the current usage value, but the webview
does not keep per-turn usage history. A sparkline would need new state (or a new
message field).

**Smallest proposed change:** include an optional `usageHistory: number[]` on the
turn-complete message, or keep a bounded in-memory ring of the existing usage
values in the webview. No storage change.

## 3. Live-append transcript entrance animation
**Why deferred:** the transcript uses windowed rendering, so a live append and a
window re-render produce the same DOM. Detecting "live" reliably would require
touching the render/append path.

**Smallest proposed change:** pass an existing "just appended" flag from the
message handler into `renderMessage` (inside `agent.js`), then animate only that
row. Until then, only in-place state changes animate and the existing
`cm-message-enter` class on first render is preserved.

## 4. Exit animations
**Why deferred:** existing code removes elements immediately (menus, toasts,
permission dialogs). Delaying removal for an exit animation would violate the
"no delayed removal" rule.

**Smallest proposed change:** none. Enter animations and in-place cross-fades are
the supported motion for these surfaces.

## 5. Consensus connected-model polygon
**Why deferred:** a deterministic polygon layout for the 3/5/7 selected models
requires per-node placement state that the current card grid does not carry.
The panel keeps the existing card grid and expresses the same model set with
signal/agent hairline states.

**Smallest proposed change:** add a presentational `data-index` (already present
in the generated checkbox markup) and position `::before` connector lines from
the selection order. No new data.

## 6. Dashboard graph "edges draw on load" pass
**Why deferred:** the current canvas force layout already runs one bounded pass
(`ticks < 320`). Overlaying a stroke-dash draw would mean changing the canvas
draw loop or introducing an SVG layer with duplicated node positions.

**Smallest proposed change:** keep the existing loop and fade the whole canvas in
on first paint (CSS opacity transition on `#graph`). Already achieved visually;
no stroke-dash rewrite.

## 7. Aristotle ambient breathing
**Why deferred:** the brief permits a container-only transform, but the frame
elements are also transformed by the animation script. Adding a second transform
on the same element risks fighting the frame timer.

**Smallest proposed change:** add a wrapper element around the existing frames
inside the webview shell and animate only the wrapper. Requires markup change and
a DOM audit; left for a follow-up.

## 8. Agent self-identification as "Claude"
**Why deferred:** identity/system-prompt behaviour, not UI. Noted only because it
was encountered in the product copy (`agent.js` empty state and `product.json`
descriptions). No change made.

## 9. Pre-existing build/test status
The full Electron screenshot matrix and the 81-check + 240-PPB gates could not be
completed in this session. Syntax checks and `git diff --check` were run where
possible (see `REDESIGN_CHANGELOG.md`). No redesign-caused test failure was found;
the remaining gap is execution of the project's own compile/verification commands.

## 10. Report HTML restyle
`CodeMind_Phase2_Report.html` was explicitly "last, only if time allows". It was
not touched.
