You are the systems architect for CodeMind. You are about to do something more
important than the Phase 2 implementation already built: you are going to replace
the parallel reimplementation with a correct one that is wired to what claude-code
actually does, and implement Headroom as the sole genuine new layer.

The problem with the current Phase 2 orchestration engine is this: it runs beside
claude-code in a separate parallel pipeline, does its own intent classification,
runs its own adapters (repository walk, git commands, file reads), builds its own
context block, and prepends it to the prompt before the SDK call. Claude-code then
does ALL OF THAT AGAIN internally — its own tool selection, its own file reads, its
own git operations, its own context management. The user gets double latency and
double work, and the "layers" in the dev trace are measuring shadow copies of real
operations, not the real operations themselves.

The correct architecture:

  The Phase 2 layers ARE the claude-code internal operations, observed and measured.
  The dev trace shows what claude-code ACTUALLY did — its real tool calls, its real
  context decisions, its real token counts.
  Headroom is the one genuinely new layer that claude-code does not have, and it runs
  on the real context that claude-code produced, not a shadow copy.

STEP 0 — READ EVERYTHING BEFORE TOUCHING ANYTHING

  0.1 Read the entire claude-code/src/ tree structure:
        find claude-code/src -type f -name "*.ts" | sort
      Read every file that covers:
        - Intent/routing: anything named *router*, *intent*, *classify*, *route*
        - Tool selection: src/tools/index.ts or equivalent registry
        - Tool execution: how tools are dispatched and run
        - Context management: src/context/, src/memory/, anything compacting or
          summarizing conversation history
        - Token counting: any file that counts tokens or estimates context size
        - The compact() function or conversation history management
        - How the SDK's query() call is constructed before it fires

  0.2 Read the current Phase 2 implementation:
        find vscodium/src/stable/src/vs/workbench/contrib/codemindAgent/node -type f | sort
      Read every file Claude Code created for Phase 2.

  0.3 Read node/codeMindAgentEngineMain.ts in full.
      Find exactly where orchestrate() is called and where query() fires.

  0.4 Read claude-code/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
      Find the SDKMessage types. Specifically:
        - The 'system' message type (session init, model info)
        - The 'assistant' message type with content blocks
        - The 'tool_use' content block (tool name, input, id)
        - The 'tool_result' content block (output, isError)
        - The 'result' message (usage, cost, session_id, totalTokens)

      The SDK already streams ALL of this information through the existing
      ICodeMindEngineEvent channel. The dev trace layers must read FROM these
      events, not from separate operations.

  0.5 Read npm info headroom-ai and the headroom-ai package README.
      Understand the compress() API: what it takes, what it returns, and
      what "compression" means for a message array.

Only after reading all of the above, implement everything below.

---

SECTION 1 — REMAP THE 7 LAYERS TO REAL CLAUDE-CODE OPERATIONS

This section defines what each layer ACTUALLY IS in the new architecture.
No layer runs its own separate implementation. Each layer observes, measures,
or extends a real operation that the claude-code SDK already performs.

LAYER 1 — Intent Classification (KEEP, LIGHTWEIGHT)

  This layer stays as a fast in-memory keyword classifier, but its purpose changes.
  It is no longer used to "select tools" (claude-code selects its own tools).
  Its purpose is LABELING: classify the user's prompt so the dev trace can display
  what kind of request this was, and so Headroom (Layer 6) can make smarter
  compression decisions.

  Input: the raw user prompt string.
  Output: { intent, confidence, signals } — same as current intentDetector.ts.
  Side effects: none. Does not modify the prompt. Does not select tools.
  Timing: still < 1ms (pure in-memory). Still runs before the SDK call.

  Keep intentDetector.ts unchanged. Keep the intent result in the trace.
  REMOVE: all tool selection logic that uses the intent to pick adapters.
  The intent is now metadata only.

