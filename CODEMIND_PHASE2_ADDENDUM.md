This is an addendum to CODEMIND_PHASE2_ORCHESTRATION.md. Apply it on top of everything
already implemented in Phase 2. Do not re-implement Phase 2 — only add the two things
below.

Read the current state of the Phase 2 implementation in full before touching any file.
Run: find vscodium/src/stable/src/vs/workbench/contrib/codemindAgent/node -type f
Read every file that Phase 2 created or modified.

---

ADDENDUM A — PERFORMANCE: MAKE THE PIPELINE INVISIBLE

The orchestration pipeline must add zero perceptible latency to the user. The user
must never sit in silence waiting for tools to finish. The user must never feel that
the AI got slower. Implement every optimization below.

A.1 IMMEDIATE VISUAL FEEDBACK (< 10ms after Enter)

  The moment the user presses Enter, before the orchestration pipeline starts,
  emit a synthetic orchestration_progress event:
    { type: 'orchestration_progress', queryId, phase: 'intent_detection', status: 'running' }

  This causes agent.js to immediately show "Preparing context..." in the spinner
  before any async work begins. The user sees activity within one frame of pressing Enter.

  Implementation: at the very start of queryStream(), before the await orchestrate() call,
  emit this event synchronously. The existing IPC channel from worker to renderer is
  synchronous for small messages — it lands at the renderer before the first
  async orchestration operation begins.

A.2 PARALLEL ORCHESTRATION AND WARM-UP

  The Claude Agent SDK initializes internal state (auth verification, process check,
  session restoration) when query() is called. This warm-up takes 200 to 800ms.

  Run the orchestration pipeline and the SDK warm-up in parallel:

    const [orchestrated, _sdkReady] = await Promise.all([
      orchestrate(orchestrationRequest, registry, onProgress, token),
      prewarmSdk(this._sdkOptions, token)
    ])

  Implement prewarmSdk() as a function that calls the SDK's internal session check
  without starting a prompt stream. Read the SDK source to find the right call —
  look for session validation, process spawning, or ping operations. If no such
  API exists, prewarmSdk() is a no-op that resolves immediately.

  This means the orchestration pipeline's total time is hidden behind SDK warm-up.
  The net latency added to the user is max(0, orchestrationTime - sdkWarmupTime).
  In practice this is near zero for fast intents like MEMORY_RETRIEVAL.

A.3 HARD TIMEOUT WITH GRACEFUL DEGRADATION

  The orchestration pipeline has a hard wall clock timeout of 4000ms.
  This is tighter than the 6000ms in the main prompt — 4000ms is the right value
  because the SDK warm-up (A.2) gives us 200-800ms of overlap for free.

  Implement as a racing Promise:

    const orchestrated = await Promise.race([
      orchestrate(orchestrationRequest, registry, onProgress, token),
      timeoutAfter(4000).then(() => gracefulDegradation(orchestrationRequest))
    ])

  gracefulDegradation() returns an OrchestrationResult with:
    enrichedPrompt: the original prompt unchanged
    systemPromptSuffix: ''
    orchestrationMetadata.intent: DeveloperIntent.CODE_GENERATION  (safe default)
    orchestrationMetadata.toolsExecuted: []
    orchestrationMetadata.toolsFailed: ['timeout']
    orchestrationMetadata.totalDurationMs: 4000

  Also emit an event when timeout fires:
    { type: 'orchestration_progress', phase: 'timeout', status: 'failed',
      message: 'Context preparation timed out — proceeding with original prompt' }

  This event causes agent.js to show "Thinking..." (the normal label) instead of
  leaving the "Optimizing prompt..." label stuck. The user sees the normal experience.

