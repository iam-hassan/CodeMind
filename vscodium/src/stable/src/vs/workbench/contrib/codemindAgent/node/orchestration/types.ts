/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 2 Orchestration Types
 * All request/response shapes for the adaptive orchestration engine.
 * No logic — pure type definitions. tsgo --noEmit must pass after this file.
 */

// ============================================================================
// INTENT DETECTION
// ============================================================================

export enum DeveloperIntent {
    CODE_GENERATION = 'code_generation',
    MEMORY_RETRIEVAL = 'memory_retrieval',
    ARCHITECTURE = 'architecture',
    WEB_SEARCH = 'web_search',
    GIT_OPERATIONS = 'git_operations',
    TERMINAL_EXECUTION = 'terminal_execution',
    DOCUMENTATION = 'documentation',
    DEBUGGING = 'debugging',
    CODE_REVIEW = 'code_review',
    TESTING = 'testing',
    PROJECT_ANALYSIS = 'project_analysis',
    MULTI_TOOL_WORKFLOW = 'multi_tool_workflow',
}

/**
 * A capability is a concrete kind of context (or action) that a registered tool
 * adapter can actually provide. Tool selection matches an intent's REQUIRED
 * capabilities against the capabilities each adapter ADVERTISES — it never keys
 * off a hardcoded adapter-id list. This taxonomy is deliberately limited to
 * capabilities a real adapter provides today; composite notions like
 * "architecture context" or "debugging context" are served by COMPOSING these
 * concrete capabilities and surface as human-readable selection reasons, not as
 * phantom capabilities that nothing can satisfy.
 */
export type Capability =
    | 'project_memory'          // projectBrain: remembered project facts
    | 'architecture_history'    // projectBrain: past architectural decisions
    | 'decision_history'        // projectBrain: rationale for past choices
    | 'repository_context'      // repository: related files around the open file
    | 'project_structure'       // repository: entry points / layout
    | 'dependency_context'      // dependency: declared packages / project type
    | 'current_file_context'    // fileContext: the open file(s) content
    | 'git_context'             // git: branch / recent commits / status
    | 'git_operations'          // git: the intent is a git action
    | 'terminal_execution'      // terminal: run commands / dev server / scripts
    | 'testing'                 // terminal: run or reason about tests
    | 'web_search'              // webSearch: fetch external/current information
    | 'external_information';   // webSearch: general external knowledge

/**
 * A single actionable objective extracted from a compound prompt clause. A
 * genuine MULTI_TOOL_WORKFLOW needs ≥2 of these with DISTINCT intents — not
 * merely two keyword families firing on one clause.
 */
export interface CompoundObjective {
    /** The clause text the objective was read from. */
    clause: string;
    /** The intent this clause independently resolves to. */
    intent: DeveloperIntent;
    /** Raw deterministic keyword score of the clause (evidence, not probability). */
    score: number;
}

/**
 * Raw Stage-1 deterministic keyword EVIDENCE. This is deliberately NOT a
 * decision and NOT a probability: `topScore`/`secondScore` are unbounded
 * weighted-keyword sums. Fusion consumes this as one input among several; it is
 * surfaced verbatim so a reader can see the keyword evidence separately from the
 * model probability and from the final fused confidence.
 */
export interface DeterministicEvidence {
    topIntent: DeveloperIntent;
    topScore: number;
    secondIntent: DeveloperIntent;
    secondScore: number;
    /** Normalized top-vs-second gap in [0,1] (0 = tie, 1 = uncontested). */
    margin: number;
    /** Human-readable keyword signals that fired for the top intent. */
    signals: string[];
    /** Distinct actionable objectives found by clause-level compound analysis. */
    compoundObjectives: CompoundObjective[];
}

/**
 * Local TF-IDF + logistic-regression PROBABILITY prediction. `probability` is a
 * softmax value in [0,1] — a different quantity from the deterministic keyword
 * score and from the final fused confidence, and never conflated with either.
 */
export interface MlPrediction {
    intent: DeveloperIntent;
    /** Top softmax probability in [0,1]. */
    probability: number;
    /** True when at least one token was in the model vocabulary. */
    hasFeatures: boolean;
    /** True when the model was actually consulted (Stage-1 was uncertain). */
    consulted: boolean;
}