LAYER 2 — Tool Registry Snapshot (NEW IMPLEMENTATION)

  This layer replaces the current toolSelector.ts with something honest.
  Instead of Claude Code's own tool registry pretending to "select" tools,
  this layer reads what tools the claude-code SDK will make available for
  this session and records them as the "selected" set.

  Implementation:
    Read from claude-code/src/tools/index.ts (or wherever tools are registered)
    the canonical list of tool names available in the 'claude_code' preset.
    This is static — it does not change per-request.
    Record it in the trace as "available tools: [BashTool, ReadTool, WriteTool, ...]"

  This is honest: the "selected" tools are the ones claude-code ACTUALLY uses,
  which is the full preset, not a phantom subset your old code computed.

  Input: the session's tool preset name ('claude_code').
  Output: { preset: string; toolNames: string[]; count: number }
  Timing: ~0ms (reads a static list, no I/O).

LAYER 3 — Tool Execution Observer (COMPLETELY REWRITTEN)

  This is the most important change. The current toolExecutor.ts runs SEPARATE
  filesystem/git/repo operations that duplicate what claude-code does. That is wrong.

  The new Layer 3 OBSERVES the real tool calls that stream back from the SDK.
  It does not run anything. It listens to the ICodeMindEngineEvent stream and
  records every tool_use_start, tool_use_delta, and tool_result event.

  Implementation:
    In codeMindAgentEngineMain.ts, in the _handleSdkMessage() function (or wherever
    SDK events are processed), intercept every SDKMessage of type 'assistant' that
    contains a tool_use content block:

      if (msg.type === 'assistant') {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            // Layer 3 data: record this real tool call
            this._traceCollector.recordToolCall({
              toolName: block.name,
              toolId: block.id,
              input: block.input,
              startMs: Date.now()
            });
          }
        }
      }

    Also intercept every 'user' message that contains a tool_result block:
      if (msg.type === 'user') {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            this._traceCollector.recordToolResult({
              toolId: block.tool_use_id,
              content: block.content,
              isError: block.is_error,
              durationMs: Date.now() - this._traceCollector.getToolStartMs(block.tool_use_id)
            });
          }
        }
      }

  The _traceCollector is a new lightweight class (TraceCollector) that accumulates
  Layer 3 data during a streaming turn. It is created at the start of each turn
  and finalized when the 'result' message arrives.

  Layer 3 trace output shows REAL tool calls:
    { tools: [
        { name: 'Read', id: '...', inputSummary: 'src/auth/login.tsx',
          durationMs: 143, status: 'success', outputTokens: 420 },
        { name: 'Bash', id: '...', inputSummary: 'npm test --watch=false',
          durationMs: 2840, status: 'success', outputTokens: 180 },
        ...
    ], totalTools: 5, totalDurationMs: 3200 }

  This is what makes the dev trace genuinely meaningful — it shows the actual
  claude-code tools that actually ran, with actual timings and actual outputs,
  not shadow copies.

  Delete toolExecutor.ts. Delete all tool adapter files EXCEPT:
    projectBrainAdapter.ts (keep the stub — Phase 1 still needs this slot)
    headroomAdapter.ts (new file, see Layer 6)
  Delete repositoryAdapter.ts, fileContextAdapter.ts, dependencyAdapter.ts,
  gitAdapter.ts, webSearchAdapter.ts, terminalAdapter.ts.
  They are replaced by observation of the real tools.

LAYER 4 — Context Aggregation Observer (REWRITTEN)

  The current contextAggregator.ts merges shadow adapter outputs. Replace it with
  an observer that aggregates real information from the SDK's 'result' message.

  The SDK 'result' message contains:
    - totalInputTokens (how much context was sent to the model)
    - totalOutputTokens (how much the model generated)
    - numTurns (how many tool-use rounds happened)
    - session_id (the session this turn belongs to)
    - total_cost_usd (cost of this turn)

  Layer 4 reads these from the result message and aggregates with the
  Layer 3 tool call data to produce:

    { contextTokensSent: number;     // from result.totalInputTokens
      toolCallsExecuted: number;     // from Layer 3 collector
      uniqueFilesRead: string[];     // extracted from Read tool inputs in Layer 3
      bashCommandsRun: string[];     // extracted from Bash tool inputs in Layer 3
      webSearchesRun: number;        // count of WebSearch tool calls in Layer 3
      sessionId: string;             // from result.session_id
      cost: number;                  // from result.total_cost_usd
    }

  This gives REAL aggregated data. The "context" is what actually went to the model,
  not what a shadow pipeline estimated.

  Delete contextAggregator.ts and replace with a TraceCollector method:
    finalizeAggregation(resultMessage: SDKResultMessage): Layer4Data