A.4 PER-ADAPTER AGGRESSIVE TIMEOUTS

  The 4000ms wall clock timeout applies to the whole pipeline. But a single slow
  adapter can consume the entire budget. Apply per-adapter timeouts:

    gitAdapter:           800ms  (git commands should be instant locally)
    repositoryAdapter:    600ms  (filesystem walk)
    fileContextAdapter:   400ms  (file reads)
    dependencyAdapter:    300ms  (package.json read)
    terminalAdapter:      300ms  (port check + env read)
    webSearchAdapter:     100ms  (it's a no-op that injects a directive)
    projectBrainAdapter:  50ms   (it's a stub)

  These are set in each adapter's static TIMEOUT_MS property. toolExecutor.ts
  reads this property when racing each adapter against its own timeout.
  If an adapter times out, it is logged as failed and its output is empty.
  Other adapters are unaffected.

A.5 RESULT CACHE (follow-up messages)

  For follow-up messages in the same session where the intent is identical to the
  previous turn, reuse the previous turn's context sections rather than re-executing
  all adapters.

  Cache key: sha256(workspaceFolder + intent.intent + openFiles.join(':'))
  Cache TTL: 30 seconds

  On a cache hit:
    Skip tool execution entirely.
    Use the cached AggregatedContext.
    Still run contextOptimizer and headroomLayer (they are fast).
    Emit: { type: 'orchestration_progress', phase: 'cache_hit', status: 'complete' }
    This causes agent.js to show "Using cached context..." briefly before "Thinking..."

  Cache miss or expired: run the full pipeline.

  Implement the cache as a Map<string, { context: AggregatedContext; expiresAt: number }>
  in the engine worker's module scope (not class scope — the cache survives across queries
  within the same worker process lifetime).

  Invalidate the entire cache when:
    The user saves a file (detect via the existing file-watch infrastructure)
    Git state changes (re-check every 30 seconds passively, only if cache is active)
    The workspace folder changes

A.6 STREAMING CONTEXT INJECTION (long responses)

  For MULTI_TOOL_WORKFLOW and CODE_GENERATION intents where tool execution takes
  longer than 1500ms, do not wait for all tools to complete before starting the
  SDK call. Instead:

    After 1500ms: if at least 2 of the selected tools have completed, proceed with
    what is available. Cancel remaining tool promises (they continue but their output
    is dropped). Build context from completed tools only.

    Under 1500ms: wait for all tools (the normal path).

  Implement this as:
    function raceForMinimumContext(
      toolPromises: Promise<ToolOutput>[],
      minimumTools: number,
      deadline: number
    ): Promise<ToolOutput[]>

  This ensures MULTI_TOOL_WORKFLOW requests never stall for more than 1500ms
  waiting for slow tools like webSearchAdapter.

A.7 INTENT FAST PATHS (skip orchestration entirely)

  Some intents need no context enrichment. For these, skip the entire pipeline
  and call the SDK directly:

    TERMINAL_EXECUTION where the prompt starts with '!':
      Skip all adapters. Only add terminalAdapter context (< 300ms).

    If the prompt is shorter than 20 characters:
      Skip all adapters. Intent classification still runs (it's synchronous).

    If orchestration is disabled in settings:
      Skip entirely (this was already specified in the main prompt).

  These fast paths are checked in queryStream() before the orchestrate() call.
  They bypass the orchestration pipeline completely and emit no orchestration events.

A.8 LAZY HEADROOM INITIALIZATION

  The Headroom dynamic import() takes 200-500ms on first use (loading the module,
  initializing its internal state). After the first import, it is cached by the
  Node module system.

  Pre-warm Headroom at worker startup, not at first query:

    In the worker's initialization code (after IPC channel is ready but before any
    query arrives), run:
      import('./orchestration/headroomLayer.js').then(m => m.prewarmHeadroom())

    prewarmHeadroom() does the dynamic import of headroom-ai and stores the compress
    function in a module-level variable. From then on, the headroomLayer module uses
    the pre-loaded function instead of dynamic import.

    If pre-warm fails (headroom not installed), set a module-level
    HEADROOM_AVAILABLE = false flag. All subsequent compression calls check this
    flag and skip immediately.

A.9 PERFORMANCE TELEMETRY IN THE WORKER

  Track a rolling average of orchestration pipeline duration. After every 5 queries,
  write the average to a module-level performanceStats object:

    { averagePipelineMs: number; p95PipelineMs: number; cacheHitRate: number;
      adapterTimeouts: number; headroomAvailable: boolean; totalQueries: number }

  This object is read by the /orchestration command (already implemented in the main
  prompt) and displayed as a "Pipeline performance" section.

  Also detect regressions: if averagePipelineMs exceeds 2000ms over the last 10
  queries, emit a warning event that agent.js displays as a dismissible notice:
    "Context preparation is running slowly. Check /orchestration for details."

---

ADDENDUM B — DEV MODE: LAYER-BY-LAYER TRACE PANEL

Implement a developer debugging surface that shows exactly what happened at every
layer of the orchestration pipeline for the last N requests. This is enabled by a
toggle in the panel UI and is purely for development/debugging — it does not affect
production behavior.

B.1 DEV MODE TOGGLE

  Add a bug icon button (🐛, 16px SVG) in the panel header, to the left of the
  settings gear. This button is always visible during development.

  Clicking it toggles a module-level devModeEnabled flag and:
    Shows a brief toast: "Dev mode on — orchestration traces visible"
    or: "Dev mode off"
    Changes the button's color from var(--vscode-descriptionForeground) to
    var(--vscode-editorWarning-foreground) when active.

  This flag is stored in VS Code's memento storage under 'codemind.devMode' so
  it persists across restarts. On startup, if devMode is true, show a warning
  banner at the top of the panel:
    "⚠ Dev mode active — traces are logged" in var(--vscode-editorWarning-foreground)
    with an X to dismiss (which also turns off dev mode).

B.2 TRACE DATA COLLECTION

  When devMode is enabled, the orchestration engine collects a full trace for every
  pipeline run. The trace is a structured object:

    interface OrchestrationTrace {
      queryId: string
      timestamp: number
      totalDurationMs: number
      cacheHit: boolean
      timedOut: boolean
      layers: LayerTrace[]
    }

    interface LayerTrace {
      layerName: string
      layerIndex: number       // 1 through 7
      durationMs: number
      status: 'pass' | 'timeout' | 'skipped' | 'error'
      input: unknown           // what this layer received
      output: unknown          // what this layer produced
      inputTokenEstimate: number
      outputTokenEstimate: number
      notes: string[]          // any warnings or decisions made
    }

  Collect input and output at every layer boundary:

    Layer 1 — Intent Detection:
      input: { prompt: string (truncated to 500 chars), promptLength: number }
      output: { intent: DeveloperIntent; confidence: number; signals: string[] }

    Layer 2 — Tool Selection:
      input: { intent: IntentClassification; selectionContext: SelectionContext }
      output: { selectedTools: string[]; skippedTools: string[]; reasoning: string }

    Layer 3 — Tool Execution:
      input: { tools: string[]; openFiles: string[]; workspaceFolder: string }
      output: {
        results: Array<{
          adapterId: string
          status: 'success' | 'timeout' | 'error'
          durationMs: number
          outputSummary: string  // first 200 chars of serialized output
          outputTokenEstimate: number
        }>
      }

    Layer 4 — Context Aggregation:
      input: { toolOutputCount: number; toolsFailed: string[] }
      output: {
        sectionsPopulated: string[]
        totalChars: number
        estimatedTokens: number
        contextPreview: string  // first 400 chars of serialized context
      }

    Layer 5 — Context Optimization:
      input: { estimatedTokens: number; sectionsIncluded: string[] }
      output: {
        sectionsRemoved: string[]
        filesTrimed: string[]
        historySummarized: boolean
        deduplicatedFacts: number
        estimatedTokensAfter: number
        reductionPercent: number
        optimizedContextPreview: string  // first 400 chars
      }

    Layer 6 — Headroom Compression:
      input: { estimatedTokens: number; compressionMode: CompressionMode }
      output: {
        headroomAvailable: boolean
        compressionMode: CompressionMode
        tokensBeforeCompression: number
        tokensAfterCompression: number
        compressionRatio: number
        compressedPromptPreview: string  // first 400 chars of final prompt sent to SDK
      }

    Layer 7 — Claude Agent SDK:
      input: { finalPromptLength: number; systemPromptSuffixLength: number; model: string }
      output: { streaming: true }  // we don't have the full response here; it streams

  Store the last 20 traces in a module-level circular buffer:
    const traceBuffer: OrchestrationTrace[] = []  // max 20 entries
    When full, drop the oldest.

B.3 TRACE DATA TRANSMISSION TO RENDERER

  When devMode is enabled, emit the full trace as a new event after the orchestration
  completes (before the SDK stream starts):

    { type: 'orchestration_trace'; queryId: string; trace: OrchestrationTrace }

  Add this event type to ICodeMindEngineEvent.

  This event is only emitted when devMode is true. When devMode is false, no trace
  data is collected and no event is emitted. Zero overhead in production mode.

B.4 TRACE PANEL UI IN agent.js

  When an orchestration_trace event arrives:
    A "trace card" is inserted ABOVE the assistant's message bubble for this turn.
    The trace card is collapsed by default (single-line summary).

  COLLAPSED state (single line, 28px):
    Left: a bug icon (10px), then "Orchestration · [n]ms · [intent]"
    Middle: a row of 7 colored status dots (one per layer), colored:
      green (< 200ms and pass), yellow (200-800ms and pass), red (timeout or error),
      grey (skipped)
    Right: "→ [n] → [m] tokens ([r]% reduction)" if Headroom ran, else "[n] tokens"
    Font: 10px, var(--vscode-descriptionForeground)

  EXPANDED state (click to expand, max-height animation 220ms):
    Seven layer sections, one per layer, with a consistent layout:

    ┌──────────────────────────────────────────────────────────────┐
    │ [1] Intent Detection              ✓ 3ms                      │
    │ ─────────────────────────────────────────────────────────    │
    │ INPUT                                                         │
    │  Prompt (142 chars): "Implement a login screen using Clerk..." │
    │ OUTPUT                                                        │
    │  Intent: code_generation (87% confidence)                    │
    │  Signals: "implement", "login", "using"                      │
    └──────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────┐
    │ [2] Tool Selection                ✓ 0ms                      │
    │ ─────────────────────────────────────────────────────────    │
    │ INPUT                                                         │
    │  Intent: code_generation · hasOpenFiles: true                │
    │ OUTPUT                                                        │
    │  Selected: repository, fileContext, dependency (3 tools)     │
    │  Skipped: git (no git signals), webSearch, terminal          │
    │  Reasoning: CODE_GENERATION + open files → repo+file+dep    │
    └──────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────┐
    │ [3] Tool Execution (parallel)     ✓ 142ms                    │
    │ ─────────────────────────────────────────────────────────    │
    │ INPUT                                                         │
    │  Tools: repository, fileContext, dependency                  │
    │  Open files: src/auth/LoginController.tsx                    │
    │ OUTPUT                                                        │
    │  repository     ✓  88ms   ~420 tokens                        │
    │    "openFile: src/auth/LoginController.tsx, relatedFiles:    │
    │     [src/auth/AuthProvider.tsx, src/lib/clerk.ts]..."        │
    │  fileContext     ✓  54ms   ~1,240 tokens                     │
    │    "LoginController.tsx (148 lines), AuthProvider.tsx (62   │
    │     lines)..."                                               │
    │  dependency      ✓  12ms   ~180 tokens                       │
    │    "@clerk/nextjs: 4.2.1, next: 16.0.0..."                  │
    └──────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────┐
    │ [4] Context Aggregation           ✓ 2ms                      │
    │ ─────────────────────────────────────────────────────────    │
    │ INPUT                                                         │
    │  3 tool outputs · 0 failures                                 │
    │ OUTPUT                                                        │
    │  Sections: repository, currentFiles, dependencies            │
    │  Total: 5,840 chars · ~1,460 tokens                         │
    │  Preview: "=== REPOSITORY ===\nCurrent file: src/auth/Lo..."  │
    └──────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────┐
    │ [5] Context Optimization          ✓ 8ms                      │
    │ ─────────────────────────────────────────────────────────    │
    │ INPUT                                                         │
    │  ~1,460 tokens · sections: repository, currentFiles, dep     │
    │ OUTPUT                                                        │
    │  Removed sections: none                                      │
    │  Files trimmed: none (all under 200 lines)                   │
    │  Deduplicated: 2 facts (framework name appeared twice)       │
    │  History summarized: no (first turn)                         │
    │  Tokens after: ~1,440 (reduction: 1.4%)                     │
    │  Preview: "=== REPOSITORY ===\nCurrent file: src/auth/Lo..."  │
    └──────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────┐
    │ [6] Headroom Compression          ✓ 34ms                     │
    │ ─────────────────────────────────────────────────────────    │
    │ INPUT                                                         │
    │  ~1,440 tokens · mode decision: light (> 1000 threshold)    │
    │ OUTPUT                                                        │
    │  Mode: light · Headroom: available                           │
    │  Before: ~1,580 tokens (context + prompt combined)          │
    │  After:  ~1,102 tokens (compression ratio: 0.70)            │
    │  Reduction: 478 tokens (30%)                                 │
    │  Final prompt preview: "=== REPOSITORY ===\nFile: src/au..."  │
    └──────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────┐
    │ [7] Claude Agent SDK              → streaming                │
    │ ─────────────────────────────────────────────────────────    │
    │ INPUT                                                         │
    │  Final prompt: 4,408 chars · suffix: 89 chars · model: opus  │
    │ OUTPUT                                                        │
    │  Streaming...                                                │
    └──────────────────────────────────────────────────────────────┘

  Styling rules:
    The trace card has a left border: 2px solid var(--vscode-editorWarning-foreground)
    Background: var(--vscode-editorWidget-background) at 60% opacity
    Border-radius: var(--cm-radius-md)
    Padding: 8px 12px (collapsed), 12px (expanded)
    Layer section headers: 11px font-weight 500, var(--vscode-foreground)
    Layer status: ✓ in var(--vscode-testing-iconPassed), ✗ in errorForeground,
                  ⏱ in editorWarning-foreground (for timeouts), — in descriptionForeground (skipped)
    INPUT/OUTPUT labels: 10px, font-weight 600, letter-spacing 0.08em,
                         var(--vscode-descriptionForeground), uppercase
    Content under INPUT/OUTPUT: 11px monospace, var(--vscode-foreground)
    Preview text (context/prompt content): 10px, monospace, italic,
                  var(--vscode-descriptionForeground), max 2 lines visible with overflow hidden

  Layer sections inside the expanded card are individually collapsible.
  The entire card collapses back to the single-line summary on second click.
  Add a "Copy trace" button (icon only, top-right of expanded card) that copies
  the full trace as JSON to the clipboard.

