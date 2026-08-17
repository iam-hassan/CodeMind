You are the senior systems engineer for CodeMind. You are about to implement Phase 2:
the CodeMind Agent — an Adaptive AI Agent Orchestration Engine that sits between every
developer request and the Claude Code SDK. This is the most architecturally significant
feature in the entire project.

Before writing a single line of code, you must read and fully understand:

STEP 0 — MANDATORY PRE-READING (do not skip any item)

  0.1 Read the FYP document in full:
        extract-text CODEMIND_PHASE2_ORCHESTRATION.md   (no — read the FYP doc)
      The FYP document is at one of these locations — find it:
        find . -name "CodeMind_FYP_Main_Features.docx" -o -name "*.docx" | head -5
      Extract and read it fully before proceeding.
      Internalize Section 4 (Feature 2 — CodeMind Agent) completely. Every step in
      that section maps to a concrete implementation requirement below.

  0.2 Read the current codebase:
        find vscodium/src/stable/src/vs/workbench/contrib/codemindAgent -type f | sort
      Read every file. Understand the five-layer architecture:
        common/codeMindAgentEngineService.ts    — the ICodeMindEngineEvent union
        node/codeMindAgentEngineMain.ts         — the utility-process worker (YOUR primary target)
        electron-sandbox/codeMindAgentEngineService.ts
        browser/codeMindAgentViewPane.ts
        browser/codemindAgent.contribution.ts
      The orchestration engine lives entirely in the node worker and new files
      alongside it. The rest of the layers stay unchanged except for new event types.

  0.3 Understand the Headroom TypeScript SDK:
      The npm package is headroom-ai. Its TypeScript API provides:
        import { compress } from 'headroom-ai'
        compress(messages, { model: string }): Promise<CompressedMessages>
      Run: npm info headroom-ai to get the current version.
      Install it in the claude-code/ tree (where the SDK already lives):
        cd claude-code && npm install headroom-ai
      After install, read its type definitions:
        find claude-code/node_modules/headroom-ai -name "*.d.ts" | head -10
      Read those .d.ts files completely so you understand the exact compress() API,
      what CompressedMessages contains, and what options are available.
      If the package is not found, use the documented API from the README:
        compress(messages: Message[], options: { model: string }): Promise<Message[]>

  0.4 Read the Phase 3 implementation report (the document passed alongside this prompt)
      to understand what has already been built and which APIs already exist.

  0.5 Read the existing node/codeMindAgentEngineMain.ts in full. Understand exactly where
      queryStream() calls query() on the Claude Agent SDK. The orchestration engine
      intercepts the request BEFORE this call and transforms it.

Only after all five reads are complete, begin implementation.

---

ARCHITECTURE OVERVIEW

The orchestration engine is a TypeScript module that wraps every call to the Claude
Agent SDK's query() function. Every prompt the user sends flows through this pipeline:

  Developer prompt
       │
       ▼
  [1] Intent Detection Engine
       │ classified intent category
       ▼
  [2] Tool Selection Engine
       │ list of tools to execute
       ▼
  [3] Tool Execution Layer (parallel)
       │ raw tool outputs
       ▼
  [4] Context Aggregation Engine
       │ merged structured context object
       ▼
  [5] Context Optimization Engine
       │ pruned, deduplicated, ranked context
       ▼
  [6] Headroom Compression Layer
       │ token-optimized prompt
       ▼
  [7] Claude Agent SDK query()
       │
       ▼
  Developer response (streamed as before)

The orchestration engine does not change the ICodeMindEngineEvent stream contract.
From the perspective of the renderer and the ViewPane, every event still arrives
identically. The only difference is what goes into the Claude Agent SDK — the prompt
is enriched and compressed before it ever reaches the model.

The orchestration pipeline runs in node/codeMindOrchestrationEngine.ts (new file)
and is called from codeMindAgentEngineMain.ts before the query() call.

---

SECTION 1 — FILE STRUCTURE

Create these new files in the node/ layer alongside codeMindAgentEngineMain.ts:

  node/codeMindOrchestrationEngine.ts    — the main pipeline coordinator
  node/orchestration/intentDetector.ts   — Step 1: intent classification
  node/orchestration/toolSelector.ts     — Step 2: tool selection
  node/orchestration/toolExecutor.ts     — Step 3: parallel tool execution
  node/orchestration/contextAggregator.ts — Step 4: context aggregation
  node/orchestration/contextOptimizer.ts — Step 5: context pruning and ranking
  node/orchestration/headroomLayer.ts    — Step 6: Headroom compression
  node/orchestration/toolAdapters/
    projectBrainAdapter.ts              — stub (Phase 1 not yet built)
    repositoryAdapter.ts                — real implementation
    dependencyAdapter.ts                — real implementation
    gitAdapter.ts                       — real implementation
    webSearchAdapter.ts                 — real implementation (delegates to SDK tool)
    fileContextAdapter.ts               — real implementation
    terminalAdapter.ts                  — real implementation