LAYER 5 — Context Optimization Observer (REWRITTEN)

  The current contextOptimizer.ts prunes a shadow context that claude-code ignores.
  Replace it with an observer of the SDK's own compact() behavior.

  Claude-code has its own context compaction (the /compact command and auto-compact).
  When compaction happens, the SDK emits a 'system' message with type 'compacted'
  or equivalent. Layer 5 observes this.

  Read claude-code/src/ to find:
    - How the SDK signals that context was compacted
    - What data it provides about the compaction (tokens before/after)
    - Any event in the ICodeMindEngineEvent flow related to compaction

  Layer 5 records:
    { compactionOccurred: boolean;
      tokensBeforeCompaction?: number;
      tokensAfterCompaction?: number;
      compactionRatio?: number;
      isFirstTurn: boolean;      // no compaction on first turn
      estimatedContextUsage: number;  // % of context window used
    }

  If no compaction signal is available from the SDK, Layer 5 records:
    { compactionOccurred: false; estimatedContextUsage: fromLayer4.contextTokensSent / contextWindowSize }

  The context window size is read from the model's known limits (200k for opus,
  read from a static map keyed by model name).

  Keep contextOptimizer.ts as a file but replace its contents entirely.
  It now only contains the Layer 5 observer logic and no string manipulation.