export interface IntentClassification {
    intent: DeveloperIntent;
    /**
     * FINAL fused confidence in [0,1]. This is a calibrated blend of evidence
     * strength, cross-stage agreement, and score margin — it is NOT the raw
     * normalized keyword score (see `deterministicEvidence` for that) and NOT the
     * model probability (see `mlPrediction` for that).
     */
    confidence: number;
    signals: string[]; // keywords/phrases that triggered this classification
    // --- Phase-2 re-evaluation enrichment (optional → backward compatible) ---
    /** Same value as `intent`; named explicitly for the enriched contract. */
    primaryIntent?: DeveloperIntent;
    /** Other intents that also scored strongly (multi-intent prompts). */
    secondaryIntents?: DeveloperIntent[];
    /** Capabilities this intent conceptually needs (context-free base set). */
    requiredCapabilities?: Capability[];
    /** Normalized gap between the top and second intent scores (0 = tie). */
    margin?: number;
    /** True when the decision was low-confidence or narrow-margin. */
    ambiguous?: boolean;
    /** Which stage produced this classification (honesty / trace). */
    classifierStage?: 'fast_path' | 'deterministic' | 'local_model' | 'fusion' | 'compound';
    // --- Fusion contract (Phase-2 re-evaluation, Option 1) ---
    /** Raw deterministic keyword evidence (a SCORE, never a confidence). */
    deterministicEvidence?: DeterministicEvidence;
    /** Local model probability prediction (a PROBABILITY); null when not consulted. */
    mlPrediction?: MlPrediction | null;
    /** Human-readable explanation of how the fusion reached this decision. */
    classificationReason?: string;
}

// ============================================================================
// TOOL ADAPTERS
// ============================================================================

export interface ToolAdapter {
    id: string;
    name: string;
    execute(request: OrchestrationRequest): Promise<ToolOutput>;
    shouldRun(intent: IntentClassification, context: SelectionContext): boolean;
    /** Per-adapter hard timeout in milliseconds (Addendum A.4) */
    readonly TIMEOUT_MS?: number;
    // --- Capability advertisement (Phase-2 re-evaluation) ---
    /** Concrete capabilities this adapter can actually provide. Tool selection
     *  matches an intent's required capabilities against THIS list — never a
     *  hardcoded adapter-id switch. */
    readonly capabilities?: Capability[];
    /** Capabilities this adapter needs satisfied first (dependency edges). Empty today. */
    readonly requires?: Capability[];
    /** Rough compute/token cost of running this adapter. */
    readonly cost?: 'low' | 'medium' | 'high';
    /** Rough latency class (drives race-for-minimum-context ordering). */
    readonly latency?: 'fast' | 'medium' | 'slow';
    /** True if the adapter reaches outside the workspace (network / subprocess). */
    readonly external?: boolean;
    /** True if the adapter is safe to run in the parallel execution pool. */
    readonly supportsParallel?: boolean;
}

export interface SelectionContext {
    hasOpenFiles: boolean;
    workspaceFolder: string;
    promptLength: number;
    hasImageAttachments: boolean;
    isFollowUp: boolean;
}

export type ToolAdapterRegistry = Map<string, ToolAdapter>;

/**
 * Per-adapter record of WHY it was selected or skipped. Feeds the dev-mode trace
 * so the selection is auditable: every registered adapter appears here, selected
 * or not, with the capabilities it advertised, the ones the intent actually
 * required, and a human-readable reason.
 */
export interface ToolSelectionDecision {
    adapterId: string;
    selected: boolean;
    /** Everything this adapter advertises. */
    advertisedCapabilities: Capability[];
    /** required ∩ advertised — why it was a candidate at all. */
    matchedCapabilities: Capability[];
    /** Human-readable selection / skip reason. */
    reason: string;
}

/**
 * Result of capability-based tool selection. `selected` preserves the resolution
 * order (one adapter per required capability, in required-capability order). The
 * remaining fields exist for the trace and for honesty about what the intent
 * asked for vs. what the registry could actually satisfy.
 */