All imports must be relative with .js extensions (the existing project convention).
TypeScript strict mode is on. No any casts without a comment explaining why.

---

SECTION 2 — STEP 1: INTENT DETECTION ENGINE

File: node/orchestration/intentDetector.ts

The intent classifier analyzes every developer prompt and assigns it one of twelve
intent categories defined in the FYP document. It must be fast (< 50ms) because it
runs before every request. It must not make an API call to classify.

2.1 Intent categories (implement all twelve as a TypeScript enum):

  enum DeveloperIntent {
    CODE_GENERATION      = 'code_generation',
    MEMORY_RETRIEVAL     = 'memory_retrieval',
    ARCHITECTURE         = 'architecture',
    WEB_SEARCH           = 'web_search',
    GIT_OPERATIONS       = 'git_operations',
    TERMINAL_EXECUTION   = 'terminal_execution',
    DOCUMENTATION        = 'documentation',
    DEBUGGING            = 'debugging',
    CODE_REVIEW          = 'code_review',
    TESTING              = 'testing',
    PROJECT_ANALYSIS     = 'project_analysis',
    MULTI_TOOL_WORKFLOW  = 'multi_tool_workflow',
  }

2.2 Classifier implementation:

  The classifier is rule-based with weighted keyword matching. It is NOT an LLM call.
  Each intent category has a set of signal patterns (keywords, phrases, question forms)
  with weights. The category with the highest cumulative weight wins.

  Implement the pattern set for every intent. Examples (expand these — do not limit
  to just the examples listed here):

    CODE_GENERATION:
      'implement', 'build', 'create', 'write a', 'add a', 'generate', 'make a',
      'set up', 'integrate', 'develop', weights: high for verbs at start of sentence

    MEMORY_RETRIEVAL:
      'what database', 'what framework', 'what are we using', 'what did we decide',
      'which library', 'what is our', 'remind me', 'what was the reason',
      question words at start (what/which/when/why) + project-specific nouns

    WEB_SEARCH:
      'search for', 'look up', 'find the latest', 'what is the current price',
      'what does X support', 'fetch', 'get information about', 'pricing'

    GIT_OPERATIONS:
      'commit', 'push', 'pull', 'branch', 'merge', 'rebase', 'stash',
      'git', 'history', 'diff', 'blame'

    TERMINAL_EXECUTION:
      'run', 'execute', 'npm', 'yarn', 'bun', 'pnpm', 'pip', 'cargo',
      'test', starts with a shell command pattern (word ending in .sh, /, ./), '&&'

    DEBUGGING:
      'error', 'bug', 'fix', 'broken', 'failing', 'exception', 'crash',
      'why is', 'why does', 'help me understand this error'

    CODE_REVIEW:
      'review', 'check', 'is this correct', 'any issues', 'feedback',
      'improve', 'optimize', 'refactor'

    MULTI_TOOL_WORKFLOW:
      combines signals from 2+ other categories in the same prompt
      detection: if the top two categories both exceed a threshold, return MULTI_TOOL

  Implementation approach:
    function classifyIntent(prompt: string): IntentClassification {
      // returns { intent: DeveloperIntent; confidence: number; signals: string[] }
    }
    The signals array lists which keywords triggered the classification — this is
    used by the toolSelector to make fine-grained tool selection decisions.

2.3 Fast path:
  If the prompt starts with '/' (slash command), return TERMINAL_EXECUTION with
  confidence 1.0 immediately. Do not run pattern matching.
  If the prompt is a single word or fewer than 5 characters, return CODE_GENERATION
  with confidence 0.5 (low confidence triggers a broader tool selection).

2.4 Export:
  export function classifyIntent(prompt: string): IntentClassification
  export interface IntentClassification { intent: DeveloperIntent; confidence: number; signals: string[] }

---

SECTION 3 — STEP 2: TOOL SELECTION ENGINE

File: node/orchestration/toolSelector.ts

The tool selector takes the intent classification and returns the set of tool adapters
to execute. Selection is dynamic — no intent has a hardcoded fixed set of tools.

3.1 Tool adapter registry:

  interface ToolAdapter {
    id: string
    name: string
    execute(request: OrchestrationRequest): Promise<ToolOutput>
    shouldRun(intent: IntentClassification, context: SelectionContext): boolean
  }

  interface SelectionContext {
    hasOpenFiles: boolean
    workspaceFolder: string
    promptLength: number
    hasImageAttachments: boolean
    isFollowUp: boolean     // true if this is not the first turn in the session
  }

  The registry is a Map<string, ToolAdapter> populated at startup.