LAYER 6 — HEADROOM COMPRESSION (THE GENUINE NEW CONTRIBUTION)

  This is the only layer that adds something claude-code does not have.
  This is the actual academic contribution of Phase 2.

  Headroom (npm package headroom-ai) is a context compression library that
  reduces the size of message arrays while preserving semantic meaning.
  Claude-code does NOT have this. It is genuinely new.

  Where it runs:
    Headroom runs on the CONVERSATION HISTORY before it is passed to the SDK
    query() call. Claude-code passes the full conversation history to every turn.
    Headroom compresses that history to reduce input tokens while preserving context.

  Implementation:

  6.1 Install headroom-ai in claude-code/:
        cd claude-code && npm install headroom-ai
      Read the installed package's TypeScript types:
        find claude-code/node_modules/headroom-ai -name "*.d.ts" | head -5
      Read every .d.ts file to understand the exact API.

  6.2 Find where conversation history is passed to the SDK query() call in
      codeMindAgentEngineMain.ts. The claude-code SDK's query() function accepts
      a 'messages' or 'history' option — read the SDK types to find the exact
      parameter name. This is the array Headroom will compress.

  6.3 Implement headroomLayer.ts (completely rewritten):

      import type { CancellationToken } from '../../../base/common/cancellation.js';

      let _compress: Function | null = null;
      let _headroomAvailable: boolean | null = null;

      export async function prewarmHeadroom(): Promise<void> {
        try {
          const headroomPath = resolveHeadroomPath(); // climb to claude-code/node_modules/headroom-ai
          const mod = await import(headroomPath);
          _compress = mod.compress ?? mod.default?.compress ?? null;
          _headroomAvailable = _compress !== null;
        } catch {
          _headroomAvailable = false;
        }
      }

      export interface HeadroomResult {
        messages: unknown[];          // the compressed message array
        originalMessageCount: number;
        compressedMessageCount: number;
        estimatedTokensBefore: number;
        estimatedTokensAfter: number;
        compressionRatio: number;
        mode: 'none' | 'light' | 'aggressive';
        headroomAvailable: boolean;
        durationMs: number;
      }

      export async function compressHistory(
        messages: unknown[],
        model: string,
        token: CancellationToken
      ): Promise<HeadroomResult> {
        const t0 = Date.now();

        // Estimate tokens before (chars/4 heuristic)
        const jsonBefore = JSON.stringify(messages);
        const tokensBefore = Math.ceil(jsonBefore.length / 4);

        // Decision thresholds (from original spec)
        let mode: 'none' | 'light' | 'aggressive';
        if (tokensBefore < 2000) mode = 'none';
        else if (tokensBefore < 8000) mode = 'light';
        else mode = 'aggressive';

        if (mode === 'none' || _headroomAvailable === false) {
          return {
            messages,
            originalMessageCount: messages.length,
            compressedMessageCount: messages.length,
            estimatedTokensBefore: tokensBefore,
            estimatedTokensAfter: tokensBefore,
            compressionRatio: 1.0,
            mode: 'none',
            headroomAvailable: _headroomAvailable ?? false,
            durationMs: Date.now() - t0
          };
        }

        if (_headroomAvailable === null) await prewarmHeadroom();
        if (!_compress) {
          return { messages, originalMessageCount: messages.length,
            compressedMessageCount: messages.length,
            estimatedTokensBefore: tokensBefore, estimatedTokensAfter: tokensBefore,
            compressionRatio: 1.0, mode: 'none', headroomAvailable: false,
            durationMs: Date.now() - t0 };
        }

        try {
          // For 'light': only compress messages older than the last 3
          // For 'aggressive': compress all messages
          const toCompress = mode === 'light'
            ? messages.slice(0, Math.max(0, messages.length - 3))
            : messages;
          const preserved = mode === 'light'
            ? messages.slice(Math.max(0, messages.length - 3))
            : [];

          const compressed = await _compress(toCompress, { model });
          const result = [...(compressed as unknown[]), ...preserved];

          const jsonAfter = JSON.stringify(result);
          const tokensAfter = Math.ceil(jsonAfter.length / 4);

          return {
            messages: result,
            originalMessageCount: messages.length,
            compressedMessageCount: result.length,
            estimatedTokensBefore: tokensBefore,
            estimatedTokensAfter: tokensAfter,
            compressionRatio: tokensAfter / Math.max(1, tokensBefore),
            mode,
            headroomAvailable: true,
            durationMs: Date.now() - t0
          };
        } catch (e) {
          // compression failed — return original unchanged
          return {
            messages,
            originalMessageCount: messages.length,
            compressedMessageCount: messages.length,
            estimatedTokensBefore: tokensBefore,
            estimatedTokensAfter: tokensBefore,
            compressionRatio: 1.0,
            mode: 'none',
            headroomAvailable: true,  // available but failed this call
            durationMs: Date.now() - t0
          };
        }
      }

  6.4 Wire Headroom into codeMindAgentEngineMain.ts:

      Find where the messages/history array is passed to query(). Before that call:

        const headroomResult = await compressHistory(
          conversationHistory,  // the actual variable name — read the file
          this._settings.model ?? DEFAULT_MODEL,
          cancelToken
        );

        // Use the compressed history for the SDK call
        const sdkOptions = {
          ...existingOptions,
          // replace the history with the compressed version:
          messages: headroomResult.messages  // or history: headroomResult.messages
        };

        // Record Layer 6 data for the trace
        this._traceCollector.recordHeadroom(headroomResult);

  6.5 If the SDK's query() does not accept a messages/history parameter
      (because the SDK manages its own session state internally and you cannot
      inject a compressed history), do the following instead:

      Run Headroom on the ENRICHED PROMPT STRING that gets prepended to the
      user's message (the context block that the orchestration engine builds).
      This is the fallback that still demonstrates Headroom compression on real
      content even if the SDK's message array is not accessible.

      In this fallback mode, compress the context string:
        const contextAsMessage = [{ role: 'user', content: contextString }]
        const result = await compressHistory(contextAsMessage, model, token)
        const compressedContext = (result.messages[0] as any)?.content ?? contextString

  6.6 Headroom pre-warm in the worker constructor:
      After adapter registry initialization, add:
        import('./orchestration/headroomLayer.js')
          .then(m => m.prewarmHeadroom())
          .catch(() => {});

LAYER 7 — Claude Agent SDK (UNCHANGED STRUCTURALLY)

  The SDK call stays exactly as it is. Layer 7 in the trace shows the INPUT
  to the SDK call (final prompt length, model, suffix length, message count
  before and after Headroom), and records "streaming: true" for the output.
  The actual SDK response continues to stream through the existing event channel.

  One change: record the message count AFTER Headroom compression as input:
    { finalPromptChars, model, messagesBeforeHeadroom, messagesAfterHeadroom,
      headroomApplied: headroomResult.mode !== 'none',
      tokensSaved: headroomResult.estimatedTokensBefore - headroomResult.estimatedTokensAfter }