export interface ToolSelectionResult {
    selected: ToolAdapter[];
    decisions: ToolSelectionDecision[];
    /** Ordered capabilities the intent+context required. */
    requiredCapabilities: Capability[];
    /** Required capabilities an enabled adapter actually covered. */
    satisfiedCapabilities: Capability[];
    /** Required capabilities no enabled adapter could cover. */
    unmetCapabilities: Capability[];
}

// ============================================================================
// ORCHESTRATION REQUEST / RESULT
// ============================================================================

export interface TurnSummary {
    userPromptFirstLine: string;
    assistantResponseFirstLine: string;
    turnIndex: number;
}

export interface OrchestrationRequest {
    queryId: string;
    userPrompt: string;
    openFiles: string[];
    workspaceFolder: string;
    sessionHistory: TurnSummary[];
    isFollowUp: boolean;
    model: string;
    token: any; // CancellationToken (imported at runtime to avoid circular deps)
}

export type CompressionMode = 'none' | 'light' | 'aggressive';

export interface OrchestrationResult {
    enrichedPrompt: string;
    systemPromptSuffix: string;
    orchestrationMetadata: {
        intent: DeveloperIntent;
        confidence: number;
        toolsExecuted: string[];
        toolsFailed: string[];
        originalTokenEstimate: number;
        finalTokenEstimate: number;
        compressionMode: CompressionMode;
        headroomAvailable: boolean;
        tokensSaved?: number;
        proxyReachable?: boolean;
        totalDurationMs: number;
        performanceWarning?: string;
    };
}

// ============================================================================
// TOOL OUTPUTS (one per adapter)
// ============================================================================

export interface ProjectBrainContext {
    available: boolean;
    reason?: string;
    facts: string[];
    decisions: string[];
}

export interface RepositoryContext {
    openFile: string;
    relatedFiles: string[];
    projectEntryPoints: string[];
}

export interface FileContext {
    path: string;
    language: string;
    content: string;
    trimmed: boolean;
}

export interface DependencyContext {
    projectType: string;
    packages: Array<{ name: string; version: string }>;
}

export interface GitContext {
    available: boolean;
    branch?: string;
    recentCommits?: string[];
    modifiedFiles?: string[];
    status?: string;
}

export interface WebSearchResult {
    injectedDirective: string; // "[Search: ...]" text only; real results come from SDK
}

export interface TerminalContext {
    cwd: string;
    shell: string;
    devServerRunning: boolean;
    availableScripts: string[];
}

export interface ToolOutput {
    adapterId: string;
    status: 'success' | 'timeout' | 'error';
    durationMs: number;
    outputSummary: string; // first 200 chars
    outputTokenEstimate: number;
    // One of the following will be populated based on adapterId:
    projectBrain?: ProjectBrainContext;
    repository?: RepositoryContext;
    currentFiles?: FileContext[];
    dependencies?: DependencyContext;
    gitState?: GitContext;
    // An array so it spreads into AggregatedContext.webResults alongside every other
    // adapter's output; webSearchAdapter emits a single directive today.
    webResults?: WebSearchResult[];
    terminalContext?: TerminalContext;
    error?: string;
}

// ============================================================================
// AGGREGATED CONTEXT (after Step 4)
// ============================================================================

export interface AggregatedContext {
    projectBrain: ProjectBrainContext | null;
    repository: RepositoryContext | null;
    currentFiles: FileContext[];
    dependencies: DependencyContext | null;
    gitState: GitContext | null;
    webResults: WebSearchResult[];
    terminalContext: TerminalContext | null;
    collectionDurationMs: number;
    toolsExecuted: string[];
    toolsFailed: string[];
}

// ============================================================================
// OPTIMIZED CONTEXT (after Step 5)
// ============================================================================

export interface OptimizedContext {
    serializedContext: string;
    estimatedTokens: number;
    sectionsIncluded: string[];
    sectionsRemoved: string[];
    optimizationDurationMs: number;
}

// ============================================================================
// HEADROOM COMPRESSION (after Step 6)
// ============================================================================

export interface CompressedContext {
    context: string | null; // null means "use original prompt unchanged"
    estimatedTokens: number;
    mode: CompressionMode;
    headroomAvailable: boolean;
    compressionRatio?: number;
}

// ============================================================================
// PROGRESS / TRACE EVENTS (Addendum A + B)
// ============================================================================