B.5 /trace COMMAND

  Add a /trace slash command that opens a dedicated trace history panel (like /tasks).
  The panel shows the last 20 orchestration traces as a scrollable list.
  Each entry: timestamp, queryId (truncated), intent, total duration, token reduction.
  Clicking an entry expands the full layer-by-layer trace (same layout as B.4).

  This panel is only useful in dev mode and the /trace command should note this
  if dev mode is off: "Enable dev mode (bug icon in the header) to record traces."

B.6 PERFORMANCE REGRESSION INDICATOR IN DEV MODE

  When dev mode is active, the collapsed trace card shows a color-coded border:
    Green border:    totalDurationMs < 500ms
    Yellow border:   totalDurationMs 500-1500ms
    Red border:      totalDurationMs > 1500ms or timedOut: true

  This gives immediate visual feedback on pipeline performance without needing to
  expand the card.

B.7 NODE --CHECK AND COMPILE CONSTRAINTS

  All trace data that passes through postMessage to the renderer must be JSON-safe.
  Do not include functions, Promises, or circular references in LayerTrace.input or output.
  Serialize with JSON.stringify before posting and parse in the renderer.
  Cap input and output preview strings at 500 characters before serializing to
  prevent large messages that could saturate the IPC channel.

  node --check must pass on agent.js after UI changes.
  tsgo --noEmit must pass after all changes.
  gulp compile-client must succeed.