---

SECTION 2 — TRACECOLLETOR CLASS

Create node/orchestration/traceCollector.ts:

  This class accumulates real data from the SDK event stream during a single turn.
  It replaces the ad-hoc trace building in codeMindOrchestrationEngine.ts.

  interface ToolCallRecord {
    toolName: string;
    toolId: string;
    inputSummary: string;    // first 200 chars of JSON.stringify(input)
    startMs: number;
    endMs?: number;
    durationMs?: number;
    status?: 'success' | 'error';
    outputSummary?: string;  // first 200 chars of output content
    outputTokenEstimate?: number;
  }

  export class TraceCollector {
    private _tools = new Map<string, ToolCallRecord>();
    private _layer1: IntentClassification | null = null;
    private _layer2: Layer2Data | null = null;
    private _layer6: HeadroomResult | null = null;
    private _startMs = Date.now();

    recordIntent(c: IntentClassification) { this._layer1 = c; }
    recordToolRegistry(d: Layer2Data) { this._layer2 = d; }

    recordToolCall(d: { toolName, toolId, input, startMs }) {
      this._tools.set(d.toolId, {
        toolName: d.toolName,
        toolId: d.toolId,
        inputSummary: JSON.stringify(d.input).slice(0, 200),
        startMs: d.startMs
      });
    }

    recordToolResult(d: { toolId, content, isError, durationMs }) {
      const rec = this._tools.get(d.toolId);
      if (!rec) return;
      rec.endMs = Date.now();
      rec.durationMs = d.durationMs;
      rec.status = d.isError ? 'error' : 'success';
      rec.outputSummary = JSON.stringify(d.content).slice(0, 200);
      rec.outputTokenEstimate = Math.ceil(JSON.stringify(d.content).length / 4);
    }

    getToolStartMs(toolId: string): number {
      return this._tools.get(toolId)?.startMs ?? Date.now();
    }

    recordHeadroom(r: HeadroomResult) { this._layer6 = r; }

    finalize(resultMsg: SDKResultMessage, queryId: string, devMode: boolean): OrchestrationTrace | null {
      if (!devMode) return null;  // no trace data collected when dev mode is off

      const tools = [...this._tools.values()];
      const layer3: Layer3Data = {
        tools: tools.map(t => ({
          name: t.toolName, id: t.toolId,
          inputSummary: t.inputSummary,
          durationMs: t.durationMs ?? 0,
          status: t.status ?? 'success',
          outputSummary: t.outputSummary ?? '',
          outputTokenEstimate: t.outputTokenEstimate ?? 0
        })),
        totalTools: tools.length,
        totalDurationMs: tools.reduce((s, t) => s + (t.durationMs ?? 0), 0)
      };

      const uniqueFiles = tools
        .filter(t => t.toolName === 'Read')
        .map(t => { try { return JSON.parse(t.inputSummary)?.file_path ?? ''; } catch { return ''; } })
        .filter(Boolean);

      const layer4: Layer4Data = {
        contextTokensSent: resultMsg.usage?.input_tokens ?? 0,
        toolCallsExecuted: tools.length,
        uniqueFilesRead: uniqueFiles,
        bashCommandsRun: tools.filter(t => t.toolName === 'Bash')
          .map(t => { try { return JSON.parse(t.inputSummary)?.command?.slice(0, 80) ?? ''; } catch { return ''; } }),
        webSearchesRun: tools.filter(t => t.toolName.toLowerCase().includes('search')).length,
        sessionId: resultMsg.session_id ?? '',
        cost: resultMsg.total_cost_usd ?? 0
      };

      const layer5: Layer5Data = {
        compactionOccurred: false,  // updated if compaction event observed
        estimatedContextUsage: (resultMsg.usage?.input_tokens ?? 0) / getContextWindowSize(/* model */),
        isFirstTurn: false
      };

      return {
        queryId,
        timestamp: this._startMs,
        totalDurationMs: Date.now() - this._startMs,
        cacheHit: false,
        timedOut: false,
        layers: [
          buildLayerTrace('intentDetection', 1, this._layer1?.input, this._layer1, this._layer1 ? 'pass' : 'skipped', 1),
          buildLayerTrace('toolRegistry', 2, this._layer2?.input, this._layer2, 'pass', 0),
          buildLayerTrace('toolExecution', 3, { selectedTools: this._layer2?.toolNames }, layer3, 'pass', layer3.totalDurationMs),
          buildLayerTrace('contextAggregation', 4, { toolCount: tools.length }, layer4, 'pass', 0),
          buildLayerTrace('contextOptimization', 5, { inputTokens: layer4.contextTokensSent }, layer5, 'pass', 0),
          buildLayerTrace('headroomCompression', 6, this._layer6 ? { tokensBefore: this._layer6.estimatedTokensBefore, mode: this._layer6.mode } : { skipped: true }, this._layer6 ?? { mode: 'none', headroomAvailable: false }, this._layer6 ? 'pass' : 'skipped', this._layer6?.durationMs ?? 0),
          buildLayerTrace('claudeAgentSDK', 7, { model: resultMsg.model, messagesAfterHeadroom: this._layer6?.compressedMessageCount }, { streaming: true }, 'pass', 0),
        ]
      };
    }
  }