export type OrchestrationPhase =
    | 'intent_detection'
    | 'tool_selection'
    | 'tool_execution'
    | 'context_aggregation'
    | 'context_optimization'
    | 'headroom_compression'
    | 'claude_sdk'
    | 'cache_hit'
    | 'timeout';

export interface OrchestrationProgressEvent {
    type: 'orchestration_progress';
    queryId: string;
    phase: OrchestrationPhase;
    status: 'running' | 'complete' | 'failed' | 'skipped';
    toolId?: string;
    intent?: DeveloperIntent;
    durationMs?: number;
    message?: string;
}

// Layer trace for dev mode (Addendum B.2)
/**
 * Structured Headroom (Layer 6) fields attached to a LayerTrace so the trace panel
 * can render the rich key/value block (library / proxy / mode / before→after / ratio).
 * Local-proxy only — no cloud endpoint, no key, no conversation data off-box.
 */
export interface HeadroomLayerMeta {
    library: string;
    baseUrl: string;
    mode: CompressionMode;
    originalTokens: number;
    compressedTokens: number;
    tokensSaved: number;
    compressionRatio: number;
    headroomAvailable: boolean;
    proxyReachable: boolean;
    durationMs: number;
}

export interface LayerTrace {
    layerName: string;
    layerIndex: number; // 1-7
    durationMs: number;
    status: 'pass' | 'timeout' | 'skipped' | 'error';
    input: unknown; // JSON-safe, capped at 500 chars for previews
    output: unknown;
    inputTokenEstimate: number;
    outputTokenEstimate: number;
    notes: string[];
    /** Present only on the Layer-6 (headroomCompression) row — drives the rich card. */
    headroom?: HeadroomLayerMeta;
}

/**
 * Headroom PROXY-IN-PATH outcome for one turn — the only thing the simplified
 * Orchestration Trace panel renders: what went in, and whether the local proxy
 * actually compressed it. Local-proxy only; nothing off-box.
 *
 * When `proxyActive` is true the turn's LLM traffic was routed through the local
 * Headroom proxy (ANTHROPIC_BASE_URL → proxy → the configured gateway), so the
 * before/after token counts are read from the proxy's own `/stats` delta across
 * this turn. When it is false the proxy was not running and the request went
 * straight to the gateway, uncompressed.
 */
export interface HeadroomProxyOutcome {
    /** The local proxy was reachable and this turn was routed through it. */
    proxyActive: boolean;
    /** True only when the proxy actually reduced the request (savedTokens > 0). */
    optimized: boolean;
    /** The user's prompt — the human-facing "input" line. */
    input?: string;
    /** The local proxy URL turns were routed through (e.g. http://localhost:7878). */
    proxyUrl?: string;
    /** The gateway the proxy forwards to (the configured endpoint). */
    upstream?: string;
    /** Request tokens this turn, before compression (from the proxy /stats delta). */
    beforeTokens?: number;
    /** Request tokens this turn, after compression (from the proxy /stats delta). */
    afterTokens?: number;
    /** beforeTokens − afterTokens for this turn. */
    savedTokens?: number;
    /** afterTokens / beforeTokens for this turn (1 = unchanged). */
    ratio?: number;
    /** Human-readable outcome / why-not (proxy down, no savings, stats unavailable…). */
    reason: string;
}

export interface OrchestrationTrace {
    queryId: string;
    timestamp: number;
    totalDurationMs: number;
    cacheHit: boolean;
    timedOut: boolean;
    layers: LayerTrace[];
    /** Classified intent for the header line (optional → backward compatible). */
    intent?: DeveloperIntent;
    /** Suffix token estimate before Layer-6 compression (for the header delta). */
    originalTokens?: number;
    /** Suffix token estimate after Layer-6 compression (for the header delta). */
    finalTokens?: number;
    /** Headroom proxy-in-path outcome — the simplified panel renders only this. */
    headroomProxy?: HeadroomProxyOutcome;
}

export interface OrchestrationTraceEvent {
    type: 'orchestration_trace';
    queryId: string;
    trace: OrchestrationTrace;
}

// Re-export for convenience in other modules
export type { CancellationToken } from '../../../../../base/common/cancellation.js';
