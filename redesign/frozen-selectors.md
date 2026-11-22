# Frozen Selectors — Constellation Redesign

Inventory of every DOM hook the redesign must not rename, remove, or re-parent.
Generated from a grep of `getElementById`, `querySelector(All)`, `classList`,
`dataset`, and logic-bearing `aria-*` / `role` usage across the CodeMind webviews.

**Freeze rule:** no selector below may be renamed, removed, or re-parented. Add a new
class or attribute for styling instead. Preserve tab order and element order unless
focus order is verified identical. `.message-rail`, `.constellation-bg`, and the
constellation logo SVGs are *new presentational hooks*; they are not referenced by
JavaScript and add no behaviour.

## Main Agent Panel
`codeMindAgentViewPane.ts`, `agent.js`, `input.js`, `panels.js`, `buddy.js`, `aristotle.js`

### IDs used by script
- Header / session: `newSessionBtn`, `historyBtn`, `settingsBtn`, `devModeBtn`, `devModeDismiss`, `devModeBanner`
- Identity / status: `statusDot`, `statusText`, `sessionName`, `sessionTags`
- Composer: `input`, `sendBtn`, `stopBtn`, `sendSlot`, `inputMode`, `composerHint`
- Menus: `modelPill`, `modelMenu`, `modePill`, `modeMenu`, `slashMenu`, `slashHint`, `mentionMenu`
- Consensus toggle: `consensusPillWrap`, `consensusPillCheckbox`, `consensusPillSliderBg`, `consensusPillSliderKnob`
- Attachments: `attachBtn`, `filePicker`, `attachments`, `micBtn`, `mentionBtn`
- Context / queue / tasks: `contextMeter`, `contextBarFill`, `contextText`, `promptQueue`, `bgPill`, `bgPillText`, `bgTasks`
- Transcript: `messages`, `chatScroll`, `sessionTokens`, `vimIndicator`
- Modals: `apiKeyModal`, `apiKeyInput`, `apiKeySave`, `apiKeyCancel`
- Permission dialog: `permissionModal`, `permTitle`, `permIntro`, `permToolName`, `permInput`, `permReason`, `permScopes`, `permFeedbackGroup`, `permFeedback`, `permAllow`, `permAllowSession`, `permDeny`
- Settings host: `codemind-panel-host`, `panelClose`, `panelTitle`, `panelBody`
- Aristotle: `aristotle`

### Classes used by script or state
- Messages: `.message`, `.message.user`, `.message.assistant`, `.message.error`, `.message.system`, `.message.shell`, `.message.is-notice`, `.message-content`, `.message-avatar`, `.message-header`, `.message-body`, `.message-role`, `.message-time`, `.cm-message-enter`
- Stream: `.stream-blocks`, `.stream-tail`, `.streaming-cursor`
- Tools: `.tool-card`, `.tool-card-body`, `.tool-name`, `.tool-target`, `.tool-mark`, `.tool-outcome`, `.tool-children`, `.tool-markdown`, `.tool-output`, `.tool-label`, `.clip-toggle`, `.tool-subblock`
- Thinking: `.thinking`, `.thinking-body`, `.thinking-label`, `.thinking-elapsed`
- Code: `.code-block`, `.code-bar`, `.copy-btn`, `.copied`
- Composer: `.composer`, `.composer-controls`, `.composer-entry`, `.composer-icon`, `.model-pill`, `.mode-pill`, `.bg-pill`, `.bg-pill-dot`, `.send-btn`, `.stop-btn`, `.send-slot`, `.send-slot.is-streaming`
- Context: `.context-meter`, `.context-bar`, `.context-bar-fill`, `.context-text`
- Menus: `.slash-menu`, `.slash-item`, `.slash-item.selected`, `.slash-name`, `.slash-desc`, `.slash-args`, `.mention-menu`, `.mention-item`, `.mention-item.selected`, `.mention-name`, `.mention-detail`, `.model-menu`, `.model-menu-item`, `.model-menu-item[aria-selected="true"]`, `.model-menu-name`, `.model-menu-provider`, `.model-menu-check`, `.model-menu-search`, `.model-menu-search-wrap`, `.model-menu-empty`, `.mode-menu`, `.mode-menu-item`
- Queue / tasks / attachments: `.queued-prompt`, `.queued-index`, `.queued-text`, `.queued-remove`, `.bg-task`, `.bg-task-kind`, `.bg-task-label`, `.bg-task-elapsed`, `.bg-task-action`, `.bg-task-forget`, `.attachment-chip`, `.attachment-chip-image`, `.attachment-name`, `.attachment-remove`, `.attachment-preview-popup`
- Banners / modes: `.input-mode`, `.input-mode.is-shell-mode`, `.input-mode.is-memory-mode`, `.hint-chip`, `.hint-search`, `.empty-state`
- Modals / panels: `.modal-overlay`, `.modal`, `.modal-actions`, `.btn`, `.btn-primary`, `.btn-secondary`, `.panel-window`, `.panel-header`, `.panel-body`, `.panel-close`, `.panel-overlay`
- Settings rows: `.setting-group`, `.setting-hint`, `.setting-label`, `.provider-row`, `.provider-name`, `.provider-detail`, `.provider-actions`, `.mcp-row`, `.mcp-name`, `.mcp-detail`, `.mcp-status`, `.mcp-actions`, `.history-row`, `.history-search`, `.history-path`, `.history-meta`
- State helpers: `.hidden`, `.is-closing`, `.is-opening`, `.is-selected`, `.is-expanded`, `.accented`, `.recording`, `.plan-mode` (body class), `.status-dot`, `.status-dot.ready`, `.status-dot.thinking`, `.status-dot.error`
- AskUserQuestion: `.ask-option`, `.ask-send`
- Thread windowing: `.thread-sentinel`, `.thread-spacer`