---

ADDENDUM C — IMPLEMENTATION ORDER

Apply this addendum after Phase 2 is already implemented and compiling cleanly.

  Step A1: Implement Addendum A (all performance sections A.1 through A.9).
           After each sub-step, verify tsgo --noEmit passes.
           After A.9, launch the app and run O-001 (memory retrieval) and O-004
           (terminal) to verify the fast paths work. Time them — both should feel
           instant (< 200ms perceptible latency).

  Step A2: Launch and run O-002 (code generation) with ELECTRON_ENABLE_LOGGING=1.
           Measure total time from Enter to first text token. Record it.
           Adjust timeout values in A.4 if any adapter consistently times out on
           your machine.

  Step B1: Add the devMode toggle to the header (B.1 only — button and flag).
           Verify toggle persists across restarts.

  Step B2: Implement trace data collection in the orchestration engine (B.2 + B.3).
           Enable dev mode, run a prompt, check the console for the
           orchestration_trace event payload. Verify all 7 layers are populated.

  Step B3: Implement the trace card UI in agent.js (B.4).
           Verify each layer section renders correctly with real data.
           Verify collapse/expand animation works.
           Verify the color-coded status dots match actual layer outcomes.
           Verify "Copy trace" button copies valid JSON.

  Step B4: Implement /trace command (B.5) and regression indicator (B.6).

  Step B5: node --check on agent.js. tsgo --noEmit. gulp compile-client.

  Final: Run a test suite of 5 varied prompts in dev mode. For each:
    Record total orchestration time from the trace card.
    Verify no layer shows a red status unless actually timed out.
    Verify token reduction numbers are plausible.
    Verify the compressed prompt preview in Layer 6 contains coherent content.
    Confirm the user-visible response time feels identical to pre-Phase-2.