---

SECTION 3 — REWIRE codeMindOrchestrationEngine.ts

Replace the body of orchestrate() with the new wiring.
The function signature stays the same. The orchestration events stay the same.

  export async function orchestrate(
    request: OrchestrationRequest,
    _registry: ToolAdapterRegistry,  // registry is kept for API compatibility but no adapters run
    onProgress: (e: any) => void
  ): Promise<OrchestrationResult> {
    const t0 = Date.now();

    // Fast paths (unchanged from original)
    if (request.userPrompt.trim().length < 20) { return fastPathResult(request); }

    // Layer 1: Intent (still runs, is still labeling metadata)
    onProgress({ type:'orchestration_progress', queryId:request.queryId,
                  phase:'intent_detection', status:'running' });
    const intent = classifyIntent(request.userPrompt);

    // Layer 2: Tool registry snapshot
    const toolRegistry = getClaudeCodeToolRegistry();  // reads static tool list from SDK

    // Layers 3-5 are OBSERVED during the SDK stream, not run here.
    // The TraceCollector in the engine main accumulates them.
    // We just emit progress so the UI updates.
    onProgress({ type:'orchestration_progress', queryId:request.queryId,
                  phase:'complete', status:'complete',
                  intent: intent.intent,
                  durationMs: Date.now() - t0 });

    // The enriched prompt is now ONLY the intent suffix, not a shadow context block.
    // Real context comes from claude-code's own tools during the turn.
    const systemPromptSuffix = buildMinimalSuffix(intent);

    return {
      enrichedPrompt: request.userPrompt,    // unchanged — no shadow context prepended
      systemPromptSuffix,
      orchestrationMetadata: {
        intent: intent.intent,
        confidence: intent.confidence,
        toolsExecuted: [],       // filled in by TraceCollector after the turn
        toolsFailed: [],
        originalTokenEstimate: 0,
        finalTokenEstimate: 0,
        compressionMode: 'none', // filled in by Headroom layer
        headroomAvailable: false,
        totalDurationMs: Date.now() - t0
      }
    };
  }

  buildMinimalSuffix(intent):
    A short system prompt note, under 50 tokens:
      "\n\n[CodeMind] Detected intent: {intent}"
    This is the ONLY thing the orchestration engine adds to the prompt.
    Real context enrichment is done by claude-code's own tools.

---

SECTION 4 — DEV TRACE PANEL UPDATE

The trace panel now shows REAL data from claude-code operations.
Update trace.js to display what each layer ACTUALLY represents.

