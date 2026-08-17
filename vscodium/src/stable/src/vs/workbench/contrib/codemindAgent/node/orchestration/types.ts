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

export interface IntentClassification {
    intent: DeveloperIntent;
    confidence: number; // 0.0 - 1.0
    signals: string[]; // keywords/phrases that triggered this classification
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
}

export interface SelectionContext {
    hasOpenFiles: boolean;
    workspaceFolder: string;
    promptLength: number;
    hasImageAttachments: boolean;
    isFollowUp: boolean;
}

export type ToolAdapterRegistry = Map<string, ToolAdapter>;

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
        totalDurationMs: number;
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
}

export interface OrchestrationTrace {
    queryId: string;
    timestamp: number;
    totalDurationMs: number;
    cacheHit: boolean;
    timedOut: boolean;
    layers: LayerTrace[];
}

export interface OrchestrationTraceEvent {
    type: 'orchestration_trace';
    queryId: string;
    trace: OrchestrationTrace;
}

// Re-export for convenience in other modules
export type { CancellationToken } from '../../../../../base/common/cancellation.js';