3.2 Selection logic — implement this decision table fully:

  MEMORY_RETRIEVAL:
    Always: projectBrainAdapter (stub — returns empty context until Phase 1)
    Never:  webSearchAdapter, repositoryAdapter (memory questions don't need code)

  CODE_GENERATION (confidence >= 0.7):
    Always: projectBrainAdapter, repositoryAdapter, fileContextAdapter
    If signals contain dependency keywords: dependencyAdapter
    If confidence < 0.7: add projectBrainAdapter only (unclear intent, minimal context)

  ARCHITECTURE:
    Always: projectBrainAdapter, repositoryAdapter
    If session has history: fileContextAdapter

  WEB_SEARCH:
    Always: webSearchAdapter
    If signals also contain project keywords: projectBrainAdapter

  GIT_OPERATIONS:
    Always: gitAdapter
    If signals contain 'commit message' or 'PR': fileContextAdapter

  TERMINAL_EXECUTION:
    Always: terminalAdapter
    No other adapters (terminal commands need minimal context)

  DEBUGGING:
    Always: fileContextAdapter, repositoryAdapter
    If signals contain 'test': terminalAdapter (run tests to reproduce)
    If signals contain library/package names: dependencyAdapter

  CODE_REVIEW:
    Always: fileContextAdapter, repositoryAdapter
    If signals contain 'latest' or 'best practice': webSearchAdapter

  TESTING:
    Always: fileContextAdapter, dependencyAdapter, terminalAdapter

  PROJECT_ANALYSIS:
    Always: repositoryAdapter, gitAdapter, dependencyAdapter, projectBrainAdapter

  MULTI_TOOL_WORKFLOW:
    Union of tools from both top detected intents, deduplicated.

3.3 Export:
  export function selectTools(
    intent: IntentClassification,
    context: SelectionContext,
    registry: ToolAdapterRegistry
  ): ToolAdapter[]

---

SECTION 4 — STEP 3: TOOL EXECUTION LAYER (PARALLEL)

File: node/orchestration/toolExecutor.ts

4.1 Parallel execution:

  All selected tools run simultaneously using Promise.allSettled(). No tool waits
  for another. The total time is max(individual tool times), not sum.

  async function executeTools(
    tools: ToolAdapter[],
    request: OrchestrationRequest,
    onProgress: (event: ToolProgressEvent) => void,
    token: CancellationToken
  ): Promise<ToolOutput[]>

  Progress events are sent to the renderer via the existing ICodeMindEngineEvent
  channel so the user sees which tools are running. Add a new event type:
    { type: 'orchestration_progress'; phase: OrchestrationPhase; toolId: string; status: 'running' | 'complete' | 'failed'; durationMs?: number }

4.2 Timeout and failure handling:

  Each tool has a configurable timeout (default 5000ms, 10000ms for webSearchAdapter).
  If a tool times out: its output is replaced with a timeout marker and execution
  continues. The orchestration pipeline never stalls because one tool is slow.

  If a tool throws: its output is an error marker. It does not affect other tools.
  Record the error internally for the /doctor command to report.

4.3 Cancellation:

  Pass the CancellationToken from the outer queryStream() call to every tool.
  If the token is cancelled, abort all in-flight tool promises immediately.

---

SECTION 5 — STEP 4: CONTEXT AGGREGATION ENGINE

File: node/orchestration/contextAggregator.ts

5.1 Aggregated context structure:

  interface AggregatedContext {
    projectBrain: ProjectBrainContext | null      // from projectBrainAdapter
    repository: RepositoryContext | null          // from repositoryAdapter
    currentFiles: FileContext[]                   // from fileContextAdapter
    dependencies: DependencyContext | null        // from dependencyAdapter
    gitState: GitContext | null                   // from gitAdapter
    webResults: WebSearchResult[]                 // from webSearchAdapter
    terminalContext: TerminalContext | null        // from terminalAdapter
    collectionDurationMs: number
    toolsExecuted: string[]
    toolsFailed: string[]
  }

5.2 Aggregation:

  function aggregateToolOutputs(outputs: ToolOutput[]): AggregatedContext

  Each ToolOutput carries its adapter id. Route each to the appropriate field.
  Failed or timed-out tool outputs are recorded in toolsFailed and their
  corresponding context field remains null.

5.3 Structured context serialization:

  function serializeContext(context: AggregatedContext, intent: DeveloperIntent): string

  This function converts the aggregated context into a structured text block that
  will be prepended to the prompt. The format matches the FYP document's examples
  exactly. For CODE_GENERATION, it produces blocks like:

    === PROJECT CONTEXT ===
    Framework: Next.js 16
    Auth: Clerk
    Database: Supabase
    [... from projectBrainAdapter, even if stub returns placeholders]

    === REPOSITORY ===
    Current file: src/auth/LoginController.tsx
    Related files: src/auth/AuthProvider.tsx, src/lib/clerk.ts
    Auth folder structure: [list]

    === DEPENDENCIES ===
    @clerk/nextjs: 4.2.1
    [relevant packages only]

    === GIT STATE ===
    Branch: feat/auth-redesign
    Last commit: "Add Clerk provider wrapper"
    Modified files: [list]

  For MEMORY_RETRIEVAL, serialize ONLY the projectBrain section.
  For WEB_SEARCH, serialize web results first, then project context if present.
  The serialization must be compact — no verbose labels, no padding, no repetition.

---

SECTION 6 — STEP 5: CONTEXT OPTIMIZATION ENGINE

File: node/orchestration/contextOptimizer.ts

6.1 Optimization passes (run in this order):

  Pass 1 — Deduplication:
    Scan the serialized context for repeated information. If the same fact appears
    in two tool outputs (e.g. the framework name appears in both projectBrain and
    repository output), keep only the projectBrain instance and remove the duplicate.
    Use case-insensitive exact string matching for facts; semantic deduplication is
    out of scope for this phase.

  Pass 2 — Relevance pruning:
    Given the intent classification and its signals, remove context sections that
    are not relevant to this specific request.
    Rules:
      TERMINAL_EXECUTION: remove repository, dependencies, git state
      MEMORY_RETRIEVAL: remove repository, dependencies, git state, web results
      WEB_SEARCH (pure): remove repository, dependencies, git state
      All others: keep all sections

  Pass 3 — File context trimming:
    For file context, retain at most 200 lines per file.
    If the open file is longer than 200 lines, include lines 0-100 (the top) and
    the 50 lines surrounding the current cursor position.
    If no cursor position is known, include lines 0-150.
    Add a comment: "[... N lines omitted ...]" where N is the omitted line count.

  Pass 4 — Conversation history condensing:
    If the aggregated context includes conversation history from a prior turn, keep
    only the last 3 turns verbatim. For older turns, include only: the user's
    one-line summary (first sentence of their prompt) and the assistant's decision
    (first sentence of its response). Prefix these with "[summarized]".

6.2 Token estimation:
  After optimization, estimate the token count of the combined context + original
  prompt using a simple heuristic: characters / 4 (a reasonable approximation for
  English + code text).

  Return an OptimizedContext that includes:
    serializedContext: string
    estimatedTokens: number
    sectionsIncluded: string[]
    sectionsRemoved: string[]
    optimizationDurationMs: number

---

SECTION 7 — STEP 6: HEADROOM COMPRESSION LAYER

File: node/orchestration/headroomLayer.ts

7.1 Import and initialization:

  The Headroom TypeScript SDK is installed in claude-code/node_modules.
  Dynamic import it at runtime (the same pattern used for the Claude Agent SDK):
    const headroomPath = resolveHeadroomPath()  // climb from import.meta.url
    const { compress } = await import(headroomPath)

  resolveHeadroomPath() climbs from the worker's import.meta.url the same way the
  existing engine main resolves the SDK path — find the claude-code/ sibling and
  resolve claude-code/node_modules/headroom-ai/dist/index.js (or whatever the
  package's main entry is — read package.json to find it).

  If the import fails for any reason (package not installed, wrong Node version):
    log a warning: "Headroom not available — forwarding prompt unchanged"
    return the original prompt unmodified. The orchestration pipeline must always
    complete even without Headroom.

7.2 Compression decision:

  The FYP document specifies adaptive compression:
    estimatedTokens < 2000:  no compression, forward unchanged (small prompts)
    estimatedTokens < 8000:  light compression (compress context sections only)
    estimatedTokens >= 8000: aggressive compression (compress everything)

  Implement this as:
    function shouldCompress(estimatedTokens: number): CompressionMode
    type CompressionMode = 'none' | 'light' | 'aggressive'

7.3 Compression implementation:

  NONE: return the optimized context and prompt unchanged.

  LIGHT: run Headroom compress() on the context block only, not on the user's
         original prompt text. The user's words are preserved verbatim.
         Reconstruct the full message as: compressedContext + '\n\n' + originalPrompt.

  AGGRESSIVE: run Headroom compress() on the full combined context + prompt.

  The model parameter for compress() is the model currently configured for the
  session (read from the engine's model setting).

7.4 Post-compression reporting:

  Emit an orchestration event reporting:
    originalTokens: number (estimated before compression)
    compressedTokens: number (estimated after compression)
    compressionMode: CompressionMode
    headroomAvailable: boolean

  This data appears in the /cost command output and in the session footer.

---

SECTION 8 — STEP 7: TOOL ADAPTERS

Implement each adapter. Read the corresponding tools in claude-code/src/tools/ before
implementing — the adapters delegate to the same operations, not reimplementations.

8.1 projectBrainAdapter.ts (STUB — Phase 1 not yet built)

  Returns a hard-coded ProjectBrainContext with empty arrays and a note:
    { available: false, reason: 'Project Brain not yet initialized (Phase 1)', facts: [], decisions: [] }
  This stub is replaced when Phase 1 is implemented. The orchestration pipeline
  works correctly with the stub — it just produces no project-knowledge context.

8.2 repositoryAdapter.ts

  Uses the existing GlobTool and GrepTool patterns (the claude-code SDK's built-in
  tools) but runs them BEFORE the SDK call, not inside it.

  Collect:
    - The open file's path and its directory (from the request's cwd)
    - Files in the same directory as the open file
    - Files in any directory named 'auth/', 'api/', 'lib/', 'utils/', 'services/',
      'components/', 'hooks/', 'store/', 'routes/' that exist in the workspace
    - The project's entry files: index.ts, main.ts, app.ts, package.json
      (read the names only, not full content — full content is for fileContextAdapter)

  Implementation: use Node's fs/promises (readdir, stat) and glob patterns. Do not
  shell out. Keep the list to at most 50 paths.

  Returns: { openFile: string; relatedFiles: string[]; projectEntryPoints: string[] }

8.3 fileContextAdapter.ts

  Reads the content of the currently open files in the editor. The request object
  carries the open file paths (obtained from the viewPane's file context — see the
  attachment/@ mention system already built in Phase 3).

  For each open file:
    Read the file content using Node's fs/promises.readFile.
    Apply the 200-line trimming from Section 6.3 immediately (do not return more).
    Detect language from extension for syntax-aware labeling.

  Returns: FileContext[] where each entry is { path: string; language: string; content: string; trimmed: boolean }

8.4 dependencyAdapter.ts

  Reads the project's package.json (or requirements.txt, Cargo.toml, go.mod depending
  on what exists in the workspace root).

  For Node projects:
    Read package.json dependencies and devDependencies.
    Return only packages that are relevant to the current request (filter by
    the intent signals — if the prompt mentions 'auth', return auth-related packages;
    if no specific signals, return all dependencies capped at 30 entries).

  For non-Node projects: return an empty list with a note of the project type found.

8.5 gitAdapter.ts

  Runs git commands using Node's child_process.execFile with the workspace folder
  as cwd. Use execFile, never exec (shell injection risk).

  Collect:
    git rev-parse --abbrev-ref HEAD          — current branch name
    git log --oneline -5                     — last 5 commits (one line each)
    git diff --stat HEAD                     — modified files summary (not full diff)
    git status --short                       — current working tree status

  Timeout: 3000ms per command. If git is not available or not a git repo, return
  { available: false }.

  Returns: GitContext with branch, recentCommits, modifiedFiles, status fields.

8.6 webSearchAdapter.ts

  Delegates to the Claude Agent SDK's built-in web search tool rather than
  reimplementing search. This adapter is only executed for WEB_SEARCH intent.

  Strategy: instead of running web search before the SDK call (which would require
  a separate API call), the webSearchAdapter enriches the prompt with a directive:
    "[Search: {extracted search terms from the prompt}]"
  This signals to the orchestration-aware system prompt that a web search was
  requested, and the Claude Agent SDK's own WebSearchTool will execute it.

  Extract search terms from the prompt using simple keyword extraction:
    remove common words (the, a, an, is, are, what, how, etc.)
    extract the noun phrases and technical terms
    return at most 5 terms joined as a search query

  Returns: WebSearchResult[] = []  (empty — results come from the SDK's own tool)
  Also returns: injectedDirective: string (the [Search: ...] text to prepend)

8.7 terminalAdapter.ts

  For TERMINAL_EXECUTION intent, the adapter reads the current shell environment
  to provide context. It does NOT run commands proactively.

  Collect:
    The working directory (cwd from the request)
    The shell type (SHELL env var or 'cmd.exe' on Windows)
    Whether a dev server appears to be running (check if common ports 3000, 8080,
    5173 are in use — use a fast TCP connect attempt with 100ms timeout)
    The result of reading package.json scripts (if present)

  Returns: TerminalContext with { cwd, shell, devServerRunning, availableScripts }

---

SECTION 9 — STEP 8: ORCHESTRATION REQUEST AND MAIN COORDINATOR

File: node/codeMindOrchestrationEngine.ts

9.1 OrchestrationRequest interface:

  interface OrchestrationRequest {
    queryId: string
    userPrompt: string
    openFiles: string[]           // paths of currently open files in editor
    workspaceFolder: string
    sessionHistory: TurnSummary[] // the last N turns for context
    isFollowUp: boolean
    model: string
    token: CancellationToken
  }

  interface TurnSummary {
    userPromptFirstLine: string
    assistantResponseFirstLine: string
    turnIndex: number
  }

9.2 OrchestrationResult interface:

  interface OrchestrationResult {
    enrichedPrompt: string          // the final prompt to pass to the Claude Agent SDK
    systemPromptSuffix: string      // appended to the SDK system prompt
    orchestrationMetadata: {
      intent: DeveloperIntent
      confidence: number
      toolsExecuted: string[]
      toolsFailed: string[]
      originalTokenEstimate: number
      finalTokenEstimate: number
      compressionMode: CompressionMode
      headroomAvailable: boolean
      totalDurationMs: number
    }
  }

9.3 Main orchestration function:

  async function orchestrate(
    request: OrchestrationRequest,
    registry: ToolAdapterRegistry,
    onProgress: (event: OrchestrationProgressEvent) => void
  ): Promise<OrchestrationResult>

  Implementation:

    const t0 = Date.now()

    // Step 1: Intent
    onProgress({ phase: 'intent_detection', status: 'running' })
    const intent = classifyIntent(request.userPrompt)
    onProgress({ phase: 'intent_detection', status: 'complete', result: intent.intent })

    // Step 2: Tool selection
    const selectionContext: SelectionContext = {
      hasOpenFiles: request.openFiles.length > 0,
      workspaceFolder: request.workspaceFolder,
      promptLength: request.userPrompt.length,
      hasImageAttachments: false,  // not yet plumbed through
      isFollowUp: request.isFollowUp,
    }
    const selectedTools = selectTools(intent, selectionContext, registry)

    // Step 3: Parallel execution
    onProgress({ phase: 'tool_execution', status: 'running', tools: selectedTools.map(t => t.id) })
    const toolOutputs = await executeTools(selectedTools, request, onProgress, request.token)
    onProgress({ phase: 'tool_execution', status: 'complete' })

    // Step 4: Aggregation
    const aggregated = aggregateToolOutputs(toolOutputs)
    const serialized = serializeContext(aggregated, intent.intent)

    // Step 5: Optimization
    const optimized = optimizeContext(serialized, request.userPrompt, intent)

    // Step 6: Headroom
    const compressed = await compressContext(optimized, request.model, request.token)

    // Build final prompt
    const enrichedPrompt = compressed.context
      ? `${compressed.context}\n\n---\n\n${request.userPrompt}`
      : request.userPrompt

    const systemPromptSuffix = buildSystemPromptSuffix(intent, aggregated)

    return {
      enrichedPrompt,
      systemPromptSuffix,
      orchestrationMetadata: {
        intent: intent.intent,
        confidence: intent.confidence,
        toolsExecuted: aggregated.toolsExecuted,
        toolsFailed: aggregated.toolsFailed,
        originalTokenEstimate: optimized.estimatedTokens,
        finalTokenEstimate: compressed.estimatedTokens,
        compressionMode: compressed.mode,
        headroomAvailable: compressed.headroomAvailable,
        totalDurationMs: Date.now() - t0,
      }
    }

9.4 buildSystemPromptSuffix:

  Appends a short, structured note to the Claude Agent SDK's system prompt so that
  Claude understands what context has been pre-fetched:

    function buildSystemPromptSuffix(intent: IntentClassification, context: AggregatedContext): string

  The suffix follows this template (adapt per intent):

    "\n\n[CODEMIND ORCHESTRATION]\nDetected intent: {intent}\nPre-fetched context: {list of sections included}\nProject Brain: {available|stub}\nDo not ask for information already in the context above."

  Keep it under 100 tokens. Do not repeat the context content — just label what was injected.

---

SECTION 10 — STEP 9: INTEGRATION INTO codeMindAgentEngineMain.ts

10.1 Modify codeMindAgentEngineMain.ts to call the orchestration engine:

  In the _runStream() method (or wherever queryStream() calls query()):

    BEFORE:
      const stream = query({ prompt: request.prompt, options: { ... } })

    AFTER:
      const orchestrationRequest: OrchestrationRequest = {
        queryId: request.queryId,
        userPrompt: request.prompt,
        openFiles: request.attachedFiles ?? [],
        workspaceFolder: this._workspaceFolder ?? process.cwd(),
        sessionHistory: this._buildSessionHistory(),
        isFollowUp: this._sessionTurnCount > 0,
        model: this._model,
        token: cancelToken,
      }

      const orchestrated = await orchestrate(
        orchestrationRequest,
        this._toolAdapterRegistry,
        (event) => this._emitOrchestrationEvent(event)
      )

      const stream = query({
        prompt: orchestrated.enrichedPrompt,
        options: {
          ...existingOptions,
          systemPrompt: (existingOptions.systemPrompt ?? '') + orchestrated.systemPromptSuffix,
        }
      })

10.2 Initialize the ToolAdapterRegistry in the engine constructor:

  Create and register all adapters on startup. The registry is a singleton
  within the worker process. Each adapter is stateless between calls.

10.3 _buildSessionHistory():

  Return the last 3 TurnSummary objects from the session's message history.
  If fewer than 3 turns exist, return what is available.
  Each TurnSummary's firstLine is the first 80 characters of the turn's content.

10.4 _emitOrchestrationEvent():

  Emit a new ICodeMindEngineEvent type:
    { type: 'orchestration_progress'; queryId: string; phase: OrchestrationPhase; status: 'running' | 'complete' | 'failed'; toolId?: string; intent?: DeveloperIntent; durationMs?: number }

  Add this type to the ICodeMindEngineEvent union in common/codeMindAgentEngineService.ts.

10.5 Track workspace folder:

  The engine already has access to the CWD via process.cwd() or the request options.
  Read it when the first session starts and store it as this._workspaceFolder.
  If the workspace folder changes (detected via a new queryStream call with a
  different cwd), update the stored value.

---

SECTION 11 — ORCHESTRATION VISIBILITY IN THE UI

The orchestration pipeline runs invisibly to the user by default. Add minimal,
non-intrusive visibility.

11.1 Intent badge in the message header:

  When a new assistant message starts (after a text or thinking event), show
  a small badge in the message bubble's top-right corner indicating what the
  orchestration detected:

    "Code generation · 3 tools"  — for CODE_GENERATION with 3 adapters
    "Memory retrieval"           — for MEMORY_RETRIEVAL
    "Web + Code"                 — for MULTI_TOOL_WORKFLOW

  The badge: 10px, var(--vscode-descriptionForeground) at 50% opacity.
  It fades in when the orchestration_progress event with phase 'complete' arrives.
  No badge for pure TERMINAL_EXECUTION (it's obvious what's happening).

11.2 Tool execution indicator:

  While the orchestration pipeline is running (between the user pressing Enter and
  the first text event arriving), show a subtle animation in the spinner area:

    Instead of "Thinking..." show "Preparing context..."
    When tool execution starts: "Running [n] tools..."
    When tool execution completes and Headroom runs: "Optimizing prompt..."
    When the Claude Agent SDK stream starts: revert to "Thinking..."

  Implement this by handling the orchestration_progress events in agent.js.
  The existing spinner infrastructure handles the display — just update the label.

11.3 /orchestration command (slash command):

  Add a new /orchestration command to the CommandRegistry that shows the
  orchestration metadata from the last request:

    Intent: code_generation (87% confidence)
    Tools executed: repository, fileContext, dependency (3 tools, 142ms)
    Tools failed: none
    Token estimate: 4,200 → 2,800 after optimization (Headroom: light compression)
    Total overhead: 156ms

  This command is for power users and FYP demonstration. It reads the stored
  orchestrationMetadata from the last completed turn.

---

SECTION 12 — /cost COMMAND ENHANCEMENT

The existing /cost command shows session cost and duration. Enhance it to also
show orchestration savings over the session:

  Session cost: $0.0412
  Duration: 28.4s (5 turns)
  ─────────────────────────────
  Orchestration:
    Tokens sent to model: 18,400
    Tokens saved by optimization: 3,200 (17%)
    Tokens saved by Headroom: 4,100 (22%)
    Combined reduction: 7,300 tokens (39%)
    Headroom compression mode: light (avg)

Track these cumulative values in the engine's session state and expose them via
a new getOrchestrationStats() method on ICodeMindAgentEngineService.

---

SECTION 13 — SETTINGS INTEGRATION

13.1 Add to the /config settings panel:

  Orchestration section:
    Enable orchestration: toggle (default on)
    Headroom compression: select (none / auto / always)
    Tool timeout: number input, default 5000ms
    Max context tokens before Headroom: number input, default 2000

13.2 Wire settings to the engine:

  Read these settings at the start of each queryStream() call.
  If "Enable orchestration" is off, skip the entire orchestration pipeline and
  call the Claude Agent SDK directly with the original prompt (the pre-Phase-2 behavior).

  This is the escape hatch that lets users disable the feature if they want raw behavior.

---

SECTION 14 — IMPLEMENTATION ORDER

Implement in this exact order. After each step, verify with tsgo --noEmit before proceeding.

  Step 1: Install headroom-ai in claude-code/ and verify the TypeScript types are readable.
          If installation fails, document why and proceed with the stub (Section 7.1 pattern).

  Step 2: Define all types and interfaces (OrchestrationRequest, OrchestrationResult,
          IntentClassification, AggregatedContext, etc.) in a new
          node/orchestration/types.ts file. No logic yet — just types.
          tsgo --noEmit must pass after this step.

  Step 3: Implement intentDetector.ts. Write a quick self-test at the bottom
          (commented out, behind a DEBUG flag) that verifies 5 example prompts
          classify correctly. tsgo --noEmit.

  Step 4: Implement toolSelector.ts. tsgo --noEmit.

  Step 5: Implement all tool adapters (Section 8). Start with the stub (8.1),
          then gitAdapter (8.5) since it is self-contained, then repositoryAdapter (8.2),
          fileContextAdapter (8.3), dependencyAdapter (8.4), webSearchAdapter (8.6),
          terminalAdapter (8.7). tsgo --noEmit after each.

  Step 6: Implement toolExecutor.ts with Promise.allSettled and timeout logic.
          tsgo --noEmit.

  Step 7: Implement contextAggregator.ts and contextOptimizer.ts. tsgo --noEmit.

  Step 8: Implement headroomLayer.ts. Test the import path resolution logic
          with a console.log probe (temporary, remove after). tsgo --noEmit.

  Step 9: Implement codeMindOrchestrationEngine.ts (the coordinator). tsgo --noEmit.

  Step 10: Integrate into codeMindAgentEngineMain.ts (Section 10). Add the new
           event type to common/codeMindAgentEngineService.ts.
           tsgo --noEmit. gulp compile-client. Launch and run a test prompt.

  Step 11: Add UI changes (Section 11) — intent badge, spinner labels, /orchestration command.
           node --check on agent.js. tsgo --noEmit. Verify visually.

  Step 12: Add /cost enhancement (Section 12) and settings integration (Section 13).
           tsgo --noEmit. gulp compile-client.

  Step 13: Full end-to-end test (Section 15).

---

SECTION 15 — END-TO-END VERIFICATION

After Step 12, run these manual tests and record PASS/FAIL for each:

  O-001: Send "What database are we using?" — intent should classify as MEMORY_RETRIEVAL,
         only projectBrainAdapter should run, /orchestration shows 1 tool.

  O-002: Send "Implement a login screen" — intent CODE_GENERATION, at least 3 tools run,
         context block appears in the enriched prompt, response is architecture-aware.

  O-003: Send "Search for the latest Next.js pricing" — intent WEB_SEARCH, web search
         directive injected, SDK's own web search tool fires.

  O-004: Send "Run npm test" — intent TERMINAL_EXECUTION, minimal tools run, no repo
         context injected.

  O-005: Send "Why is my auth failing? Check the error" — intent DEBUGGING,
         fileContextAdapter and repositoryAdapter run.

  O-006: Send a prompt with "Build auth using Clerk and also check latest Clerk pricing" —
         intent MULTI_TOOL_WORKFLOW, both CODE_GENERATION and WEB_SEARCH tools selected.

  O-007: Disable orchestration in settings, send a prompt — verify raw SDK behavior,
         no "Preparing context..." label, no intent badge.

  O-008: Check /cost after 3 turns — verify orchestration savings are shown.

  O-009: Run /orchestration — verify last turn's metadata is shown correctly.

  O-010: Send a very short prompt (under 5 chars) — verify low-confidence fallback,
         no crash, minimal tool selection.

---

CONSTRAINTS (absolute, no exceptions)

  Import paths: always relative with .js extensions.
  No external npm packages in the vscode/ tree. headroom-ai installs in claude-code/ only.
  The Headroom import is a dynamic import() at runtime, not a static import.
  All tool adapter file I/O uses Node's fs/promises — no synchronous file reads.
  All shell commands in gitAdapter use execFile with an explicit args array — never exec().
  The orchestration pipeline must complete (possibly with empty context) within 6000ms.
    If the pipeline takes longer than 6000ms, emit a timeout event and proceed with
    the un-enriched original prompt. Never block the user's request.
  The orchestration engine is disabled entirely when the orchestration toggle in
    settings is off. This toggle is checked at the start of every queryStream() call.
  tsgo --noEmit must pass after every step. Do not proceed with TypeScript errors.
  node --check must pass on agent.js after UI changes.
  gulp compile-client must succeed before declaring Phase 2 complete.
  After compile, run the O-001 through O-010 tests and record results.