4.1 Layer labels in the trace panel (update the header and description for each):

  Layer 1 — Intent Classification
    Label: "Intent · [intent] · [confidence]%"
    Description: "Rule-based keyword classifier — 12 developer intent categories"
    Shows: matched signals (the keywords that fired), confidence score
    Source: intentDetector.ts (your code)

  Layer 2 — Tool Registry
    Label: "Tool Registry · [n] tools available"
    Description: "Claude Code's native tool preset — tools available to the model"
    Shows: full list of tool names from the 'claude_code' preset
    Source: SDK preset, observed by your code

  Layer 3 — Tool Execution (REAL)
    Label: "Tools · [n] calls · [total_ms]ms"
    Description: "Actual claude-code tool calls observed during this turn"
    Shows: each real tool call with name, input summary, duration, status
    Format per tool:
      ✓ Read              src/auth/LoginController.tsx      143ms   420 tok
      ✓ Bash              npm test --watch=false            2840ms  180 tok
      ✗ Write             /tmp/test.ts                       12ms   [error]
    Source: SDK stream events (your observer)

  Layer 4 — Context Aggregation (REAL)
    Label: "Context · [n] tokens sent to model · [n] tools"
    Description: "Actual context the model received — from SDK result message"
    Shows:
      Tokens sent: [n] (from result.usage.input_tokens)
      Files read: [list of unique files from Read tool calls]
      Bash commands: [list of commands run]
      Web searches: [n]
      Session: [session_id truncated to 8 chars]
      Cost: $[cost]
    Source: SDK result message (your observer)

  Layer 5 — Context Optimization
    Label: "Context Usage · [n]% of [model] window"
    Description: "Context window utilization — compaction by claude-code if triggered"
    Shows:
      Context window: 200k tokens (or actual for model)
      Tokens used: [n] ([percent]%)
      Compaction: [occurred | not triggered]
    Source: SDK events (your observer)

  Layer 6 — Headroom Compression (THE NEW THING)
    Label: "Headroom · [mode] · [before]→[after] tok ([saving]% saved)"
    OR: "Headroom · skipped (<2k tokens)"
    OR: "Headroom · unavailable (package not installed)"
    Description: "Context compression using headroom-ai — CodeMind's unique contribution"
    Shows:
      Mode: none | light | aggressive
      Messages before: [n]
      Messages after: [n]
      Tokens before: [n]
      Tokens after: [n]
      Compression ratio: [x]×
      Duration: [n]ms
      Library: headroom-ai (local npm, not a network API)
    When mode is 'none': explain WHY (below threshold, show threshold)
    Source: your headroomLayer.ts

  Layer 7 — Claude Agent SDK
    Label: "SDK · [model] · streaming"
    Description: "Claude Agent SDK query — the model turn (timed separately)"
    Shows:
      Model: [actual model name from settings]
      Final prompt: [n] chars
      Messages after Headroom: [n]
      Tokens saved by Headroom: [n] (if Headroom ran)
      Round-trip time: measured from first token to result event
    Note: "Round-trip time is NOT part of orchestration — it is the model's response time"
    Source: your observer, SDK events

4.2 Add round-trip timing to Layer 7:

  In codeMindAgentEngineMain.ts, record the time of the first text delta:
    In _handleSdkMessage, when the first 'text' content block delta arrives,
    set this._traceCollector.firstTokenMs = Date.now() (if not already set).
    In finalize(), include in Layer 7:
      roundTripMs: resultMs - firstTokenMs (the actual model latency)

4.3 Update the trace panel header:

  The summary line at the top of the collapsed card now reads:
    "Orchestration · [n]ms · [intent] · [n] tools ran · Headroom: [mode]"

  The 7 colored dots:
    Layer 1: always green (intent classification never fails)
    Layer 2: always green (static tool list)
    Layer 3: green if all tools succeeded, yellow if any errored, red if all errored
    Layer 4: green always (observation never fails)
    Layer 5: green always
    Layer 6: green if compression ran, grey if skipped, red if unavailable
    Layer 7: always blue (streaming, timing shown separately)

---

SECTION 5 — CLEAN UP THE DEAD CODE

5.1 Delete these files (they ran shadow operations that are now replaced by observation):
    node/orchestration/toolExecutor.ts
    node/orchestration/contextAggregator.ts
    node/orchestration/toolAdapters/repositoryAdapter.ts
    node/orchestration/toolAdapters/fileContextAdapter.ts
    node/orchestration/toolAdapters/dependencyAdapter.ts
    node/orchestration/toolAdapters/gitAdapter.ts
    node/orchestration/toolAdapters/webSearchAdapter.ts
    node/orchestration/toolAdapters/terminalAdapter.ts