### Data attributes read by script
`data-tool`, `data-think`, `data-status`, `data-id`, `data-idx`, `data-index`, `data-path`, `data-value`, `data-provider`, `data-mode`, `data-clip-toggle`, `data-ask-id`, `data-ask-opt`, `data-ask-q`, `data-ask-send`, `data-bg-check`, `data-bg-stop`, `data-bg-forget`, `data-wired`, `data-url`

### ARIA / roles used by logic
`aria-expanded`, `aria-haspopup`, `aria-selected`, `aria-label`, `aria-hidden`, `aria-modal`, `aria-live`, `role="listbox"`, `role="option"`, `role="dialog"`

## Multi-Agent Consensus Panel
`codeMindConsensusPanel.ts`, `consensus.js`

### IDs
`promptInput`, `submitBtn`, `statusBanner`, `currentPhase`, `phaseMessage`, `mainContent`, `modelGrid`, `eventLog`, `finalResult`, `finalAnswer`, `modelCheckboxes`, `modelSelectionError`, `dropdownBtn`, `dropdownContent`

### Classes
`.consensus-container`, `.header`, `.brand`, `.brand-mark`, `.brand-text`, `.input-area`, `.model-selection`, `.model-checkboxes`, `.custom-dropdown`, `.dropdown-btn`, `.dropdown-content`, `.model-checkbox-label`, `.error-text`, `.loading-models`, `.status-banner`, `.status-dot`, `.status-text`, `.btn-primary`, `.btn-label`, `.main-content`, `.model-grid`, `.model-card`, `.card-header`, `.card-title`, `.card-confidence`, `.card-body`, `.card-answer`, `.card-reasoning`, `.event-log-container`, `.event-log`, `.event-item`, `.event-time`, `.critique-bubble`, `.final-result`, `.final-answer`, `.fa-section`, `.fa-label`, `.fa-body`, `.fa-reasoning`, `.fa-notice`, `.fa-notice-icon`, `.fa-notice-text`, `.hidden`, `.faulty`, `.is-done`, `.is-error`

## Orchestration Trace Panel
`codeMindOrchestrationTracePanel.ts`, `trace.js`

### IDs
`traceList`, `emptyState`, `clearBtn`

### Classes
`.trace-header`, `.trace-brand`, `.trace-mark`, `.trace-brand-text`, `.trace-clear`, `.trace-empty`, `.trace-empty-hint`, `.trace-list`, `.cm-trace-card`, `.cm-trace-summary`, `.cm-trace-detail`, `.cm-trace-layer`, `.cm-trace-layer-header`, `.cm-trace-layer-index`, `.cm-trace-layer-name`, `.cm-trace-layer-status`, `.cm-trace-io`, `.cm-trace-io-label`, `.cm-trace-io-content`, `.cm-layer-dot`, `.cm-headroom-kv`, `.cm-headroom-row`, `.cm-headroom-k`, `.cm-headroom-v`, `.cm-hr-card`, `.cm-hr-head`, `.cm-hr-dot`, `.cm-hr-title`, `.cm-hr-time`, `.cm-hr-section`, `.cm-hr-label`, `.cm-hr-pre`, `.cm-hr-tokens`, `.cm-hr-saved`, `.cm-hr-reason`, `.cm-hr-meta`, `.cm-hr-ok`, `.cm-hr-warn`, `.cm-hr-down`, `.cm-hr-unknown`, `.hidden`, `.expanded`

## Project Brain Dashboard
`scripts/brain-dashboard.html`, `scripts/brain-dashboard.mjs`

### IDs
`project`, `auto`, `meta`, `refresh`, `resetProject`, `resetAll`, `cards`, `checklist`, `checklistFor`, `pipeline`, `telemetry`, `projects`, `memories`, `decisions`, `events`, `conflicts`, `graph`, `graphMeta`, `legend`

### Classes
`.wrap`, `.cards`, `.card`, `.card .n`, `.card .l`, `section`, `.body`, `.tablewrap`, `.pill`, `.pill.active`, `.pill.superseded`, `.pill.archived`, `.two`, `.pipeline`, `.stage`, `.stage.ok`, `.stage-top`, `.stage-what`, `.stage-meta`, `.arrow`, `.checklist`, `.check`, `.check.ok`, `.check.bad`, `.legend`, `.dot`, `.note`, `.err`, `.tag`, `.mono`

### Behaviour that must not change
Data fetch (`/api/data`), reset (`/api/reset`), 5-second polling, project query-string state, graph signature caching, force layout loop (`ticks < 320`), and the `LABEL_COLORS` category mapping. The redesign reads theme values from CSS custom properties for canvas strokes/labels only.

## Aristotle
`aristotle.js`

### IDs / classes / data
`aristotle`, `.aristotle-layer`, `.aristotle-hit`, `data-base`, `data-strip`

Aristotle's frame set, frame URLs, triggers and timers are untouched. Only the
surrounding container is styled.

---

Last verified against the working tree on 2026-11-16.