5.2 Keep:
    node/orchestration/types.ts (update with new Layer2-7 data types)
    node/orchestration/intentDetector.ts (unchanged)
    node/orchestration/toolSelector.ts (delete the selection logic, keep as toolRegistry.ts)
    node/orchestration/headroomLayer.ts (completely rewritten as Section 1 Layer 6)
    node/orchestration/contextOptimizer.ts (rewritten as Section 1 Layer 5 observer)
    node/orchestration/toolAdapters/projectBrainAdapter.ts (keep stub for Phase 1)
    node/orchestration/traceCollector.ts (new file, Section 2)

5.3 In codeMindOrchestrationEngine.ts:
    Remove all imports of deleted adapters.
    Remove toolExecutor import.
    Remove contextAggregator import.
    Keep intentDetector import.
    Add traceCollector import.
    Update orchestrate() per Section 3.

---

SECTION 6 — IMPLEMENTATION ORDER

  Step 1: Install headroom-ai in claude-code/ and verify types.
          npm info headroom-ai, then npm install, then read .d.ts files.
          tsgo --noEmit after.

  Step 2: Read the SDK (sdk.mjs) for message types and query() signature.
          Document: does query() accept messages/history as a parameter?
          Document: what does the 'result' SDKMessage contain (usage, cost, etc.)?
          Document: is there a compaction event in the SDK stream?

  Step 3: Create traceCollector.ts per Section 2. tsgo --noEmit.

  Step 4: Rewrite headroomLayer.ts per Section 1 Layer 6.
          Wire it into codeMindAgentEngineMain.ts.
          tsgo --noEmit.

  Step 5: Add SDK event observation to codeMindAgentEngineMain.ts:
          tool_use interception (Layer 3), result message reading (Layer 4).
          Connect TraceCollector.
          tsgo --noEmit.

  Step 6: Rewrite codeMindOrchestrationEngine.ts per Section 3.
          Delete the dead adapter files.
          tsgo --noEmit.

  Step 7: Update trace.js per Section 4 (new layer labels, real data rendering).
          node --check trace.js.

  Step 8: gulp compile-client. Fix any errors.

  Step 9: Launch with ELECTRON_ENABLE_LOGGING=1. Enable dev mode.
          Send 3 test prompts:
            "Implement a login screen"          — expect Layer 3 to show Read/Write/Bash calls
            "What files are in src/auth/"       — expect Layer 3 to show Glob/Read calls
            "Search for latest Clerk pricing"   — expect Layer 3 to show WebSearch call
          Verify each trace card shows real data in Layers 3, 4, 5.
          Verify Layer 6 shows Headroom data (mode and compression if > 2k tokens).

  Step 10: Force Headroom to actually run by building up a long conversation
           (10+ turns) until context exceeds 2000 tokens.
           Verify Layer 6 switches from 'none' to 'light'.
           Verify token counts before and after Headroom are different.
           Verify the SDK still receives the prompt and produces a correct response.

  Step 11: Write CODEMIND_PHASE2_FINAL_REPORT.md covering:
           Files deleted (the shadow pipeline)
           Files rewritten (the observers)
           Files new (traceCollector.ts, headroomLayer.ts rewrite)
           Headroom: verified working / not yet triggered / unavailable
           Test suite status (do the 170 tests still pass? update any that test
           deleted adapters)
           The architectural truth: what Phase 2 actually is now

---

CONSTRAINTS

  No shadow adapter files. If it reimplements something claude-code does, delete it.
  Headroom runs on REAL content, not simulated content.
  The trace panel shows only REAL data from real operations.
  tsgo --noEmit must pass at every step.
  node --check must pass on trace.js.
  gulp compile-client must succeed.
  The 170-test suite: update tests that tested deleted adapters to test the
  TraceCollector or HeadroomLayer instead. Maintain at least 150 passing tests.
  devMode: false means zero trace data collected, zero overhead. No exceptions.