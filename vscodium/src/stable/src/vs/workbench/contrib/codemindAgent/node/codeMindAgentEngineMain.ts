/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, existsSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from '../../../../base/common/path.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { isUtilityProcess } from '../../../../base/parts/sandbox/node/electronTypes.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Server as ChildProcessServer } from '../../../../base/parts/ipc/node/ipc.cp.js';
import { Server as UtilityProcessServer } from '../../../../base/parts/ipc/node/ipc.mp.js';
import {
	CodeMindPermissionDecision,
	ICodeMindAccountInfo,
	ICodeMindCheckpoint,
	ICodeMindDoctorCheck,
	ICodeMindEndpointCheck,
	ICodeMindEngineEvent,
	ICodeMindEngineRequest,
	ICodeMindEngineResponse,
	ICodeMindEngineSettings,
	ICodeMindEngineCommandInfo,
	ICodeMindEngineCommandResult,
	ICodeMindEngineUsage,
	ICodeMindExecRequest,
	ICodeMindExecResult,
	ICodeMindHeapSnapshotResult,
	ICodeMindMcpServer,
	ICodeMindModelInfo,
	ICodeMindPermissionAnswer,
	ICodeMindPermissionScope,
	ICodeMindRewindResult,
	ICodeMindSessionUsage,
	ICodeMindShellRequest,
} from '../common/codeMindAgentEngineService.js';

// Phase 2 Orchestration Engine
import { orchestrate } from './codeMindOrchestrationEngine.js';
import { ToolAdapterRegistry } from './orchestration/types.js';
import { projectBrainAdapter } from './orchestration/toolAdapters/projectBrainAdapter.js';
import { repositoryAdapter } from './orchestration/toolAdapters/repositoryAdapter.js';
import { fileContextAdapter } from './orchestration/toolAdapters/fileContextAdapter.js';
import { dependencyAdapter } from './orchestration/toolAdapters/dependencyAdapter.js';
import { gitAdapter } from './orchestration/toolAdapters/gitAdapter.js';
import { webSearchAdapter } from './orchestration/toolAdapters/webSearchAdapter.js';
import { terminalAdapter } from './orchestration/toolAdapters/terminalAdapter.js';

/**
 * Node-side worker that owns the Claude Agent SDK engine and exposes a
 * streaming query API over IPC to the renderer.
 *
 * The engine is driven in-process via `@anthropic-ai/claude-agent-sdk`
 * (resolved from the sibling `claude-code/` directory's node_modules, so no
 * dependency is added to the VS Code tree). The SDK is Node-compatible and
 * fully self-contained — no Bun child process is spawned.
 */

// --- minimal SDK type shapes (mirrors the SDK's public types; defined inline
// so the worker type-checks without resolving the SDK package at compile time)

type SdkPermissionResult =
	| { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; decisionClassification?: string }
	| { behavior: 'deny'; message?: string; interrupt?: boolean; decisionClassification?: string };

/** One `ToolName(ruleContent)` rule, as the engine's PermissionUpdate carries it. */
type SdkPermissionRule = { toolName: string; ruleContent?: string };

/**
 * A permission change the engine can apply and (for non-`session` destinations)
 * write to a settings file. Mirrors the SDK's `PermissionUpdate` union — the
 * worker both reads these out of `ctx.suggestions` and sends them back as
 * `updatedPermissions` when the user accepts a scope.
 */
type SdkPermissionUpdate =
	| { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: SdkPermissionRule[]; behavior: 'allow' | 'deny' | 'ask'; destination: SdkPermissionDestination }
	| { type: 'setMode'; mode: string; destination: SdkPermissionDestination }
	| { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: SdkPermissionDestination };

type SdkPermissionDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';

type SdkMessage =
	| { type: 'system'; subtype: 'init' | 'status' | 'compact_boundary' | 'hook_response' | 'local_command_output'; model?: string; session_id?: string; tools?: string[]; status?: string; content?: string; mcp_servers?: Array<{ name: string; status?: string; tools?: string[] }>; compact_metadata?: { trigger?: string; pre_tokens?: number } }
	| { type: 'assistant'; message: { role: 'assistant'; content: SdkBlock[] }; session_id?: string; uuid?: string; error?: unknown; parent_tool_use_id?: string | null }
	| { type: 'user'; message?: { role: 'user'; content: SdkBlock[] }; tool_use_result?: unknown; isSynthetic?: boolean; uuid?: string; parent_tool_use_id?: string | null }
	| { type: 'result'; subtype: 'success' | string; is_error: boolean; total_cost_usd?: number; cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }; duration_ms?: number; duration_api_ms?: number; session_id?: string; result?: string; num_turns?: number }
	| { type: 'stream_event'; event: { type: string; [key: string]: unknown } }
	| { type: 'tool_progress'; tool_use_id: string; tool_name: string; elapsed_time_seconds: number; parent_tool_use_id?: string | null }
	| { type: 'auth_status'; [key: string]: unknown }
	| { type: 'compact_boundary'; [key: string]: unknown }
	| { type: 'hook_response'; [key: string]: unknown };

type SdkBlock =
	| { type: 'text'; text: string }
	| { type: 'thinking'; thinking?: string; text?: string }
	| { type: 'tool_use'; id: string; name: string; input?: unknown }
	| { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

interface SdkOptions {
	cwd?: string;
	model?: string;
	/** Model the engine retries with when the primary one is overloaded. */
	fallbackModel?: string;
	tools?: { type: 'preset'; preset: string } | unknown;
	permissionMode?: string;
	allowedTools?: string[];
	canUseTool?: (toolName: string, input: unknown, ctx: { signal: AbortSignal; suggestions?: unknown; blockedPath?: string; decisionReason?: string; toolUseID?: string; agentID?: string }) => Promise<SdkPermissionResult>;
	env?: Record<string, string>;
	abortController?: AbortController;
	/**
	 * A bare string *replaces* the Claude Code system prompt; the preset form keeps
	 * it and appends to it. We always use the preset form so the agent keeps its
	 * own tool-use instructions.
	 */
	systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
	maxTurns?: number;
	mcpServers?: unknown;
	hooks?: unknown;
	resume?: string;
	/**
	 * With `resume`, start a new session id that inherits the resumed history
	 * instead of appending to it — the original session is left untouched.
	 */
	forkSession?: boolean;
	includePartialMessages?: boolean;
	persistSession?: boolean;
	/** @deprecated the SDK reads `thinking` first; kept for older engine builds. */
	maxThinkingTokens?: number;
	/** Extended-thinking control. `adaptive` lets the model decide when to think. */
	thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
	/** Reasoning effort for the turn. Models that don't support a level downgrade it silently. */
	effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	sandbox?: unknown;
	/** Inline settings layer, equivalent to the CLI's `--settings`. Carries fast mode. */
	settings?: Record<string, unknown>;
	/**
	 * Which filesystem settings files load. `[]` is isolation mode (no CLAUDE.md,
	 * no project hooks, no project skills); `project` is what turns CLAUDE.md on.
	 */
	settingSources?: string[];
	/** Passed through to the Claude Code CLI as `--<key> <value>`; `null` means a bare flag. */
	extraArgs?: Record<string, string | null>;
	/**
	 * Back every file the agent edits with a checkpoint, so a turn can be undone
	 * with `rewindFiles`. Without it `/rewind` has nothing to restore.
	 */
	enableFileCheckpointing?: boolean;
}

/** Account the engine is authenticated as (`accountInfo` control request). */
type SdkAccountInfo = {
	email?: string;
	organization?: string;
	subscriptionType?: string;
	tokenSource?: string;
	apiKeySource?: string;
};

/** One model the engine offers (`supportedModels` control request). */
type SdkModelInfo = { value: string; displayName: string; description: string };

/** Live MCP connection state (`mcpServerStatus` control request). */
type SdkMcpServerStatus = {
	name: string;
	status: 'connected' | 'failed' | 'needs-auth' | 'pending';
	serverInfo?: { name: string; version: string };
};

/** Outcome of a `rewindFiles` control request. */
type SdkRewindResult = {
	canRewind: boolean;
	error?: string;
	filesChanged?: string[];
	insertions?: number;
	deletions?: number;
};

/**
 * What `query()` hands back: the message stream plus the SDK's control requests.
 *
 * The control methods only exist in streaming-input mode, which is why every
 * turn sends its prompt as an AsyncIterable. They are declared optional so an
 * older engine build that lacks one degrades instead of throwing.
 */
type SdkQueryHandle = AsyncIterable<SdkMessage> & {
	interrupt?(): Promise<void>;
	setPermissionMode?(mode: string): Promise<void>;
	setModel?(model?: string): Promise<void>;
	setMaxThinkingTokens?(tokens: number | null): Promise<void>;
	supportedCommands?(): Promise<Array<{ name: string; description: string; argumentHint: string }>>;
	supportedModels?(): Promise<SdkModelInfo[]>;
	mcpServerStatus?(): Promise<SdkMcpServerStatus[]>;
	accountInfo?(): Promise<SdkAccountInfo>;
	rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<SdkRewindResult>;
};

type SdkQueryFn = (params: { prompt: string | AsyncIterable<SdkUserInput>; options?: SdkOptions }) => SdkQueryHandle;

/** A user turn pushed into the SDK in streaming-input mode (needed for images). */
type SdkUserInput = {
	type: 'user';
	message: { role: 'user'; content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> };
	parent_tool_use_id: null;
	session_id: string;
	/** Kept by the engine as the turn's id; what `rewindFiles` is keyed by. */
	uuid?: string;
};

// --- worker

type PendingQuery = {
	queryId: string;
	resolve: (response: ICodeMindEngineResponse) => void;
	reject: (reason: Error) => void;
};

/**
 * What one in-flight turn accumulates as its stream arrives. Keyed by queryId and
 * never shared: queries do overlap in practice — a companion reaction or a `/btw`
 * side question runs alongside the visible turn, and a queued prompt can start
 * before the previous turn's stream has closed. A single slot here would mean the
 * newest query owns it and the others' messages are dropped, including the
 * `result` that resolves their promise, leaving the panel busy forever.
 */
type QueryState = {
	queryId: string;
	projectKey: string;
	text: string;
	thinking: string;
	tools: Map<string, { name: string; inputJson: string }>;
	/** Text a sub-agent has produced, keyed by the Task tool id that owns it. */
	agentText: Map<string, string>;
	model?: string;
	sessionId?: string;
	sawDelta: boolean;
	/**
	 * The largest single API call's context in this turn — input + both cache
	 * figures from a `message_start`. The result message's `usage` is the turn's
	 * *sum* over every call it made, so a 20-call turn reports megabytes of input
	 * and would read as a full context window even on a short conversation. This
	 * is the number the context meter needs.
	 */
	contextTokens?: number;
	/** `/btw` turns must not adopt or overwrite the workspace session. */
	isolated?: boolean;
	/**
	 * Set once this turn has been recognised as an endpoint/credential failure
	 * dressed up as prose — see `apiErrorVerdict`. It keeps the turn's `result`
	 * flagged as an error too, so the panel does not file the failure away as an
	 * ordinary answer once the stream closes.
	 */
	isApiError?: boolean;
};

type PendingPermission = {
	resolve: (result: SdkPermissionResult) => void;
	reject: (reason: Error) => void;
	/** Which tool asked, so `allow_session` knows what it is whitelisting. */
	toolName: string;
	/** Echoed back as `updatedInput`: older engine builds require the field. */
	input: Record<string, unknown>;
	/** Scope id -> the updates accepting it grants. */
	scopeUpdates: Map<string, readonly SdkPermissionUpdate[]>;
	/** Set when a sub-agent asked, which changes the denial wording. */
	isSubagent: boolean;
};

/**
 * What the engine has reported for one project's session. The usage block is
 * summed from the `result` message of every finished turn — the only place the
 * engine reports real token counts.
 */
type SessionState = {
	sessionId?: string;
	totalCostUsd?: number;
	usage?: {
		turns: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		totalDurationMs: number;
		lastRequestTokens?: number;
		lastModel?: string;
	};
};

/** Default model for new sessions until the user picks another. */
const DEFAULT_MODEL = 'claude-opus-5';

/**
 * What the engine puts in an assistant message that arrived carrying nothing — a gateway
 * that answers a tool call with an empty text block alongside it produces one. It is the
 * engine's own placeholder rather than something the model said, so it is stripped before
 * the text reaches the panel.
 */
const SDK_EMPTY_CONTENT_PLACEHOLDER = '(no content)';

/** Where turns go when neither the settings nor the environment name an endpoint. */
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** Messages API version sent with every direct (non-SDK) endpoint call. */
const ANTHROPIC_API_VERSION = '2023-06-01';


/**
 * The CLI's `validateBoundedIntEnvVar` (`utils/envValidation.ts`): an unset variable
 * is valid and means "use the default", anything unparseable falls back to the
 * default, and a value over the ceiling is silently clamped. Reported by `/doctor`
 * only when the answer is not `valid`, which is how the CLI does it too.
 */
function validateBoundedIntEnvVar(
	raw: string | undefined,
	defaultValue: number,
	upperLimit: number,
): { status: 'valid' | 'invalid' | 'capped'; effective: number; message: string } {
	if (raw === undefined || raw === '') {
		return { status: 'valid', effective: defaultValue, message: '' };
	}
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) {
		return { status: 'invalid', effective: defaultValue, message: `Invalid value "${raw}" (using default: ${defaultValue})` };
	}
	if (parsed > upperLimit) {
		return { status: 'capped', effective: upperLimit, message: `Capped from ${parsed} to ${upperLimit}` };
	}
	return { status: 'valid', effective: parsed, message: '' };
}

/** Fallbacks from the CLI's `getModelMaxOutputTokens` for a model it has no row for. */
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000;
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000;

/**
 * The `CLAUDE_CODE_MAX_OUTPUT_TOKENS` bounds for a model, ported from the CLI's
 * `getModelMaxOutputTokens` (`utils/context.ts`). The CLI's table stops at the 4-6
 * models, so the 5 family is added here on the same footing (opus-5 matching
 * opus-4-6, sonnet-5 matching sonnet-4-6), and the aliases the panel accepts in
 * `codemind.model` are resolved first — otherwise `opus` would fall through to the
 * generic 32k/64k pair and the check would report a cap that is not real.
 */
function maxOutputTokensFor(model: string): { default: number; upperLimit: number } {
	const id = model.trim().toLowerCase();
	const alias: Record<string, string> = {
		'': DEFAULT_MODEL, 'default': DEFAULT_MODEL,
		'opus': 'claude-opus-5', 'opusplan': 'claude-opus-5', 'best': 'claude-opus-5',
		'opus[1m]': 'claude-opus-5', 'sonnet': 'claude-sonnet-5', 'sonnet[1m]': 'claude-sonnet-5',
		'haiku': 'claude-haiku-4-5', 'fable': 'claude-fable-5',
	};
	const resolved = alias[id] ?? id;
	// Ordered longest-prefix-first: `claude-3-5-sonnet` must not be answered by the
	// `claude-3-sonnet` row, and `opus-4-6` must not be answered by `opus-4`.
	const table: Array<[string, number, number]> = [
		['claude-opus-5', 64_000, 128_000],
		['claude-fable-5', 64_000, 128_000],
		['claude-sonnet-5', 32_000, 128_000],
		['claude-opus-4-6', 64_000, 128_000],
		['claude-sonnet-4-6', 32_000, 128_000],
		['claude-opus-4-5', 32_000, 64_000],
		['claude-sonnet-4', 32_000, 64_000],
		['claude-haiku-4', 32_000, 64_000],
		['claude-opus-4', 32_000, 32_000],
		['claude-3-7-sonnet', 32_000, 64_000],
		['claude-3-5-sonnet', 8_192, 8_192],
		['claude-3-5-haiku', 8_192, 8_192],
		['claude-3-opus', 4_096, 4_096],
		['claude-3-haiku', 4_096, 4_096],
		['claude-3-sonnet', 8_192, 8_192],
	];
	for (const [prefix, value, limit] of table) {
		if (resolved.startsWith(prefix)) {
			return { default: value, upperLimit: limit };
		}
	}
	return { default: MAX_OUTPUT_TOKENS_DEFAULT, upperLimit: MAX_OUTPUT_TOKENS_UPPER_LIMIT };
}

/** Tools that mutate the workspace — blocked while plan mode is on. */
const MUTATING_TOOLS = new Set([
	'Bash', 'BashTool', 'PowerShell', 'Write', 'FileWriteTool', 'Edit', 'FileEditTool',
	'MultiEdit', 'NotebookEdit', 'NotebookEditTool', 'KillShell', 'BashOutput',
	// These run commands or touch the working tree just as directly as Bash does.
	'Monitor', 'EnterWorktree', 'ExitWorktree',
]);

/** Tools whose input is a shell command line, so a rule can name that command. */
const SHELL_TOOLS = new Set(['Bash', 'BashTool', 'PowerShell']);

/**
 * Tools that never need a dialog because the call *is* the user's turn to speak.
 * Asking "allow AskUserQuestion?" before the question is even legible is a dialog
 * about a dialog — the CLI shows the question straight away, and so does the panel
 * (the option buttons in the tool card).
 */
const NO_PROMPT_TOOLS = new Set(['AskUserQuestion']);

/**
 * How permissive each mode is, so a session upgrade never narrows what the
 * settings already allow. `plan` is deliberately at the bottom: it is a
 * restriction, not a loosening.
 */
const PERMISSION_MODE_RANK: Record<string, number> = {
	plan: 0,
	default: 1,
	acceptEdits: 2,
	bypassPermissions: 3,
};

/**
 * What the model is told when the user declines. Word-for-word the engine's own
 * rejection text, so a denial reads the same whether it came from the CLI or
 * from the panel — the model is tuned on this wording.
 */
const REJECT_MESSAGE = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
const REJECT_MESSAGE_WITH_REASON_PREFIX = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";
const SUBAGENT_REJECT_MESSAGE = 'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.';
const SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX = 'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\n';

/** Narrow an unknown tool input to the record shape the engine's schema wants. */
function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Validate the engine's `permission_suggestions` before acting on them. They
 * arrive as `unknown` across the SDK boundary and are handed straight back as
 * `updatedPermissions`, so anything unrecognised is dropped rather than echoed.
 */
function asPermissionUpdates(value: unknown): SdkPermissionUpdate[] {
	if (!Array.isArray(value)) { return []; }
	const out: SdkPermissionUpdate[] = [];
	for (const entry of value) {
		const u = asRecord(entry);
		const destination = typeof u.destination === 'string' ? u.destination : undefined;
		if (!destination || !PERMISSION_DESTINATIONS.has(destination)) { continue; }
		const dest = destination as SdkPermissionDestination;
		if ((u.type === 'addRules' || u.type === 'replaceRules' || u.type === 'removeRules') && Array.isArray(u.rules)) {
			const behavior = u.behavior === 'allow' || u.behavior === 'deny' || u.behavior === 'ask' ? u.behavior : undefined;
			if (!behavior) { continue; }
			const rules = u.rules
				.map(r => asRecord(r))
				.filter(r => typeof r.toolName === 'string' && r.toolName)
				.map(r => ({ toolName: r.toolName as string, ruleContent: typeof r.ruleContent === 'string' ? r.ruleContent : undefined }));
			if (rules.length > 0) { out.push({ type: u.type, rules, behavior, destination: dest }); }
		} else if (u.type === 'setMode' && typeof u.mode === 'string') {
			out.push({ type: 'setMode', mode: u.mode, destination: dest });
		} else if ((u.type === 'addDirectories' || u.type === 'removeDirectories') && Array.isArray(u.directories)) {
			const directories = u.directories.filter((d): d is string => typeof d === 'string' && !!d);
			if (directories.length > 0) { out.push({ type: u.type, directories, destination: dest }); }
		}
	}
	return out;
}

const PERMISSION_DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']);

/** Where a bundle of updates is remembered, for the caption on its button. */
function storeForUpdates(updates: readonly SdkPermissionUpdate[]): 'session' | 'localSettings' | 'projectSettings' | 'userSettings' {
	for (const u of updates) {
		if (u.destination === 'localSettings' || u.destination === 'projectSettings' || u.destination === 'userSettings') {
			return u.destination;
		}
	}
	return 'session';
}

/** The permission mode a bundle of updates switches to, if it switches one. */
function modeFromUpdates(updates: readonly SdkPermissionUpdate[]): string | undefined {
	for (const u of updates) {
		if (u.type === 'setMode') { return u.mode; }
	}
	return undefined;
}

/**
 * Render a rule the way settings files spell it — `Bash(git status:*)` — with
 * parentheses escaped so a command containing them still parses back.
 */
function ruleToSettingString(rule: SdkPermissionRule): string {
	if (!rule.ruleContent) { return rule.toolName; }
	const escaped = rule.ruleContent
		.replace(/\\/g, '\\\\')
		.replace(/\(/g, '\\(')
		.replace(/\)/g, '\\)');
	return `${rule.toolName}(${escaped})`;
}

/** Last path segment, without depending on the host's separator. */
function basenameOf(p: string): string {
	const trimmed = p.replace(/[\\/]+$/, '');
	const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}

/** Keep a button label to one line. */
function ellipsis(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** First of `keys` present in `record` as a non-empty string. */
function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value) { return value; }
	}
	return undefined;
}

/**
 * CSI escape sequences, as printed by the tools a local slash command shells out
 * to. Composed from a char code rather than written as a literal so the source
 * carries no control character.
 */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/**
 * Strip the wrapper the engine puts around output a local slash command printed,
 * leaving plain text. Both message shapes that carry such output use these tags.
 */
function unwrapLocalCommandOutput(content: string): string {
	return content
		.replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, '$1')
		.replace(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/g, '$1')
		.replace(ANSI_ESCAPE, '')
		.trim();
}

/**
 * How the engine reports that it could not reach the model at all: a bad key, a
 * refused request, a dead endpoint. It does not fail the stream — it sends back an
 * ordinary assistant turn whose text is the API's own message, and a `result` whose
 * subtype is success, and only exits non-zero afterwards. So the one thing that
 * distinguishes the failure from an answer is this prefix on the turn's text.
 */
const API_ERROR_PREFIX = 'API Error:';

/**
 * Whether a turn's text so far is one of those failures.
 *
 * This is asked on every delta, so it has to have an answer for a partial string:
 * `'maybe'` means what has arrived is still a prefix of the marker and could go
 * either way, and the caller holds the emit back until the next delta decides.
 * Waiting costs at most the ten characters of `API Error:` — worth it, because the
 * alternative is emitting the head of the failure as an answer and then
 * contradicting it.
 */
function apiErrorVerdict(text: string): 'yes' | 'maybe' | 'no' {
	const head = text.trimStart();
	if (head.startsWith(API_ERROR_PREFIX)) { return 'yes'; }
	if (head.length < API_ERROR_PREFIX.length && API_ERROR_PREFIX.startsWith(head)) { return 'maybe'; }
	return 'no';
}

/**
 * Read an environment variable the way the engine reads its own switches: set to
 * `1` or `true` means on, anything else (including unset) means off.
 */
function isEnvTruthy(value: string | undefined): boolean {
	const normalized = (value ?? '').trim().toLowerCase();
	return normalized === '1' || normalized === 'true';
}

/**
 * A Windows-only instruction about the form of `file_path`.
 *
 * The root cause is fixed in the bundle itself by
 * `claude-code/patches/read-file-state-path-normalization.mjs`: the tools' read-state
 * bookkeeping used to be separator-sensitive, with Read recording a file under the
 * absolute path exactly as the model wrote it while Write and Edit looked that record
 * up under a *normalized* native path, so on Windows `/tmp/x` was recorded as itself
 * and then looked up as `D:\tmp\x` and the write was refused ("File has not been read
 * yet", or, for Edit, "File has been unexpectedly modified"). The patch routes both
 * sides through the same normalizer.
 *
 * The rule stays for two reasons. `claude-code/node_modules` is not tracked, so a
 * `bun install` that is not followed by the patch script brings the mismatch back, and
 * this keeps the model on the one path form that works either way. And a native path
 * is simply the unambiguous form on this platform: the MSYS-style `/d/src/app.ts`
 * reads as a rooted POSIX path, which is a different file. Returns `undefined` off
 * Windows, where there is nothing to say.
 */
function windowsFilePathRule(cwd: string | undefined): string | undefined {
	if (process.platform !== 'win32') { return undefined; }
	// Which drive a rooted POSIX path lands on is decided by the working
	// directory, so the example is written with the drive actually in use.
	const drive = (/^([a-zA-Z]):/.exec(cwd || process.cwd())?.[1] ?? 'C').toUpperCase();
	return [
		'File paths on this machine (Windows): give the file tools — Read, Write, Edit, MultiEdit, NotebookEdit — a native absolute Windows path with backslash separators, and rewrite any POSIX-style path into that form first.',
		`\`/tmp/notes.txt\` is \`${drive}:\\tmp\\notes.txt\`; \`${drive}:/src/app.ts\` is \`${drive}:\\src\\app.ts\`; a workspace-relative path is the workspace root joined with backslashes.`,
		'Spell a file the same way across a Read and the Write or Edit that follows it. This applies to the tools\' `file_path` argument only: Bash command lines, Grep and Glob patterns keep whatever form suits them.',
	].join(' ');
}

class CodeMindAgentEngineMainService extends Disposable {

	/**
	 * Ceiling for the key-check round trip, so an unresponsive base URL still answers the
	 * dialog. Generous on purpose: a proxied endpoint can take well over ten seconds for a
	 * one-token completion, and a timeout there reads as "could not reach" for a key and URL
	 * that are in fact fine.
	 */
	private static readonly VALIDATE_TIMEOUT_MS = 45_000;

	/**
	 * How long an acknowledged interrupt is given to write its own end of the transcript
	 * before the stream is aborted. Long enough for the engine to flush the turn, short
	 * enough that a wedged process is not left running.
	 */
	private static readonly INTERRUPT_FLUSH_GRACE_MS = 3_000;

	private readonly _engineRoot: string | undefined;
	private _sdkQuery: SdkQueryFn | undefined;
	private _sdkLoadError: string | undefined;

	private readonly _pending = new Map<string, PendingQuery>();
	private readonly _pendingPermissions = new Map<string, PendingPermission>();
	/** In-memory session state keyed by the workspace cwd (project identity). */
	private readonly _sessions = new Map<string, SessionState>();
	/** Tool names the user approved for the rest of this session. */
	private readonly _sessionAllowedTools = new Set<string>();
	/**
	 * Rules the user granted "for this session", as `ToolName(ruleContent)`
	 * strings. Every turn is a fresh engine process, so a `session` grant the
	 * engine applied dies with the turn that made it — these are replayed
	 * through the inline settings layer instead.
	 */
	private readonly _sessionAllowRules = new Set<string>();
	/** Directories granted for this session, replayed the same way. */
	private readonly _sessionDirectories = new Set<string>();
	/** Permission mode the user upgraded to for this session, if any. */
	private _sessionPermissionMode: string | undefined;
	/** Settings applied from the settings panel. */
	private _settings: ICodeMindEngineSettings = {};
	/** MCP servers configured from the MCP panel. */
	private _mcpServers: readonly ICodeMindMcpServer[] = [];
	/** Session id the next query should resume, when forced by /resume. */
	private _forcedResumeSessionId: string | undefined;
	/** Set by /branch: the next query forks the session it resumes. */
	private _forkNextTurn = false;
	/** Abort controllers for in-flight queries, so cancellation reaches the SDK. */
	private readonly _aborts = new Map<string, AbortController>();
	/** MCP status learned from the last engine init message, keyed by server name. */
	private readonly _mcpStatus = new Map<string, { status: ICodeMindMcpServer['status']; tools?: readonly string[] }>();
	/** Tool names the engine reported on its last init message. */
	private _lastTools: readonly string[] | undefined;
	/** Live query handles, so control requests can reach an in-flight turn. */
	private readonly _handles = new Map<string, SdkQueryHandle>();
	/** Account the engine authenticated as, learned from an init handshake. */
	private _accountInfo: SdkAccountInfo | undefined;
	/** Models the engine offers, learned from an init handshake. */
	private _supportedModels: readonly SdkModelInfo[] | undefined;
	/** Slash commands the engine offers, learned from a control request. */
	private _engineCommands: readonly ICodeMindEngineCommandInfo[] | undefined;
	/** cwd of the most recent turn, used when a control request has no better one. */
	private _lastCwd: string | undefined;
	/** Rewind points (user messages) per project key, oldest first. */
	private readonly _checkpoints = new Map<string, ICodeMindCheckpoint[]>();

	/**
	 * Stream state for every in-flight query, keyed by queryId. Insertion-ordered,
	 * so the most recently started turn is the last entry — that is what a control
	 * request means by "the turn currently running".
	 */
	private readonly _states = new Map<string, QueryState>();

	private readonly _onEvent = new Emitter<{ queryId: string; event: ICodeMindEngineEvent }>();
	readonly onEvent: Event<{ queryId: string; event: ICodeMindEngineEvent }> = this._onEvent.event;

	constructor() {
		super();
		this._engineRoot = this._detectEngineRoot();

		// Phase 2: Initialize ToolAdapterRegistry (singleton per worker process)
		this._toolAdapterRegistry = new Map();
		this._registerAdapter(projectBrainAdapter);
		this._registerAdapter(repositoryAdapter);
		this._registerAdapter(fileContextAdapter);
		this._registerAdapter(dependencyAdapter);
		this._registerAdapter(gitAdapter);
		this._registerAdapter(webSearchAdapter);
		this._registerAdapter(terminalAdapter);

		// Phase 2 tracking fields (Section 10)
		this._workspaceFolder = process.cwd();
		this._sessionTurnCount = 0;

		// A.8 – Lazy Headroom pre-warm at worker startup
		import('./orchestration/headroomLayer.js')
			.then(m => m.prewarmHeadroom())
			.catch(() => {});
	}

	// B.3 – Dev mode + trace history IPC methods
	setDevMode(enabled: boolean): void {
		import('./codeMindOrchestrationEngine.js').then(m => m.setDevMode(enabled)).catch(() => {});
	}

	async getOrchestrationPerf() {
		const mod = await import('./codeMindOrchestrationEngine.js');
		return mod.getOrchestrationPerf();
	}

	async getTraceHistory() {
		const mod = await import('./codeMindOrchestrationEngine.js');
		return mod.getTraceBuffer();
	}

	private _toolAdapterRegistry: ToolAdapterRegistry;
	private _workspaceFolder: string;
	private _sessionTurnCount: number;

	private _registerAdapter(adapter: any) {
		this._toolAdapterRegistry.set(adapter.id, adapter);
	}

	// Phase 2 — build last 3 turns for orchestration context (Section 10.3)
	private _buildSessionHistory(): import('./orchestration/types.js').TurnSummary[] {
		// If the engine already tracks conversation history in a field (e.g. this._conversationHistory),
		// map the last 3 entries here. For now we return an empty array as a safe stub.
		// Real implementation: read from whatever history structure the engine maintains.
		return [];
	}

	// ========================================================================
	// Phase 2 Orchestration Integration (Part 1)
	// ========================================================================

	// A.2 — Parallel SDK warm-up (currently a no-op; SDK has no public pre-warm API)
	private async _prewarmSdk(_cancelToken: any): Promise<void> {
		return Promise.resolve();
	}

	/**
	 * Runs the Phase 2 orchestration pipeline and returns a copy of `request` whose prompt has
	 * been enriched with pre-fetched context. Never throws and never streams anything itself —
	 * on any failure it returns the original request so the SDK call proceeds unenriched.
	 */
	private async _prepareOrchestratedRequest(
		queryId: string,
		request: ICodeMindEngineRequest
	): Promise<ICodeMindEngineRequest> {
		// 1.2 — Immediate visual feedback (synchronous, before any await)
		this._onEvent.fire({
			queryId,
			event: {
				type: 'orchestration_progress',
				queryId,
				phase: 'intent_detection',
				status: 'running',
			} as any,
		});

		// Track workspace folder on first call
		if (!this._workspaceFolder || this._workspaceFolder === process.cwd()) {
			this._workspaceFolder = request.cwd ?? process.cwd();
		}

		const cancelToken = new (await import('../../../../base/common/cancellation.js')).CancellationTokenSource().token;

		const orchestrationReq = {
			queryId,
			userPrompt: request.prompt,
			openFiles: (request.attachments ?? [])
				.map((f: any) => (typeof f === 'string' ? f : f.path ?? ''))
				.filter(Boolean),
			workspaceFolder: this._workspaceFolder,
			sessionHistory: this._buildSessionHistory(),
			isFollowUp: this._sessionTurnCount > 0,
			// Single source of truth: the model the SDK query actually uses (:914).
			// (Was `this._currentModel`, a constructor constant `setModel` never updated,
			// so the trace's layer-7 model always read 'claude-opus-5' regardless of the
			// composer selection — a cosmetic lie the user flagged in the trace panel.)
			model: this._settings.model ?? DEFAULT_MODEL,
			token: cancelToken,
		};

		try {
			// A.2 — Run orchestration and SDK pre-warm in parallel
			const [orchestrated] = await Promise.all([
				Promise.race([
					orchestrate(orchestrationReq, this._toolAdapterRegistry, (ev) =>
						this._onEvent.fire({ queryId, event: ev })
					),
					// 2.3 — Hard 4000 ms timeout with graceful degradation
					new Promise<any>((resolve) =>
						setTimeout(() => {
							this._onEvent.fire({
								queryId,
								event: {
									type: 'orchestration_progress',
									queryId,
									phase: 'timeout',
									status: 'failed',
									message: 'Context preparation timed out — proceeding with original prompt',
								} as any,
							});
							resolve({
								enrichedPrompt: request.prompt,
								systemPromptSuffix: '',
								orchestrationMetadata: {
									intent: 'code_generation',
									confidence: 0,
									toolsExecuted: [],
									toolsFailed: ['timeout'],
									originalTokenEstimate: 0,
									finalTokenEstimate: 0,
									compressionMode: 'none',
									headroomAvailable: false,
									totalDurationMs: 4000,
								},
							});
						}, 4000)
					),
				]),
				this._prewarmSdk(cancelToken),
			]);

			// Completion event
			this._onEvent.fire({
				queryId,
				event: {
					type: 'orchestration_progress',
					queryId,
					phase: 'complete',
					status: 'complete',
					intent: orchestrated.orchestrationMetadata.intent,
					durationMs: orchestrated.orchestrationMetadata.totalDurationMs,
				} as any,
			});

			// Increment turn count after orchestration succeeds
			this._sessionTurnCount++;

			// Hand the enriched prompt back to queryStream, which owns the actual SDK streaming.
			// The suffix is appended to whatever the caller already supplied; _buildSystemPrompt
			// picks it up from the request (see the systemPromptSuffix branch further down).
			return {
				...request,
				prompt: orchestrated.enrichedPrompt,
				systemPromptSuffix: (request.systemPromptSuffix ?? '') + orchestrated.systemPromptSuffix,
			};
		} catch (err) {
			// Context enrichment is strictly an optimisation — never let it fail the query.
			this._onEvent.fire({
				queryId,
				event: {
					type: 'orchestration_progress',
					queryId,
					phase: 'complete',
					status: 'failed',
					message: `Context preparation failed (${err instanceof Error ? err.message : String(err)}) — proceeding with original prompt`,
				} as any,
			});
			this._sessionTurnCount++;
			return request;
		}
	}

	/** Resolves to a human-readable error string, or undefined if the engine is usable. */
	async diagnose(apiKey: string | undefined): Promise<string | undefined> {
		if (!this._engineRoot) {
			return 'The Claude Code engine was not found next to the CodeMind sources. Expected a sibling `claude-code/` directory with `package.json` and `src/entrypoints/cli.tsx` present.';
		}
		if (!apiKey) {
			return 'No Anthropic API key is set. Open the key icon in the CodeMind Agent header and paste your key to continue.';
		}
		if (this._sdkLoadError) {
			return `The Claude Agent SDK could not be loaded: ${this._sdkLoadError}`;
		}
		return undefined;
	}

	async queryStream(queryId: string, request: ICodeMindEngineRequest, apiKey: string): Promise<ICodeMindEngineResponse> {
		const problem = await this.diagnose(apiKey);
		if (problem) {
			throw new Error(problem);
		}
		await this._ensureSdkLoaded();

		// Phase 2 — enrich the prompt with pre-fetched context before streaming.
		// Degrades to the original request if orchestration fails or times out.
		request = await this._prepareOrchestratedRequest(queryId, request);

		const projectKey = request.cwd ?? this._engineRoot ?? '';
		this._lastCwd = request.cwd ?? this._lastCwd;
		const sessionState = this._sessions.get(projectKey) ?? { sessionId: undefined };
		const abortController = new AbortController();
		this._aborts.set(queryId, abortController);

		return new Promise<ICodeMindEngineResponse>((resolve, reject) => {
			this._pending.set(queryId, { queryId, resolve, reject });
			const overrides = request.turnOverrides;
			this._states.set(queryId, {
				queryId, projectKey,
				text: '', thinking: '',
				tools: new Map(),
				agentText: new Map(),
				model: undefined, sessionId: undefined,
				sawDelta: false,
				isolated: overrides?.isolated === true,
			});

			const planMode = request.planMode === true;
			const options: SdkOptions = {
				// No workspace folder is open when the request carries no cwd. Leaving it
				// unset would hand the turn this process's own working directory — the
				// Electron binary's folder — and relative paths would land inside the
				// build output. The home directory is where a shell-launched agent starts.
				cwd: request.cwd || homedir(),
				model: this._settings.model ?? DEFAULT_MODEL,
				tools: { type: 'preset', preset: 'claude_code' },
				permissionMode: planMode ? 'plan' : this._resolvePermissionMode(),
				env: this._buildEnv(apiKey),
				// Matches the `codemind.maxTurns` default, so a turn that runs before the
				// settings panel has pushed anything behaves the same as one after.
				maxTurns: overrides?.maxTurns ?? this._settings.maxTurns ?? 40,
				abortController,
				includePartialMessages: true,
				// Checkpoint the files each turn touches so /rewind can undo a turn.
				// Isolated side questions touch nothing, so they skip the bookkeeping.
				enableFileCheckpointing: overrides?.isolated !== true,
				// The panel carries the conversation across turns by resuming the
				// engine's own session, and `resume` only works against a session that
				// was written to disk — `persistSession: false` would silently start a
				// fresh conversation on every turn. Isolated side questions are the one
				// case that must not be persisted or resumable.
				persistSession: overrides?.isolated !== true,
				// An isolated turn starts clean so a side question cannot inherit — or
				// extend — the conversation the panel is showing.
				resume: overrides?.isolated
					? undefined
					: (this._forcedResumeSessionId ?? request.sessionId ?? sessionState.sessionId),
				// Keep Claude Code's own system prompt and append ours to it. Passing a
				// bare string here would replace it and cost the agent its tool-use
				// instructions and coding conventions.
				systemPrompt: { type: 'preset', preset: 'claude_code', append: this._buildSystemPrompt(request) },
				// CLAUDE.md, project hooks and project skills only load when the engine
				// is told which settings files to read.
				settingSources: [...(this._settings.settingSources ?? ['user', 'project', 'local'])],
				canUseTool: (toolName, input, ctx) => this._handleCanUseTool(queryId, toolName, input, ctx, planMode, overrides?.blockAllTools === true),
			};
			const effort = this._settings.effort;
			if (effort && effort !== 'auto') {
				options.effort = effort;
			}
			const thinking = this._resolveThinking();
			if (thinking) {
				options.thinking = thinking;
			}
			// Only forwarded when set: an empty fallback would be taken literally.
			if (this._settings.fallbackModel) {
				options.fallbackModel = this._settings.fallbackModel;
			}
			const sandbox = this._buildSandboxSettings();
			if (sandbox) {
				options.sandbox = sandbox;
			}
			const inlineSettings = this._buildInlineSettings();
			if (inlineSettings) {
				options.settings = inlineSettings;
			}
			const mcpServers = this._buildMcpServerMap();
			if (mcpServers) {
				options.mcpServers = mcpServers;
			}
			// Only consume the forced resume when this turn actually used it — an
			// isolated side question must not swallow a pending `/resume`.
			if (!overrides?.isolated) {
				this._forcedResumeSessionId = undefined;
			}
			// A fork needs something to fork from, so it only applies to a turn that
			// actually resumes. It is consumed either way: a pending fork must not sit
			// around and silently split a later conversation.
			if (this._forkNextTurn && !overrides?.isolated) {
				this._forkNextTurn = false;
				if (options.resume) {
					options.forkSession = true;
				}
			}

			// The id the engine will file this turn (and its file checkpoint) under.
			const turnUuid = generateUuid();
			if (overrides?.isolated !== true) {
				this._recordCheckpoint(projectKey, turnUuid, request.prompt);
			}

			this._runStream(queryId, this._buildPrompt(request, turnUuid), options, abortController).then(undefined, err => {
				this._pending.delete(queryId);
				this._aborts.delete(queryId);
				this._states.delete(queryId);
				reject(err);
			});
		});
	}

	/**
	 * Compose the turn sent to the SDK.
	 *
	 * Always streaming-input mode (an AsyncIterable of user messages rather than a
	 * plain string): that is what makes the engine's control channel available, so
	 * a running turn can be interrupted and asked about its account, models and MCP
	 * state. It is also the only way to send pasted images, which have no path and
	 * so travel as real `image` content blocks.
	 *
	 * `uuid` is ours on purpose — the engine keeps the id we send, and that is the
	 * id its file checkpoint (and therefore `/rewind`) is keyed by.
	 */
	private _buildPrompt(request: ICodeMindEngineRequest, uuid: string): AsyncIterable<SdkUserInput> {
		const images = (request.attachments ?? []).filter(a => a.kind === 'image' && a.dataUrl);
		const content: SdkUserInput['message']['content'] = [{ type: 'text', text: this._buildTextPrompt(request) }];
		for (const image of images) {
			const parsed = this._parseDataUrl(image.dataUrl!);
			if (parsed) {
				content.push({ type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } });
			}
		}
		const message: SdkUserInput = {
			type: 'user',
			message: { role: 'user', content },
			parent_tool_use_id: null,
			session_id: request.sessionId ?? '',
			uuid,
		};
		return (async function* () { yield message; })();
	}

	/** The textual half of a turn: the prompt plus a manifest of on-disk attachments. */
	private _buildTextPrompt(request: ICodeMindEngineRequest): string {
		const onDisk = (request.attachments ?? []).filter(a => a.path);
		const inlineNonImage = (request.attachments ?? []).filter(a => !a.path && a.kind !== 'image');
		if (onDisk.length === 0 && inlineNonImage.length === 0) {
			return request.prompt;
		}
		const lines: string[] = [request.prompt, '', '--- Attachments ---'];
		for (const att of onDisk) {
			lines.push(`- ${att.kind === 'image' ? 'Image' : 'File'}: ${att.path}`);
		}
		for (const att of inlineNonImage) {
			lines.push(`- File (inline): ${att.name}`);
			lines.push(this._decodeTextDataUrl(att.dataUrl) ?? '(unreadable attachment)');
		}
		return lines.join('\n');
	}

	/** Split `data:<mime>;base64,<payload>` into its parts. */
	private _parseDataUrl(dataUrl: string): { mediaType: string; data: string } | undefined {
		const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
		return match ? { mediaType: match[1], data: match[2] } : undefined;
	}

	/** Decode a text attachment that arrived inline as a data URL. */
	private _decodeTextDataUrl(dataUrl: string | undefined): string | undefined {
		if (!dataUrl) { return undefined; }
		const parsed = this._parseDataUrl(dataUrl);
		if (!parsed) { return undefined; }
		try {
			return Buffer.from(parsed.data, 'base64').toString('utf8');
		} catch {
			return undefined;
		}
	}

	/**
	 * Environment handed to the engine. The API key is injected here rather than
	 * written anywhere on disk, so it lives only in this process and the engine's.
	 */
	private _buildEnv(apiKey: string): Record<string, string> {
		const env: Record<string, string> = { ...process.env as Record<string, string>, ANTHROPIC_API_KEY: apiKey };
		// A configured endpoint wins over whatever the app was launched with, so the
		// settings panel is the single place that decides where turns go. The SDK reads
		// this variable itself; there is no option for it.
		const baseUrl = this._resolveBaseUrl();
		if (baseUrl) {
			env.ANTHROPIC_BASE_URL = baseUrl;
		}
		return env;
	}

	/**
	 * The endpoint to talk to: the explicit argument (what the settings form has in
	 * it right now), else the saved setting, else the launch environment, else the
	 * official API. Trailing slashes are dropped so `${base}/v1/...` never doubles up.
	 */
	private _resolveBaseUrl(override?: string): string | undefined {
		const candidates = [override, this._settings.baseUrl, process.env.ANTHROPIC_BASE_URL];
		for (const candidate of candidates) {
			const trimmed = (candidate ?? '').trim().replace(/\/+$/, '');
			if (trimmed) { return trimmed; }
		}
		return undefined;
	}

	/**
	 * Extended-thinking configuration.
	 *
	 * An explicit token budget from the settings panel wins; otherwise we send
	 * nothing and let the engine pick (adaptive thinking on models that have it).
	 * `effort` is passed separately and guides depth without pinning a budget.
	 */
	private _resolveThinking(): SdkOptions['thinking'] | undefined {
		const budget = this._settings.maxThinkingTokens;
		if (typeof budget === 'number' && budget > 0) {
			return { type: 'enabled', budgetTokens: budget };
		}
		return undefined;
	}

	/**
	 * Sandbox restrictions for the commands the agent runs. Returns undefined when
	 * the sandbox is off, so the option is absent rather than explicitly disabled.
	 */
	private _buildSandboxSettings(): Record<string, unknown> | undefined {
		const sandbox = this._settings.sandbox;
		if (!sandbox || sandbox.enabled !== true) {
			return undefined;
		}
		const settings: Record<string, unknown> = { enabled: true };
		if (sandbox.autoAllowBashIfSandboxed !== undefined) {
			settings.autoAllowBashIfSandboxed = sandbox.autoAllowBashIfSandboxed;
		}
		if (sandbox.allowUnsandboxedCommands !== undefined) {
			settings.allowUnsandboxedCommands = sandbox.allowUnsandboxedCommands;
		}
		if (sandbox.excludedCommands && sandbox.excludedCommands.length > 0) {
			settings.excludedCommands = [...sandbox.excludedCommands];
		}
		return settings;
	}

	/**
	 * The permission mode this turn runs in. A "yes, allow all edits during this
	 * session" answer upgrades the mode for the rest of the conversation, exactly
	 * as it does in the CLI — but because each turn is a new engine process, the
	 * upgrade has to be re-stated here rather than living in the engine.
	 *
	 * It only ever loosens: a configured `bypassPermissions` is not pulled back to
	 * `acceptEdits` by a dialog answer.
	 */
	private _resolvePermissionMode(): string {
		const configured = this._settings.permissionMode ?? 'default';
		if (!this._sessionPermissionMode || configured === 'bypassPermissions') {
			return configured;
		}
		return (PERMISSION_MODE_RANK[this._sessionPermissionMode] ?? 0) > (PERMISSION_MODE_RANK[configured] ?? 0)
			? this._sessionPermissionMode
			: configured;
	}

	/**
	 * Inline settings layer (the CLI's `--settings`). Only carries keys the panel
	 * owns; returns undefined when there is nothing to say so the engine's own
	 * settings files are left completely alone.
	 */	private _buildInlineSettings(): Record<string, unknown> | undefined {
		const settings: Record<string, unknown> = {};
		if (this._settings.fastMode === true) {
			// Models without a fast tier ignore this rather than failing the turn.
			settings.fastMode = true;
		}
		const advisor = this._settings.advisorModel?.trim();
		if (advisor) {
			// A second model the agent may consult on hard turns; '' means no advisor.
			settings.advisorModel = advisor;
		}
		// Grants the user made "for this session". The engine applied them to the
		// process that asked, which has since exited, so they ride in here instead.
		// This layer (`flagSettings`) is always read, whatever `settingSources` says.
		const permissions: Record<string, unknown> = {};
		if (this._sessionAllowRules.size > 0) {
			permissions.allow = [...this._sessionAllowRules];
		}
		if (this._sessionDirectories.size > 0) {
			permissions.additionalDirectories = [...this._sessionDirectories];
		}
		if (Object.keys(permissions).length > 0) {
			settings.permissions = permissions;
		}
		return Object.keys(settings).length > 0 ? settings : undefined;
	}

	/** Translate the MCP panel's server list into the SDK's mcpServers map. */
	private _buildMcpServerMap(): Record<string, unknown> | undefined {
		const enabled = this._mcpServers.filter(s => s.enabled !== false && s.name);
		if (enabled.length === 0) {
			return undefined;
		}
		const map: Record<string, unknown> = {};
		for (const server of enabled) {
			if (server.url) {
				map[server.name] = { type: server.type === 'sse' ? 'sse' : 'http', url: server.url };
			} else if (server.command) {
				map[server.name] = { type: 'stdio', command: server.command, args: server.args ? [...server.args] : [], env: server.env ?? {} };
			}
		}
		return Object.keys(map).length > 0 ? map : undefined;
	}

	private async _runStream(queryId: string, prompt: string | AsyncIterable<SdkUserInput>, options: SdkOptions, abortController: AbortController): Promise<void> {
		this._trace('stream.start', {
			queryId,
			cwd: options.cwd,
			// Named fields rather than the whole options bag: `env` holds the API key, and
			// `abortController`/`canUseTool` do not survive JSON anyway.
			model: options.model,
			permissionMode: options.permissionMode,
			maxTurns: options.maxTurns,
			resume: options.resume,
			persistSession: options.persistSession,
			settingSources: options.settingSources as unknown,
			effort: options.effort as unknown,
			thinking: options.thinking as unknown,
			mcpServers: options.mcpServers ? Object.keys(options.mcpServers as object) : undefined,
			// T-142 reads this: the companion introduction has to reach the model.
			systemPromptAppend: (options.systemPrompt as { append?: string } | undefined)?.append,
		});
		const stream = this._sdkQuery!({ prompt, options });
		this._handles.set(queryId, stream);
		// The init handshake already carries the account and the model list, so read
		// them off this turn instead of paying for a separate engine start later.
		this._captureInitInfo(stream);
		try {
			for await (const msg of stream) {
				if (abortController.signal.aborted) { break; }
				this._trace('sdk', {
					queryId,
					type: msg.type,
					subtype: (msg as { subtype?: string }).subtype,
					// A `stream_event` is only interesting for which raw event it carries —
					// `message_start` is where the context measurement comes from, so a log
					// that does not name it cannot answer why the meter stayed at zero.
					streamEvent: (msg as { event?: { type?: string; message?: { usage?: unknown } } }).event === undefined
						? undefined
						: {
							type: (msg as { event?: { type?: string } }).event?.type,
							usage: (msg as { event?: { message?: { usage?: unknown } } }).event?.message?.usage,
						},
					blocks: ((msg as { message?: { content?: unknown[] } }).message?.content ?? []).map(b => {
						const block = b as { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; text?: string };
						return { type: block.type, id: block.id, name: block.name, toolUseId: block.tool_use_id, isError: block.is_error, chars: block.text?.length };
					}),
					extra: Object.keys(msg as object).filter(k => k !== 'type' && k !== 'message'),
					toolUseResult: (msg as { tool_use_result?: unknown }).tool_use_result === undefined
						? undefined
						: Object.keys(((msg as { tool_use_result?: object }).tool_use_result) ?? {}),
					// A `result` with an error subtype is where a turn dies — the plain `extra`
					// keys name `errors`/`result` but never their value, so a turn that ends in
					// `error_during_execution` reads as a mystery. Capture the load-bearing
					// fields (truncated; `_redact` still scrubs anything key-shaped).
					resultInfo: msg.type === 'result'
						? {
							subtype: (msg as { subtype?: string }).subtype,
							isError: (msg as { is_error?: boolean }).is_error,
							numTurns: (msg as { num_turns?: number }).num_turns,
							text: String((msg as { result?: unknown }).result ?? '').slice(0, 800),
							errors: JSON.stringify((msg as { errors?: unknown }).errors ?? null).slice(0, 800),
						}
						: undefined,
					// The content of an *errored* tool_result is why a tool call failed (e.g. a
					// sub-agent Task that could not complete). Text-only, truncated.
					errorToolResult: (((msg as { message?: { content?: unknown[] } }).message?.content ?? [])
						.filter(b => (b as { type?: string; is_error?: boolean }).type === 'tool_result' && (b as { is_error?: boolean }).is_error)
						.map(b => JSON.stringify((b as { content?: unknown }).content ?? '').slice(0, 800)))[0],
				});
				this._handleSdkMessage(msg, queryId);
			}
		} catch (err) {
			this._trace('stream.error', { queryId, aborted: abortController.signal.aborted, error: String(err) });
			if (abortController.signal.aborted) {
				// cancelled by the renderer — resolve quietly.
				const pending = this._pending.get(queryId);
				if (pending) { this._pending.delete(queryId); pending.resolve({ text: '', isError: false }); }
			} else {
				const pending = this._pending.get(queryId);
				if (pending) { this._pending.delete(queryId); pending.reject(err instanceof Error ? err : new Error(String(err))); }
			}
			this._handles.delete(queryId);
			this._states.delete(queryId);
			return;
		}
		this._handles.delete(queryId);
		// Stream ended without a `result` message (e.g. empty response). Resolve
		// with whatever text/thinking we accumulated so the UI is not left hanging.
		const pending = this._pending.get(queryId);
		const cur = this._states.get(queryId);
		if (pending && cur) {
			const response: ICodeMindEngineResponse = {
				text: cur.text || 'No response.',
				model: cur.model,
				sessionId: cur.sessionId ?? this._sessions.get(cur.projectKey)?.sessionId,
				isError: false,
			};
			this._pending.delete(queryId);
			this._states.delete(queryId);
			pending.resolve(response);
		}
	}

	async cancelQuery(queryId: string): Promise<void> {
		// A cancelled turn never reaches `_finalize`, so the two things that method
		// would have recorded are recorded here instead — starting with the session
		// id. Without it a turn stopped before the first `result` of a conversation
		// leaves its session file orphaned: the next turn would resume nothing and
		// start again, and the record of what was said would be split in two.
		const state = this._states.get(queryId);
		if (state?.sessionId && state.isolated !== true) {
			const prev = this._sessions.get(state.projectKey) ?? {};
			prev.sessionId = state.sessionId;
			this._sessions.set(state.projectKey, prev);
		}
		// Ask the engine to stop the turn first: an interrupt is recorded in the
		// transcript, so a resumed session knows the turn was cut short. The abort
		// below is the hard stop for when the engine cannot answer in time.
		const handle = this._handles.get(queryId);
		let interrupted = false;
		if (handle?.interrupt) {
			try {
				await this._withTimeout(handle.interrupt(), 2000, 'The engine did not acknowledge the interrupt.');
				interrupted = true;
			} catch {
				// fall through to the abort
			}
		}
		// Abort the SDK stream so the engine actually stops working.
		//
		// An acknowledged interrupt has already told the engine to stop, and it is the
		// engine that writes the session file — aborting in the same tick kills the
		// process mid-flush, which is why a cancelled turn used to leave no trace in the
		// transcript at all. Give it a moment to close its own record, then abort anyway
		// in case it does not (the panel is not waiting on this: the pending promise is
		// settled below, so the turn is over as far as the user is concerned).
		const abort = this._aborts.get(queryId);
		if (abort) {
			this._aborts.delete(queryId);
			const stop = () => { try { abort.abort(); } catch { /* ignore */ } };
			if (interrupted) {
				setTimeout(stop, CodeMindAgentEngineMainService.INTERRUPT_FLUSH_GRACE_MS);
			} else {
				stop();
			}
		}
		// Deny any permission prompt still waiting on this query.
		for (const [toolUseId, pendingPermission] of [...this._pendingPermissions]) {
			this._pendingPermissions.delete(toolUseId);
			pendingPermission.resolve({ behavior: 'deny', message: 'Request cancelled.', interrupt: true });
		}
		const pending = this._pending.get(queryId);
		if (pending) {
			this._pending.delete(queryId);
			pending.reject(new Error('Request cancelled'));
		}
		this._states.delete(queryId);
		this._handles.delete(queryId);
	}

	/** Called by the renderer when the user answers a permission_request. */
	async respondToPermission(toolUseId: string, decision: CodeMindPermissionDecision, answer?: ICodeMindPermissionAnswer): Promise<void> {
		const pending = this._pendingPermissions.get(toolUseId);
		if (!pending) { return; }
		this._pendingPermissions.delete(toolUseId);
		if (decision === 'deny') {
			const feedback = answer?.feedback?.trim();
			const message = feedback
				? `${pending.isSubagent ? SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX : REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
				: (pending.isSubagent ? SUBAGENT_REJECT_MESSAGE : REJECT_MESSAGE);
			pending.resolve({ behavior: 'deny', message, decisionClassification: 'user_reject' });
			return;
		}
		if (decision === 'allow_session') {
			this._sessionAllowedTools.add(pending.toolName);
		}
		const updates = decision === 'allow_scope' && answer?.scopeId
			? pending.scopeUpdates.get(answer.scopeId)
			: undefined;
		if (updates) {
			// Session-destination updates would die with this turn's engine process,
			// so the worker keeps its own copy and replays it on every later turn.
			this._rememberSessionUpdates(updates);
		}
		pending.resolve({
			behavior: 'allow',
			// Required by the engine's schema on older builds; the engine falls back
			// to the original input when the object is empty, so echoing is safe.
			updatedInput: pending.input,
			updatedPermissions: updates ? [...updates] : undefined,
			decisionClassification: updates && storeForUpdates(updates) !== 'session' ? 'user_permanent' : 'user_temporary',
		});
	}

	/**
	 * Keep the parts of a grant the engine cannot keep for us. Persisted rules are
	 * written to settings files by the engine and re-read next turn, but `session`
	 * ones live only in the engine's in-memory context — and every turn starts a
	 * new engine process, so they have to be replayed from here.
	 */
	private _rememberSessionUpdates(updates: readonly SdkPermissionUpdate[]): void {
		for (const update of updates) {
			if (update.destination !== 'session') { continue; }
			if (update.type === 'addRules' && update.behavior === 'allow') {
				for (const rule of update.rules) {
					this._sessionAllowRules.add(ruleToSettingString(rule));
				}
			} else if (update.type === 'addDirectories') {
				for (const dir of update.directories) {
					this._sessionDirectories.add(dir);
				}
			} else if (update.type === 'setMode') {
				this._sessionPermissionMode = update.mode;
			}
		}
	}

	async setModel(model: string): Promise<void> {
		// The model is passed per-query in `queryStream` options; record it so the
		// next turn (and any resumed session) uses it.
		this._settings = { ...this._settings, model };
		await this._pushLiveSettings({ model });
	}

	async updateSettings(settings: ICodeMindEngineSettings): Promise<void> {
		const previousEndpoint = this._resolveBaseUrl();
		this._settings = {
			...this._settings,
			...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== '')),
		};
		if (settings.baseUrl !== undefined) {
			// The empty string is a real value here — it means "stop using a custom
			// endpoint" — so it has to survive the filter above, which drops '' for
			// every other field.
			this._settings = { ...this._settings, baseUrl: settings.baseUrl.trim() };
		}
		if (this._resolveBaseUrl() !== previousEndpoint) {
			// The model list belongs to the endpoint that served it.
			this._supportedModels = undefined;
			this._accountInfo = undefined;
		}
		if (settings.permissionMode) {
			// Choosing a mode by hand replaces one a permission dialog upgraded to —
			// otherwise stepping back down to `default` would silently do nothing.
			this._sessionPermissionMode = undefined;
		}
		await this._pushLiveSettings(settings);
	}

	/**
	 * Apply the part of a settings change that a running engine can take: the model,
	 * the permission mode and the thinking budget. Everything else is fixed for the
	 * turn already in flight and applies from the next one.
	 *
	 * Best effort throughout — the turn can end underneath us, and an older engine
	 * build may not expose a given control request at all.
	 */
	private async _pushLiveSettings(settings: ICodeMindEngineSettings): Promise<void> {
		const handle = this._liveHandle();
		if (!handle) {
			return;
		}
		try {
			if (settings.model !== undefined) {
				// '' means "use the account default", which the SDK spells as no model.
				await handle.setModel?.(settings.model || undefined);
			}
			if (settings.permissionMode) {
				await handle.setPermissionMode?.(settings.permissionMode);
			}
			if (settings.maxThinkingTokens !== undefined) {
				// null is the SDK's "back to the model's own budget".
				await handle.setMaxThinkingTokens?.(settings.maxThinkingTokens > 0 ? settings.maxThinkingTokens : null);
			}
		} catch {
			// The turn finished, or this build has no such control request.
		}
	}

	async setMcpServers(servers: readonly ICodeMindMcpServer[]): Promise<void> {
		this._mcpServers = servers.map(s => ({ ...s }));
	}

	async getMcpServers(): Promise<readonly ICodeMindMcpServer[]> {
		// Decorate the configured list with whatever the engine last reported, so
		// the MCP panel can show a real connection state instead of a guess. A server
		// the engine has never mentioned is configured but not connected — that is
		// `disconnected`, which is what the panel's three-state chip expects.
		return this._mcpServers.map(server => {
			const live = this._mcpStatus.get(server.name);
			return live ? { ...server, status: live.status, tools: live.tools } : { ...server, status: 'disconnected' as const };
		});
	}

	/** Record the MCP block from an engine init message. */
	private _captureMcpStatus(servers: Array<{ name: string; status?: string; tools?: string[] }> | undefined, allTools?: readonly string[]): void {
		if (!servers) { return; }
		for (const server of servers) {
			const raw = (server.status ?? '').toLowerCase();
			const status: ICodeMindMcpServer['status'] = raw.includes('connect') && !raw.includes('dis')
				? 'connected'
				: raw.includes('error') || raw.includes('fail') ? 'error'
					: 'disconnected';
			// Current engine builds report the server list without a per-server tool
			// list, but the init message's own `tools` array names every tool the turn
			// can call — and an MCP tool is always `mcp__<server>__<tool>`. Recovering
			// the names from there is what lets the MCP panel show what a connected
			// server actually offers instead of an empty row.
			const prefix = `mcp__${server.name}__`;
			const derived = (allTools ?? this._lastTools ?? [])
				.filter(name => name.startsWith(prefix))
				.map(name => name.slice(prefix.length));
			const tools = server.tools?.length ? server.tools : (derived.length ? derived : undefined);
			this._mcpStatus.set(server.name, { status, tools });
		}
	}

	// --- control requests
	//
	// The SDK answers these over the same stdio channel the turn uses, but only in
	// streaming-input mode. When no turn is running we start a control session: an
	// engine with an input stream that yields nothing, which completes the init
	// handshake and then waits. No prompt is sent, so no tokens are spent.

	/**
	 * The handle of the turn currently running, if there is one. A companion
	 * reaction or `/btw` can be in flight at the same time as the visible turn, and
	 * a control request ("what models do you offer?") belongs to the conversation —
	 * so prefer the newest non-isolated turn and only fall back to an isolated one.
	 */
	private _liveHandle(): SdkQueryHandle | undefined {
		let fallback: SdkQueryHandle | undefined;
		let handle: SdkQueryHandle | undefined;
		for (const [queryId, state] of this._states) {
			const live = this._handles.get(queryId);
			if (!live) { continue; }
			if (state.isolated) { fallback = live; } else { handle = live; }
		}
		return handle ?? fallback;
	}

	/** Read the account and model list off a handle's init handshake, best effort. */
	private _captureInitInfo(handle: SdkQueryHandle): void {
		handle.accountInfo?.().then(info => {
			if (info) { this._accountInfo = info; }
		}, () => { /* older engine build, or not authenticated yet */ });
		handle.supportedModels?.().then(models => {
			if (models && models.length > 0) { this._supportedModels = models; }
		}, () => { /* older engine build */ });
	}

	private async _withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
			]);
		} finally {
			if (timer) { clearTimeout(timer); }
		}
	}

	/**
	 * Start an engine purely to ask it something, run {@link run} against it, then
	 * shut it down. Used when no turn is in flight.
	 */
	private async _withControlSession<T>(apiKey: string, cwd: string | undefined, run: (handle: SdkQueryHandle) => Promise<T>, extra?: Partial<SdkOptions>): Promise<T> {
		await this._ensureSdkLoaded();
		if (!this._sdkQuery) {
			throw new Error(this._sdkLoadError ?? 'The engine SDK is not available.');
		}
		const abortController = new AbortController();
		let closeInput: () => void = () => { };
		const inputClosed = new Promise<void>(resolve => { closeInput = resolve; });
		// Yields nothing and stays open until we close it: enough for the engine to
		// finish its handshake and answer control requests, without a user turn.
		const prompt = (async function* (): AsyncIterable<SdkUserInput> { await inputClosed; })();
		const options: SdkOptions = {
			cwd: cwd ?? this._lastCwd,
			model: this._settings.model ?? DEFAULT_MODEL,
			tools: { type: 'preset', preset: 'claude_code' },
			env: this._buildEnv(apiKey),
			abortController,
			maxTurns: 1,
			// Nothing is said here, so nothing should be written to the session store.
			persistSession: false,
			settingSources: [...(this._settings.settingSources ?? ['user', 'project', 'local'])],
			...extra,
		};
		const handle = this._sdkQuery({ prompt, options });
		// The SDK dispatches control responses from its own reader, but an
		// unconsumed message queue would grow for as long as this engine lives.
		const drain = (async () => {
			try {
				for await (const _msg of handle) { /* discarded */ }
			} catch { /* aborted */ }
		})();
		try {
			return await this._withTimeout(run(handle), 30000, 'The engine did not answer in time.');
		} finally {
			closeInput();
			try { abortController.abort(); } catch { /* ignore */ }
			void drain;
		}
	}

	/** Ask an engine — the live one when there is one — for something. */
	private async _ask<T>(apiKey: string, cwd: string | undefined, run: (handle: SdkQueryHandle) => Promise<T> | undefined, extra?: Partial<SdkOptions>): Promise<T | undefined> {
		const live = this._liveHandle();
		if (live && !extra) {
			try {
				const answer = run(live);
				if (answer) {
					return await this._withTimeout(answer, 15000, 'The engine did not answer in time.');
				}
			} catch {
				// The turn may have ended underneath us — fall back to a control session.
			}
		}
		return this._withControlSession(apiKey, cwd, async handle => run(handle) ?? undefined, extra);
	}

	async getAccountInfo(apiKey: string, cwd?: string): Promise<ICodeMindAccountInfo | undefined> {
		if (this._accountInfo) { return this._accountInfo; }
		try {
			const info = await this._ask(apiKey, cwd, handle => handle.accountInfo?.());
			if (info) { this._accountInfo = info; }
			return info;
		} catch {
			return undefined;
		}
	}

	async getSupportedModels(apiKey: string, cwd?: string): Promise<readonly ICodeMindModelInfo[]> {
		if (this._supportedModels) { return this._supportedModels; }
		try {
			const models = await this._ask(apiKey, cwd, handle => handle.supportedModels?.());
			if (models && models.length > 0) {
				this._supportedModels = models;
				return models;
			}
		} catch {
			// fall through to the endpoint's own list
		}
		// A custom endpoint usually has no SDK-side model list — the SDK only knows
		// what the official API told it. Ask the endpoint directly instead, so a
		// gateway's model names show up in the picker.
		try {
			const models = await this.listEndpointModels(apiKey);
			if (models.length > 0) {
				this._supportedModels = models;
				return models;
			}
		} catch {
			// fall through to the empty list — callers keep their own fallback
		}
		return [];
	}

	/**
	 * Slash commands the engine knows about. Cached for the life of the worker:
	 * project commands are read at engine start, so a fresh answer needs a fresh
	 * engine anyway, and the list is asked for on every panel reload.
	 */
	async getEngineCommands(apiKey: string, cwd?: string): Promise<readonly ICodeMindEngineCommandInfo[]> {
		if (this._engineCommands) { return this._engineCommands; }
		try {
			const commands = await this._ask(apiKey, cwd, handle => handle.supportedCommands?.());
			if (commands && commands.length > 0) {
				this._engineCommands = commands.map(c => ({
					name: c.name,
					description: c.description ?? '',
					argumentHint: c.argumentHint ?? '',
				}));
				return this._engineCommands;
			}
		} catch {
			// fall through — the panel keeps its own command list
		}
		return [];
	}

	/**
	 * Ask the engine for live MCP state and return the configured list decorated
	 * with it. Falls back to whatever the last init message reported.
	 */
	async refreshMcpStatus(apiKey: string, cwd?: string): Promise<readonly ICodeMindMcpServer[]> {
		try {
			const statuses = await this._ask(apiKey, cwd, handle => handle.mcpServerStatus?.());
			for (const server of statuses ?? []) {
				// `pending` means the SDK has the server configured but no live session has
				// connected it yet — that is "disconnected", not an unknown state. The panel
				// only ever shows connected / disconnected / error.
				const status: ICodeMindMcpServer['status'] = server.status === 'connected'
					? 'connected'
					: server.status === 'pending' ? 'disconnected'
						: 'error';
				const known = this._mcpStatus.get(server.name);
				this._mcpStatus.set(server.name, { status, tools: known?.tools });
			}
		} catch {
			// keep the last known status
		}
		return this.getMcpServers();
	}

	async getCheckpoints(cwd?: string): Promise<readonly ICodeMindCheckpoint[]> {
		const key = cwd ?? this._lastCwd ?? this._engineRoot ?? '';
		return [...(this._checkpoints.get(key) ?? [])];
	}

	/**
	 * Restore the files the agent touched to their state at a checkpoint. The
	 * engine keeps the checkpoints with the session, so a resumed control session
	 * can roll back a turn from an earlier run of the panel.
	 */
	async rewindFiles(apiKey: string, userMessageId: string, dryRun?: boolean, cwd?: string): Promise<ICodeMindRewindResult> {
		const sessionId = await this.getSessionId();
		try {
			const result = await this._ask(
				apiKey,
				cwd,
				handle => handle.rewindFiles?.(userMessageId, { dryRun }),
				this._liveHandle() ? undefined : { resume: sessionId, enableFileCheckpointing: true },
			);
			return result ?? { canRewind: false, error: 'This engine build cannot rewind files.' };
		} catch (err) {
			return { canRewind: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Record a rewind point for a user turn the engine echoed back. */
	private _recordCheckpoint(projectKey: string, uuid: string, prompt: string): void {
		const label = prompt.split('\n').find(line => line.trim().length > 0)?.trim().slice(0, 120) ?? 'Turn';
		const list = this._checkpoints.get(projectKey) ?? [];
		if (list.some(entry => entry.uuid === uuid)) { return; }
		list.push({ uuid, label, at: Date.now() });
		// Keep the list bounded: the picker only ever shows the recent ones.
		while (list.length > 100) { list.shift(); }
		this._checkpoints.set(projectKey, list);
	}

	/**
	 * Run one of the engine's own slash commands and return what it printed.
	 *
	 * The engine implements a few commands itself and answers them without a model
	 * call — `/context` measures the real system prompt, tool schemas, memory files
	 * and message history, and `/compact` rewrites the conversation it will resume.
	 * Neither can be reproduced from the renderer, so the command is forwarded.
	 *
	 * The turn resumes the workspace session (so the answer is about the
	 * conversation the user is having) and is persisted (so a compaction survives
	 * into the next turn). Built-in tools are refused: a command the engine does not
	 * recognise falls through to the model there, and this channel must never be a
	 * way for that to touch the workspace.
	 */
	async runEngineCommand(apiKey: string, command: string, cwd?: string, timeoutMs?: number): Promise<ICodeMindEngineCommandResult> {
		const problem = await this.diagnose(apiKey);
		if (problem) {
			return { text: '', isError: true, error: problem };
		}
		await this._ensureSdkLoaded();
		if (!this._sdkQuery) {
			return { text: '', isError: true, error: this._sdkLoadError ?? 'The engine SDK is not available.' };
		}

		const projectKey = cwd ?? this._lastCwd ?? this._engineRoot ?? '';
		const sessionState = this._sessions.get(projectKey);
		const resume = this._forcedResumeSessionId ?? sessionState?.sessionId;
		const text = command.startsWith('/') ? command : `/${command}`;
		const abortController = new AbortController();
		const prompt = (async function* (): AsyncIterable<SdkUserInput> {
			yield {
				type: 'user',
				message: { role: 'user', content: [{ type: 'text', text }] },
				parent_tool_use_id: null,
				session_id: '',
				uuid: generateUuid(),
			};
		})();
		const options: SdkOptions = {
			cwd: cwd ?? this._lastCwd,
			model: this._settings.model ?? DEFAULT_MODEL,
			tools: [],
			env: this._buildEnv(apiKey),
			abortController,
			maxTurns: 1,
			persistSession: true,
			resume,
			settingSources: [...(this._settings.settingSources ?? ['user', 'project', 'local'])],
		};

		const handle = this._sdkQuery({ prompt, options });
		const printed: string[] = [];
		let compacted: ICodeMindEngineCommandResult['compacted'];
		let sessionId: string | undefined;
		let isError = false;
		try {
			await this._withTimeout((async () => {
				for await (const msg of handle) {
					this._collectCommandOutput(msg, printed);
					if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
						compacted = {
							trigger: msg.compact_metadata?.trigger ?? 'manual',
							preTokens: msg.compact_metadata?.pre_tokens ?? 0,
						};
						sessionId = msg.session_id ?? sessionId;
					} else if (msg.type === 'result') {
						isError = msg.is_error === true;
						sessionId = msg.session_id ?? sessionId;
						if (typeof msg.result === 'string' && msg.result.trim()) {
							printed.push(msg.result);
						}
						break;
					}
				}
			})(), timeoutMs ?? 180000, 'The engine did not finish the command in time.');
		} catch (err) {
			return { text: this._joinCommandOutput(printed), isError: true, error: err instanceof Error ? err.message : String(err) };
		} finally {
			try { abortController.abort(); } catch { /* ignore */ }
		}

		// A resumed command turn keeps the session id, but a compaction can start a
		// new one — record whatever came back so the next turn resumes the state the
		// command left behind rather than the pre-command conversation.
		if (sessionId) {
			const prev = this._sessions.get(projectKey) ?? {};
			prev.sessionId = sessionId;
			this._sessions.set(projectKey, prev);
			this._forcedResumeSessionId = undefined;
		}
		return { text: this._joinCommandOutput(printed), isError, compacted, sessionId };
	}

	/** Text an engine command printed, from whichever message shape carried it. */
	private _collectCommandOutput(msg: SdkMessage, into: string[]): void {
		if (msg.type === 'assistant') {
			for (const block of msg.message.content) {
				if (block.type === 'text' && block.text.trim()) { into.push(block.text); }
			}
			return;
		}
		if (msg.type === 'system' && msg.subtype === 'local_command_output') {
			const unwrapped = unwrapLocalCommandOutput(msg.content ?? '');
			if (unwrapped) { into.push(unwrapped); }
			return;
		}
		if (msg.type === 'user') {
			// Local command output rides back as a user message whose content is a
			// plain string wrapped in stdout/stderr tags, not the block array a real
			// user turn carries.
			const content: unknown = (msg as { message?: { content?: unknown } }).message?.content;
			if (typeof content === 'string') {
				const unwrapped = unwrapLocalCommandOutput(content);
				if (unwrapped) { into.push(unwrapped); }
			}
		}
	}

	/** Join the pieces a command printed, dropping the ones the engine repeats. */
	private _joinCommandOutput(parts: readonly string[]): string {
		const seen = new Set<string>();
		const unique: string[] = [];
		for (const part of parts) {
			const trimmed = part.trim();
			// The engine prints local command output and then repeats it as the turn's
			// result, so the same text usually arrives twice.
			if (!trimmed || seen.has(trimmed)) { continue; }
			seen.add(trimmed);
			unique.push(trimmed);
		}
		return unique.join('\n\n');
	}

	/** Token, cost and duration totals summed from every finished turn. */
	async getSessionUsage(): Promise<ICodeMindSessionUsage | undefined> {
		let totals: ICodeMindSessionUsage | undefined;
		for (const state of this._sessions.values()) {
			const usage = state.usage;
			if (!usage) { continue; }
			totals = {
				turns: (totals?.turns ?? 0) + usage.turns,
				inputTokens: (totals?.inputTokens ?? 0) + usage.inputTokens,
				outputTokens: (totals?.outputTokens ?? 0) + usage.outputTokens,
				cacheReadInputTokens: (totals?.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens,
				cacheCreationInputTokens: (totals?.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens,
				totalCostUsd: state.totalCostUsd !== undefined ? (totals?.totalCostUsd ?? 0) + state.totalCostUsd : totals?.totalCostUsd,
				totalDurationMs: (totals?.totalDurationMs ?? 0) + usage.totalDurationMs,
				lastRequestTokens: usage.lastRequestTokens ?? totals?.lastRequestTokens,
				lastModel: usage.lastModel ?? totals?.lastModel,
			};
		}
		return totals;
	}

	/**
	 * Run a process and capture its output. Deliberately not a shell: the command
	 * and arguments are passed separately so nothing the model or the user typed
	 * can be interpreted as shell syntax.
	 */
	async exec(request: ICodeMindExecRequest): Promise<ICodeMindExecResult> {
		return this._spawnCapture(request.command, [...request.args], false, request.cwd, request.timeoutMs, request.input);
	}

	/**
	 * Run a command line through the platform shell. Only the composer's `!` mode
	 * calls this, with a line the user typed — see {@link ICodeMindShellRequest}.
	 */
	async execShell(request: ICodeMindShellRequest): Promise<ICodeMindExecResult> {
		return this._spawnCapture(request.command, undefined, true, request.cwd, request.timeoutMs);
	}

	/**
	 * Spawn a child, buffer both its streams and resolve once it exits or the
	 * timeout fires. `args` is left undefined for the shell case so the command
	 * line reaches the shell as one string rather than being re-concatenated.
	 */
	private _spawnCapture(command: string, args: string[] | undefined, useShell: boolean, cwd?: string, timeoutMs?: number, input?: string): Promise<ICodeMindExecResult> {
		return new Promise<ICodeMindExecResult>(resolvePromise => {
			let child;
			try {
				child = spawn(command, args ?? [], {
					cwd,
					env: process.env,
					shell: useShell,
					windowsHide: true,
				});
			} catch (err) {
				resolvePromise({ exitCode: -1, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) });
				return;
			}

			let stdout = '';
			let stderr = '';
			let settled = false;
			const finish = (result: ICodeMindExecResult) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				resolvePromise(result);
			};
			const timer = setTimeout(() => {
				try { child.kill(); } catch { /* ignore */ }
				finish({ exitCode: -1, stdout, stderr, error: `Timed out after ${timeoutMs ?? 60000}ms.` });
			}, timeoutMs ?? 60000);

			child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
			child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
			child.on('error', err => finish({ exitCode: -1, stdout, stderr, error: err.message }));
			child.on('close', code => finish({ exitCode: code ?? 0, stdout, stderr }));

			if (input !== undefined) {
				child.stdin?.end(input);
			} else {
				child.stdin?.end();
			}
		});
	}

	/** Environment diagnostics for `/doctor`. */
	async doctor(): Promise<readonly ICodeMindDoctorCheck[]> {
		const checks: ICodeMindDoctorCheck[] = [];

		checks.push({
			name: 'Engine source',
			ok: !!this._engineRoot,
			detail: this._engineRoot ?? 'No sibling claude-code/ directory found.',
		});

		const sdkPath = this._engineRoot
			? resolve(this._engineRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')
			: undefined;
		checks.push({
			name: 'Claude Agent SDK',
			ok: !!sdkPath && existsSync(sdkPath),
			detail: sdkPath ? (existsSync(sdkPath) ? sdkPath : `Missing: ${sdkPath}`) : 'Unknown — engine source not found.',
		});

		if (this._sdkLoadError) {
			checks.push({ name: 'SDK load', ok: false, detail: this._sdkLoadError });
		} else if (this._sdkQuery) {
			checks.push({ name: 'SDK load', ok: true, detail: 'Loaded.' });
		}

		checks.push({
			name: 'Node runtime',
			ok: true,
			detail: `${process.version} (${process.platform}/${process.arch})`,
		});

		for (const tool of [{ name: 'git', args: ['--version'] }, { name: 'gh', args: ['--version'] }, { name: 'bun', args: ['--version'] }]) {
			const result = await this.exec({ command: tool.name, args: tool.args, timeoutMs: 8000 });
			const line = (result.stdout || result.stderr).split('\n')[0].trim();
			checks.push({
				name: tool.name,
				ok: result.exitCode === 0,
				detail: result.exitCode === 0 ? line : (result.error ?? `Not available (exit ${result.exitCode}).`),
			});
		}

		checks.push({
			name: 'Model',
			ok: true,
			detail: this._settings.model ?? DEFAULT_MODEL,
		});
		const endpoint = this._resolveBaseUrl();
		checks.push({
			name: 'Endpoint',
			ok: true,
			detail: endpoint
				? `${endpoint} (${this._settings.baseUrl ? 'from settings' : 'from ANTHROPIC_BASE_URL'})`
				: `${DEFAULT_ANTHROPIC_BASE_URL} (default)`,
		});
		checks.push({
			name: 'Permission mode',
			ok: true,
			// The effective mode, so a session upgrade from a dialog is visible here.
			detail: this._resolvePermissionMode(),
		});
		const sessionGrants = this._sessionAllowedTools.size + this._sessionAllowRules.size + this._sessionDirectories.size;
		if (sessionGrants > 0) {
			checks.push({
				name: 'Session permission grants',
				ok: true,
				detail: [
					...[...this._sessionAllowedTools].map(t => `${t} (any use)`),
					...this._sessionAllowRules,
					...[...this._sessionDirectories].map(d => `directory ${d}`),
				].join(', '),
			});
		}
		const enabledMcp = this._mcpServers.filter(s => s.enabled !== false).length;
		checks.push({
			name: 'MCP servers',
			ok: true,
			detail: enabledMcp === 0 ? 'None configured.' : `${enabledMcp} configured.`,
		});
		if (this._lastTools?.length) {
			checks.push({ name: 'Tools available', ok: true, detail: `${this._lastTools.length} tools reported by the engine.` });
		}

		checks.push(...this._settingsFileChecks(), ...this._envVarChecks(), ...this._agentDirChecks(), ...this._pluginChecks());
		return checks;
	}

	/**
	 * One check per settings file the engine merges. A file that does not parse is
	 * dropped silently by the engine, so a rule that "stopped working" usually shows
	 * up here and nowhere else.
	 */
	private _settingsFileChecks(): ICodeMindDoctorCheck[] {
		const loaded = this._settings.settingSources;
		const files: Array<{ name: string; source: 'user' | 'project' | 'local'; path: string }> = [
			{ name: 'User settings', source: 'user', path: join(homedir(), '.claude', 'settings.json') },
		];
		if (this._lastCwd) {
			files.push(
				{ name: 'Project settings', source: 'project', path: join(this._lastCwd, '.claude', 'settings.json') },
				{ name: 'Local settings', source: 'local', path: join(this._lastCwd, '.claude', 'settings.local.json') },
			);
		}
		return files.map(file => {
			// An explicit `settingSources` that leaves a scope out means the engine never
			// reads that file, which is worth saying before someone edits it in vain.
			if (loaded && !loaded.includes(file.source)) {
				return { name: file.name, ok: true, detail: `Not loaded — settingSources excludes '${file.source}' (${file.path}).` };
			}
			if (!existsSync(file.path)) {
				return { name: file.name, ok: true, detail: `Not present (${file.path}).` };
			}
			try {
				JSON.parse(readFileSync(file.path, 'utf8'));
				return { name: file.name, ok: true, detail: file.path };
			} catch (err) {
				return {
					name: file.name,
					ok: false,
					detail: `Invalid JSON, so the engine is ignoring it — ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		});
	}

	/**
	 * The output-size environment variables, reported only when one of them is out of
	 * bounds — the same three the CLI's `/doctor` checks, and the same silence when
	 * they are fine. The engine reads them from this worker's environment, so the
	 * renderer cannot see them.
	 */
	private _envVarChecks(): ICodeMindDoctorCheck[] {
		const bounds = maxOutputTokensFor(this._settings.model ?? DEFAULT_MODEL);
		const vars = [
			{ name: 'BASH_MAX_OUTPUT_LENGTH', default: 30_000, upperLimit: 150_000 },
			{ name: 'TASK_MAX_OUTPUT_LENGTH', default: 32_000, upperLimit: 160_000 },
			{ name: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', default: bounds.default, upperLimit: bounds.upperLimit },
		];
		const checks: ICodeMindDoctorCheck[] = [];
		for (const spec of vars) {
			const result = validateBoundedIntEnvVar(process.env[spec.name], spec.default, spec.upperLimit);
			if (result.status !== 'valid') {
				// `capped` is a warning in the CLI and an error here: the panel's doctor
				// has one severity, and either way the value the user set is not in force.
				checks.push({ name: spec.name, ok: false, detail: `${result.message} (effective: ${result.effective})` });
			}
		}
		return checks;
	}

	/** Where subagent definitions are looked for, and whether those directories exist. */
	private _agentDirChecks(): ICodeMindDoctorCheck[] {
		const dirs: Array<{ name: string; path: string }> = [
			{ name: 'User agents', path: join(homedir(), '.claude', 'agents') },
		];
		if (this._lastCwd) {
			dirs.push({ name: 'Project agents', path: join(this._lastCwd, '.claude', 'agents') });
		}
		// A missing directory is normal — it only means no agents are defined there —
		// so these are informational rather than failures.
		return dirs.map(dir => ({ name: dir.name, ok: true, detail: existsSync(dir.path) ? dir.path : `Not present (${dir.path}).` }));
	}

	/**
	 * Plugin state: whether the two files the engine keeps under `~/.claude/plugins`
	 * parse, and whether every plugin they claim is installed is actually on disk.
	 * The CLI reports errors from its own plugin loader; this worker does not run
	 * one, so it checks what the loader would be reading.
	 */
	private _pluginChecks(): ICodeMindDoctorCheck[] {
		const checks: ICodeMindDoctorCheck[] = [];
		const pluginsDir = join(homedir(), '.claude', 'plugins');
		const installedPath = join(pluginsDir, 'installed_plugins.json');
		if (!existsSync(installedPath)) {
			return checks;
		}
		let installed: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(readFileSync(installedPath, 'utf8')) as { plugins?: Record<string, unknown> };
			installed = parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
		} catch (err) {
			checks.push({ name: 'Plugins', ok: false, detail: `installed_plugins.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
			return checks;
		}
		const ids = Object.keys(installed);
		// Plugin payloads live in `repos/<marketplace>/...`, so a missing directory
		// here is the one failure the panel can see without loading the plugin.
		const missing = ids.filter(id => {
			const [marketplace, name] = id.includes('@') ? id.split('@') : [undefined, id];
			const candidates = marketplace
				? [join(pluginsDir, 'repos', marketplace, name), join(pluginsDir, 'repos', marketplace)]
				: [join(pluginsDir, 'repos', name)];
			return !candidates.some(existsSync);
		});
		checks.push({
			name: 'Plugins',
			ok: missing.length === 0,
			detail: ids.length === 0
				? 'None installed.'
				: missing.length === 0
					? `${ids.length} installed: ${ids.join(', ')}`
					: `${missing.length} of ${ids.length} not found on disk: ${missing.join(', ')}. Reinstall them, or run /reload-plugins.`,
		});
		const marketplacesPath = join(pluginsDir, 'known_marketplaces.json');
		if (existsSync(marketplacesPath)) {
			try {
				JSON.parse(readFileSync(marketplacesPath, 'utf8'));
			} catch (err) {
				checks.push({ name: 'Plugin marketplaces', ok: false, detail: `known_marketplaces.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
			}
		}
		return checks;
	}

	/**
	 * Feature flags. Voice input needs the Web Speech API, which the renderer
	 * checks for itself; the engine reports whether the CLI source ships the
	 * voice module so the button only appears on builds that support it.
	 */
	async getFeatureFlags(): Promise<Readonly<Record<string, boolean>>> {
		const voice = !!this._engineRoot && existsSync(join(this._engineRoot, 'src', 'voice'));
		return {
			voiceMode: voice,
			mcp: true,
			plan: true,
			// The engine reads these from its own environment, which is this worker's,
			// so the panel has to ask here rather than guess in the renderer.
			autoCompact: !isEnvTruthy(process.env.DISABLE_COMPACT) && !isEnvTruthy(process.env.DISABLE_AUTO_COMPACT),
		};
	}

	/**
	 * Write a V8 heap snapshot of this worker. The worker is the process that owns
	 * the SDK session, its message buffers and the transcript the engine keeps, so
	 * it is the heap worth inspecting when the panel grows unexpectedly large.
	 *
	 * `v8` is imported dynamically because the module is only needed here, and the
	 * write is synchronous and can take seconds on a large heap — the caller is a
	 * hidden diagnostic command, so blocking the worker briefly is acceptable.
	 */
	async heapSnapshot(): Promise<ICodeMindHeapSnapshotResult> {
		try {
			const v8 = await import('v8');
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const target = join(tmpdir(), `codemind-engine-${process.pid}-${stamp}.heapsnapshot`);
			const written = v8.writeHeapSnapshot(target);
			return { path: written ?? target };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	async getSessionCost(): Promise<{ totalCostUsd?: number } | undefined> {
		let total: number | undefined;
		for (const state of this._sessions.values()) {
			if (state.totalCostUsd !== undefined) {
				total = (total ?? 0) + state.totalCostUsd;
			}
		}
		return total === undefined ? undefined : { totalCostUsd: total };
	}

	async getSessionId(): Promise<string | undefined> {
		if (this._forcedResumeSessionId) { return this._forcedResumeSessionId; }
		for (const state of this._sessions.values()) {
			if (state.sessionId) { return state.sessionId; }
		}
		return undefined;
	}

	async resumeSession(sessionId: string): Promise<void> {
		this._forcedResumeSessionId = sessionId;
	}

	async forkSession(): Promise<string | undefined> {
		const source = await this.getSessionId();
		// Nothing to fork from yet: report that rather than arming a flag that would
		// fire on whatever session happens to exist by the next turn.
		if (!source) {
			return undefined;
		}
		this._forkNextTurn = true;
		return source;
	}

	/**
	 * Check a key against the endpoint without storing it. Uses the cheapest
	 * possible authenticated request (a 1-token completion) and treats any
	 * non-auth failure as "reachable, key accepted" so offline users are not told
	 * their key is bad.
	 *
	 * The request goes where the SDK would go, so a custom `baseUrl` is honoured: a
	 * gateway-issued key is not valid against api.anthropic.com, and checking it
	 * there would report a working key as rejected. The timeout matters for the same
	 * reason — a URL that accepts the connection and never answers would otherwise
	 * leave the dialog waiting forever with nothing on screen.
	 */
	async validateApiKey(key: string, baseUrl?: string): Promise<ICodeMindEndpointCheck> {
		const endpoint = this._resolveBaseUrl(baseUrl) ?? DEFAULT_ANTHROPIC_BASE_URL;
		if (!key) {
			return { ok: false, detail: 'No key was given.', endpoint };
		}
		if (!key.startsWith('sk-')) {
			return { ok: false, detail: 'Anthropic keys start with "sk-".', endpoint };
		}
		let url: URL;
		try {
			url = new URL(`${endpoint}/v1/messages`);
		} catch {
			return { ok: false, detail: `Not a usable endpoint URL: ${endpoint}`, endpoint };
		}
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: this._endpointHeaders(key),
				body: JSON.stringify({
					model: this._settings.model || DEFAULT_MODEL,
					max_tokens: 1,
					messages: [{ role: 'user', content: 'hi' }],
				}),
				signal: AbortSignal.timeout(CodeMindAgentEngineMainService.VALIDATE_TIMEOUT_MS),
			});
			if (res.status === 401 || res.status === 403) {
				return { ok: false, status: res.status, detail: `The endpoint rejected the key (HTTP ${res.status}).`, endpoint };
			}
			if (res.status === 404) {
				// The host answered but has no Messages API there — almost always a base
				// URL that already includes `/v1`, or a non-Anthropic gateway.
				return { ok: false, status: res.status, detail: `No Messages API at ${endpoint}/v1/messages (HTTP 404). Check the URL — it should not include /v1.`, endpoint };
			}
			if (res.status >= 500) {
				return { ok: true, status: res.status, detail: `Key accepted, but the endpoint is unhealthy right now (HTTP ${res.status}).`, endpoint };
			}
			if (!res.ok) {
				// 400/429 and friends: the key got far enough to be authenticated.
				return { ok: true, status: res.status, detail: `Key accepted (endpoint answered HTTP ${res.status}).`, endpoint };
			}
			return { ok: true, status: res.status, detail: 'Key accepted.', endpoint };
		} catch (err) {
			// Network failure — cannot disprove the key, but name what happened so a
			// typo in the URL does not look like a working setup.
			const reason = err instanceof Error && err.name === 'TimeoutError'
				? `no answer within ${Math.round(CodeMindAgentEngineMainService.VALIDATE_TIMEOUT_MS / 1000)}s`
				: err instanceof Error ? err.message : String(err);
			return { ok: true, detail: `Could not reach ${endpoint} (${reason}) — the key was not disproved.`, endpoint };
		}
	}

	/**
	 * List the models the endpoint advertises. Anthropic ids only: the engine speaks
	 * the Messages API, so an OpenAI-shaped id from a multi-provider gateway would
	 * fail on the first turn — offering it would be a trap.
	 */
	async listEndpointModels(key?: string, baseUrl?: string): Promise<readonly ICodeMindModelInfo[]> {
		const endpoint = this._resolveBaseUrl(baseUrl) ?? DEFAULT_ANTHROPIC_BASE_URL;
		const effectiveKey = key || process.env.ANTHROPIC_API_KEY || '';
		if (!effectiveKey) {
			throw new Error('Enter an API key first — /v1/models needs one.');
		}
		let url: URL;
		try {
			url = new URL(`${endpoint}/v1/models?limit=1000`);
		} catch {
			throw new Error(`Not a usable endpoint URL: ${endpoint}`);
		}
		let res: Response;
		try {
			res = await fetch(url, {
				method: 'GET',
				headers: this._endpointHeaders(effectiveKey),
				signal: AbortSignal.timeout(CodeMindAgentEngineMainService.VALIDATE_TIMEOUT_MS),
			});
		} catch (err) {
			const reason = err instanceof Error && err.name === 'TimeoutError'
				? `no answer within ${Math.round(CodeMindAgentEngineMainService.VALIDATE_TIMEOUT_MS / 1000)}s`
				: err instanceof Error ? err.message : String(err);
			throw new Error(`Could not reach ${endpoint} (${reason}).`);
		}
		if (!res.ok) {
			throw new Error(res.status === 404
				? `No model list at ${endpoint}/v1/models (HTTP 404). The endpoint may not implement it.`
				: `${endpoint}/v1/models answered HTTP ${res.status}.`);
		}
		let payload: unknown;
		try {
			payload = await res.json();
		} catch {
			throw new Error(`${endpoint}/v1/models did not return JSON.`);
		}
		const rows = Array.isArray(payload) ? payload : (payload as { data?: unknown })?.data;
		if (!Array.isArray(rows)) {
			throw new Error(`${endpoint}/v1/models returned an unexpected shape.`);
		}
		const models: ICodeMindModelInfo[] = [];
		for (const row of rows) {
			const entry = row as { id?: unknown; display_name?: unknown; created_at?: unknown };
			const id = typeof entry.id === 'string' ? entry.id : undefined;
			if (!id) { continue; }
			const created = typeof entry.created_at === 'string' ? entry.created_at.slice(0, 10) : '';
			models.push({
				value: id,
				displayName: typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : id,
				description: created ? `${endpoint} · ${created}` : endpoint,
			});
		}
		return models;
	}

	/**
	 * Auth headers for a direct endpoint call. Both header styles go out: the
	 * official API reads `x-api-key`, while gateways commonly want a bearer token,
	 * and sending both means one form of a working key is enough.
	 */
	private _endpointHeaders(key: string): Record<string, string> {
		return {
			'content-type': 'application/json',
			'x-api-key': key,
			'authorization': `Bearer ${key}`,
			'anthropic-version': ANTHROPIC_API_VERSION,
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		};
	}

	async clearSession(): Promise<void> {
		this._sessions.clear();
		this._sessionAllowedTools.clear();
		// Grants scoped to "this session" end with the session that earned them.
		// Anything persisted to a settings file deliberately survives.
		this._sessionAllowRules.clear();
		this._sessionDirectories.clear();
		this._sessionPermissionMode = undefined;
		this._forcedResumeSessionId = undefined;
		this._forkNextTurn = false;
		// The rewind points belong to the conversation being thrown away.
		this._checkpoints.clear();
	}

	// --- SDK loading

	private async _ensureSdkLoaded(): Promise<void> {
		if (this._sdkQuery) { return; }
		if (this._sdkLoadError) { throw new Error(this._sdkLoadError); }
		if (!this._engineRoot) { throw new Error('Engine root not available'); }

		const sdkPath = resolve(this._engineRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
		try {
			const mod = await import(pathToFileURL(sdkPath).href) as { query: SdkQueryFn };
			if (typeof mod.query !== 'function') {
				throw new Error('The SDK module did not export a `query` function.');
			}
			this._sdkQuery = mod.query;
		} catch (err) {
			this._sdkLoadError = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to load the Claude Agent SDK from ${sdkPath}: ${this._sdkLoadError}`);
		}
	}

	// --- system prompt

	private _buildSystemPrompt(request: ICodeMindEngineRequest): string {
		const parts: string[] = [];
		parts.push('You are CodeMind, an expert software engineering AI assistant integrated directly into the CodeMind editor.');
		parts.push('You help users write, understand, debug, refactor, and maintain code.');
		parts.push('Prefer concise, accurate answers. When editing, make minimal, focused changes.');
		// Extra instructions the user typed into the settings panel apply to every turn.
		const configured = this._settings.systemPrompt?.trim();
		if (configured) {
			parts.push(configured);
		}
		if (request.systemPromptSuffix) {
			parts.push(request.systemPromptSuffix);
		}
		const pathRule = windowsFilePathRule(request.cwd);
		if (pathRule) {
			parts.push(pathRule);
		}
		return parts.join('\n\n');
	}

	// --- permission bridge

	private async _handleCanUseTool(
		queryId: string,
		toolName: string,
		input: unknown,
		ctx: { signal: AbortSignal; suggestions?: unknown; blockedPath?: string; decisionReason?: string; toolUseID?: string; agentID?: string },
		planMode: boolean,
		blockAllTools: boolean,
	): Promise<SdkPermissionResult> {
		// A side question (`/btw`) answers from what the model already knows: every
		// tool is refused, and no dialog is raised for a turn the user cannot see.
		if (blockAllTools) {
			return {
				behavior: 'deny',
				message: `Tools are unavailable for this side question, so ${toolName} cannot run. Answer from the conversation instead.`,
			};
		}
		// Plan mode is read-only: refuse anything that could change the workspace
		// without bothering the user with a dialog they would have to decline.
		if (planMode && MUTATING_TOOLS.has(toolName)) {
			return {
				behavior: 'deny',
				message: `Plan mode is on, so ${toolName} is unavailable. Describe the change instead, or turn plan mode off to apply it.`,
			};
		}
		// The user previously chose "allow for this session" for this tool.
		if (this._sessionAllowedTools.has(toolName)) {
			return { behavior: 'allow', updatedInput: asRecord(input) };
		}
		// Asking the user something is not an action to approve — let it through so the
		// question itself is what the panel shows.
		if (NO_PROMPT_TOOLS.has(toolName)) {
			return { behavior: 'allow', updatedInput: asRecord(input) };
		}
		const toolUseId = ctx.toolUseID ?? `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const suggestions = asPermissionUpdates(ctx.suggestions);
		const scopeUpdates = new Map<string, readonly SdkPermissionUpdate[]>();
		const scopes = this._buildPermissionScopes(toolName, input, suggestions, scopeUpdates);
		// Emit a permission_request event so the renderer can show the dialog.
		// The event is tagged with the current queryId so the UI correlates it.
		this._emit(queryId, {
			kind: 'permission_request',
			toolUseId,
			toolName,
			input,
			scopes,
			blockedPath: ctx.blockedPath,
			reason: ctx.decisionReason,
			agentId: ctx.agentID,
		});
		return new Promise<SdkPermissionResult>((resolve, reject) => {
			// If the query is aborted while we're waiting, deny by default.
			const onAbort = () => {
				this._pendingPermissions.delete(toolUseId);
				reject(new Error('Permission request aborted'));
			};
			if (ctx.signal.aborted) { onAbort(); return; }
			ctx.signal.addEventListener('abort', onAbort, { once: true });
			this._pendingPermissions.set(toolUseId, {
				resolve,
				reject: (e: Error) => { ctx.signal.removeEventListener('abort', onAbort); reject(e); },
				toolName,
				input: asRecord(input),
				scopeUpdates,
				isSubagent: !!ctx.agentID,
			});
		});
	}

	/**
	 * Turn the engine's own suggestions into the buttons the dialog offers, and
	 * record what accepting each one grants.
	 *
	 * The first option mirrors the CLI's "Yes, and don't ask again…" — it applies
	 * every suggestion the engine made, which is what makes the grant match what
	 * the engine would have remembered had the user answered in the terminal. The
	 * narrower options after it exist because a graphical dialog can afford to
	 * show more than three choices: a Bash command can be allowed exactly as
	 * typed rather than by prefix, and a file tool can be allowed for one path
	 * without switching the whole session into accept-edits.
	 */
	private _buildPermissionScopes(
		toolName: string,
		input: unknown,
		suggestions: readonly SdkPermissionUpdate[],
		out: Map<string, readonly SdkPermissionUpdate[]>,
	): ICodeMindPermissionScope[] {
		const scopes: ICodeMindPermissionScope[] = [];
		const add = (scope: ICodeMindPermissionScope, updates: readonly SdkPermissionUpdate[]) => {
			if (updates.length === 0 || out.has(scope.id)) { return; }
			out.set(scope.id, updates);
			scopes.push(scope);
		};
		if (suggestions.length > 0) {
			const label = this._describeSuggestions(toolName, suggestions);
			if (label) {
				add({ id: 'suggested', label, store: storeForUpdates(suggestions), mode: modeFromUpdates(suggestions) }, suggestions);
			}
		}
		const record = asRecord(input);
		// Bash: the engine suggests a command *prefix* ("git status:*"), which also
		// covers arguments the user has not seen. Offer the exact line as well.
		const command = typeof record.command === 'string' ? record.command.trim() : undefined;
		if (command && SHELL_TOOLS.has(toolName)) {
			add(
				{ id: 'exact_command', label: `Yes, and don't ask again for exactly \`${ellipsis(command, 80)}\``, store: 'localSettings' },
				[{ type: 'addRules', rules: [{ toolName, ruleContent: command }], behavior: 'allow', destination: 'localSettings' }],
			);
		}
		// File tools: allow this one path for the session, which is narrower than
		// the engine's suggestion of accept-edits for everything.
		const filePath = firstString(record, ['file_path', 'path', 'notebook_path']);
		if (filePath) {
			add(
				{ id: 'exact_path', label: `Yes, and don't ask again for ${toolName} on ${ellipsis(basenameOf(filePath), 60)} this session`, store: 'session' },
				[{ type: 'addRules', rules: [{ toolName, ruleContent: filePath }], behavior: 'allow', destination: 'session' }],
			);
			const dir = dirname(filePath);
			if (dir && dir !== filePath) {
				add(
					{ id: 'exact_dir', label: `Yes, and don't ask again for ${toolName} in ${ellipsis(basenameOf(dir), 60)}/ this session`, store: 'session' },
					[{ type: 'addRules', rules: [{ toolName, ruleContent: `${dir}${dir.endsWith('/') || dir.endsWith('\\') ? '' : '/'}**` }], behavior: 'allow', destination: 'session' }],
				);
			}
		}
		// WebFetch/WebSearch and MCP tools have no path or command to narrow by, so
		// the only durable grant worth offering is the whole tool.
		add(
			{ id: 'tool_project', label: `Yes, and don't ask again for ${toolName} in this project`, store: 'localSettings' },
			[{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'localSettings' }],
		);
		return scopes;
	}

	/**
	 * Label the bundled-suggestions option using the same wording the CLI uses,
	 * so a user who has seen the terminal dialog recognises the choice.
	 */
	private _describeSuggestions(toolName: string, suggestions: readonly SdkPermissionUpdate[]): string | undefined {
		const rules = suggestions.flatMap(s => s.type === 'addRules' ? s.rules : []);
		const directories = suggestions.flatMap(s => s.type === 'addDirectories' ? s.directories : []);
		const readPaths = rules.filter(r => r.toolName === 'Read' && r.ruleContent).map(r => r.ruleContent!.replace(/\/\*\*$/, ''));
		const commands = [...new Set(rules
			.filter(r => SHELL_TOOLS.has(r.toolName) && r.ruleContent)
			.map(r => r.ruleContent!.replace(/:\*$/, '')))];
		const paths = [...directories, ...readPaths];
		if (commands.length > 0 && paths.length === 0) {
			const shown = commands.join(', ');
			const what = shown.length > 50 ? 'similar' : shown;
			return `Yes, and don't ask again for ${what} commands in ${this._lastCwd ?? 'this project'}`;
		}
		if (paths.length > 0 && commands.length === 0) {
			const names = paths.map(p => `${basenameOf(p)}/`).join(', ');
			return readPaths.length > 0 && directories.length === 0
				? `Yes, allow reading from ${ellipsis(names, 60)} in this project`
				: `Yes, and always allow access to ${ellipsis(names, 60)} in this project`;
		}
		if (paths.length > 0 && commands.length > 0) {
			return `Yes, and allow access to ${ellipsis(paths.map(p => `${basenameOf(p)}/`).join(', '), 40)} and ${ellipsis(commands.join(', '), 40)} commands`;
		}
		const mode = modeFromUpdates(suggestions);
		if (mode === 'acceptEdits') {
			return 'Yes, allow all edits during this session';
		}
		return mode ? `Yes, and switch to ${mode} for this session` : undefined;
	}

	// --- SDK message dispatch

	private _handleSdkMessage(msg: SdkMessage, queryId: string): void {
		const cur = this._states.get(queryId);
		if (!cur) { return; }

		switch (msg.type) {
			case 'system':
				if (msg.subtype === 'init') {
					cur.model = msg.model ?? cur.model;
					cur.sessionId = msg.session_id ?? cur.sessionId;
					this._captureMcpStatus(msg.mcp_servers, msg.tools);
					this._lastTools = msg.tools ?? this._lastTools;
					this._emit(queryId, { kind: 'system', model: cur.model, sessionId: cur.sessionId, tools: msg.tools });
				} else if (msg.subtype === 'local_command_output') {
					this._handleLocalCommandOutput(msg.content, cur);
				} else if (msg.subtype === 'compact_boundary') {
					// The engine compacted the session on its own part-way through the
					// turn. The panel has to hear about it: its idea of how full the
					// context is came from the previous turn and is now wrong.
					this._emit(queryId, { kind: 'compact_boundary', trigger: msg.compact_metadata?.trigger, preTokens: msg.compact_metadata?.pre_tokens });
				}
				break;

			case 'assistant':
				this._handleAssistantBlocks(msg, cur, msg.parent_tool_use_id ?? undefined);
				break;

			case 'user':
				this._handleUserMessage(msg, cur, msg.parent_tool_use_id ?? undefined);
				break;

			case 'stream_event':
				this._handleStreamEvent(msg.event, cur);
				break;

			case 'tool_progress':
				this._emit(queryId, { kind: 'tool_progress', toolUseId: msg.tool_use_id, toolName: msg.tool_name, elapsedSeconds: msg.elapsed_time_seconds, parentToolUseId: msg.parent_tool_use_id ?? undefined });
				break;

			case 'result':
				this._finalize(msg, cur, queryId);
				break;

			// auth_status / hook_response are informational; ignore them for the UI
			// stream. compact_boundary is handled above, under `system`.
		}
	}

	/**
	 * Show what a slash command the engine ran itself printed.
	 *
	 * Current engine builds report this as a synthetic assistant message (the
	 * `local_command_output` subtype is unknown to their other consumers), so this
	 * branch normally never fires. Handling it too costs nothing and means a
	 * command's output is still shown if a build switches to the typed message.
	 */
	private _handleLocalCommandOutput(content: string | undefined, cur: QueryState): void {
		const text = unwrapLocalCommandOutput(content ?? '');
		if (!text) { return; }
		cur.text += cur.text ? `\n\n${text}` : text;
		this._emitAssistantText(cur);
	}

	/**
	 * Send the turn's accumulated text to the panel, as an error when it is one.
	 *
	 * Every text emit goes through here so the two forms cannot disagree: a turn
	 * that starts with `API Error:` is only ever emitted as `error`, so the panel
	 * never has to take back an answer it has already shown.
	 */
	private _emitAssistantText(cur: QueryState): void {
		const verdict = apiErrorVerdict(cur.text);
		if (verdict === 'maybe') { return; } // still too short to tell; the next delta decides
		if (verdict === 'yes') {
			cur.isApiError = true;
			this._emit(cur.queryId, { kind: 'error', text: cur.text });
			return;
		}
		this._emit(cur.queryId, { kind: 'text', text: cur.text });
	}

	/**
	 * @param parentToolUseId set when this turn belongs to a sub-agent, in which
	 * case its text and tools are reported under the Task that spawned it instead
	 * of being folded into the main answer.
	 */
	private _handleAssistantBlocks(msg: Extract<SdkMessage, { type: 'assistant' }>, cur: QueryState, parentToolUseId?: string): void {
		const content = msg.message?.content ?? [];
		// If we already received streaming deltas for this turn, the assistant
		// block is a complete replay — skip text/thinking/tool_use_start to avoid
		// double-rendering. Tool results and metadata are still captured.
		// Sub-agent turns are never streamed as deltas, so they always emit.
		const skipEmit = cur.sawDelta && !parentToolUseId;
		for (const block of content) {
			if (block.type === 'text') {
				const blockText = this._dropPlaceholder(block.text ?? '');
				if (parentToolUseId) {
					const text = `${cur.agentText.get(parentToolUseId) ?? ''}${blockText}`;
					cur.agentText.set(parentToolUseId, text);
					this._emit(cur.queryId, { kind: 'agent_text', parentToolUseId, text });
					continue;
				}
				// With `includePartialMessages` the same prose arrives twice — once as
				// deltas and once as this replay block. Appending both would double the
				// turn's text, so the replay only counts when the deltas missed it.
				if (blockText && (!skipEmit || !cur.text.endsWith(blockText))) {
					cur.text += blockText;
					if (!skipEmit) { this._emitAssistantText(cur); }
				}
			} else if (block.type === 'thinking') {
				const t = block.thinking ?? block.text ?? '';
				if (parentToolUseId) {
					continue; // a sub-agent's reasoning stays inside the sub-agent
				}
				if (t && (!skipEmit || !cur.thinking.endsWith(t))) {
					cur.thinking += t;
					if (!skipEmit) { this._emit(cur.queryId, { kind: 'thinking', text: cur.thinking }); }
				}
			} else if (block.type === 'tool_use') {
				// Only main-stream calls go in the map: it exists to match
				// `input_json_delta` events, which sub-agent turns never produce.
				if (!parentToolUseId) {
					cur.tools.set(block.id, { name: block.name, inputJson: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}, null, 2) });
				}
				if (!skipEmit) {
					this._emit(cur.queryId, { kind: 'tool_use_start', toolUseId: block.id, toolName: block.name, input: block.input, parentToolUseId });
				} else {
					// The streamed `tool_use_start` went out before the arguments did, so
					// this replay is the first and only place the panel can see them as an
					// object. Without it the Tasks panel and the task list in the system
					// prompt never learn what TodoWrite wrote.
					this._emit(cur.queryId, { kind: 'tool_use_input', toolUseId: block.id, toolName: block.name, input: block.input, parentToolUseId });
				}
			}
		}
		// Capture session identity for multi-turn resume.
		if (msg.session_id) { cur.sessionId = msg.session_id; }
		if (cur.model === undefined) { /* model is usually on the system/init message */ }
	}

	private _handleUserMessage(msg: Extract<SdkMessage, { type: 'user' }>, cur: QueryState, parentToolUseId?: string): void {
		const content = msg.message?.content ?? [];
		// A server-side tool — WebFetch, WebSearch — reports a failed request inside its
		// own payload rather than on the block: `is_error` stays unset. `tool_use_result.code`
		// is checked here because a non-2xx status there is unambiguous, but it is not
		// sufficient: a request the API refused still arrives as `code: 200` with the real
		// status in the result text, which is why the card also reads that text.
		const extraPayload = msg.tool_use_result as { tool_use_id?: string; content?: unknown; code?: unknown } | undefined;
		const httpStatus = typeof extraPayload?.code === 'number' ? extraPayload.code : undefined;
		const httpFailed = httpStatus !== undefined && httpStatus >= 400;
		// Tool results come back as `tool_result` blocks on a user message. The block is
		// the authoritative form: it names the call it answers and says whether the call
		// failed, and a card is matched to its call by that id.
		let emittedResult = false;
		for (const block of content) {
			if (block.type === 'tool_result') {
				const br = block as { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };
				this._emit(cur.queryId, { kind: 'tool_result', toolUseId: br.tool_use_id, content: this._stripReminders(this._stringify(br.content)), isError: br.is_error === true || httpFailed, parentToolUseId });
				emittedResult = true;
			}
		}
		// `tool_use_result` is the engine's own copy of the same payload, and in this SDK
		// build it carries no `tool_use_id`. It is a fallback for a message that had no
		// block, and only when it does name the call — an id-less result would leave the
		// card it belongs to running for ever and add a phantom one beside it.
		if (!emittedResult) {
			const extra = extraPayload;
			if (extra && typeof extra.tool_use_id === 'string' && extra.tool_use_id) {
				this._emit(cur.queryId, { kind: 'tool_result', toolUseId: extra.tool_use_id, content: this._stripReminders(this._stringify(extra.content)), isError: httpFailed, parentToolUseId });
			}
		}
		// The engine echoes the prompt back with the uuid its file checkpoint is
		// keyed by. That uuid is what /rewind needs, so remember it — but not for
		// isolated side questions, which change nothing to roll back, and not for
		// a sub-agent's own turns, which the user never typed.
		if (msg.uuid && !msg.isSynthetic && !cur.isolated && !parentToolUseId) {
			const text = content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n');
			if (text.trim()) {
				this._recordCheckpoint(cur.projectKey, msg.uuid, text);
			}
		}
	}

	private _handleStreamEvent(event: { type: string; [key: string]: unknown }, cur: QueryState): void {
		cur.sawDelta = true;
		const t = event.type;
		if (t === 'message_start') {
			// One API call's own prompt size, which is what "how full is the context"
			// means. Kept as a maximum rather than a sum: the calls inside a turn share
			// a prompt that grows, so the last one is the high-water mark.
			const usage = (event.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined)?.usage;
			if (usage) {
				const callContext = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
				// A `usage` that reports nothing is not a measurement of nothing. Some
				// gateways forward `message_start` with the counts stripped, and recording
				// the zero would both park the meter at 0% and stop auto-compaction from
				// ever firing — the turn after that is the one the API refuses for being
				// too long. Leaving it unset lets the renderer fall back to the result's
				// own usage instead.
				if (callContext > 0) {
					cur.contextTokens = Math.max(cur.contextTokens ?? 0, callContext);
				}
			}
			return;
		}
		if (t === 'content_block_start') {
			// Raw Anthropic stream events are typed loosely by the SDK, so the two
			// shapes this handler reads are narrowed here rather than trusted wholesale.
			const block = (event.content_block ?? event.block) as { type?: string; id?: string; name?: string } | undefined;
			if (block?.type === 'tool_use' && block.id) {
				cur.tools.set(block.id, { name: block.name ?? 'tool', inputJson: '' });
				this._emit(cur.queryId, { kind: 'tool_use_start', toolUseId: block.id, toolName: block.name ?? 'tool' });
			}
		} else if (t === 'content_block_delta') {
			const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
			if (!delta) { return; }
			if (delta.type === 'text_delta') {
				cur.text += delta.text ?? '';
				this._emitAssistantText(cur);
			} else if (delta.type === 'thinking_delta') {
				cur.thinking += delta.thinking ?? delta.text ?? '';
				this._emit(cur.queryId, { kind: 'thinking', text: cur.thinking });
			} else if (delta.type === 'input_json_delta') {
				const tool = this._toolNeedingInput(cur);
				if (tool) {
					// `tool.entry` is the live map entry, so the fragments accumulate. A copy
					// here would leave every delta reporting only its own fragment, and the
					// panel would never be able to parse the call's arguments.
					tool.entry.inputJson += delta.partial_json ?? '';
					this._emit(cur.queryId, { kind: 'tool_use_delta', toolUseId: tool.id, partialJson: tool.entry.inputJson });
				}
			}
		}
	}

	private _toolNeedingInput(cur: { tools: Map<string, { name: string; inputJson: string }> }): { id: string; entry: { name: string; inputJson: string } } | undefined {
		let lastId: string | undefined;
		for (const [id, tool] of cur.tools) {
			lastId = id;
			if (!tool.inputJson) { return { id, entry: tool }; }
		}
		if (lastId) { return { id: lastId, entry: cur.tools.get(lastId)! }; }
		return undefined;
	}

	private _finalize(msg: Extract<SdkMessage, { type: 'result' }>, cur: QueryState, queryId: string): void {
		// Persist the session id and running cost for multi-turn resume within this project.
		// An isolated turn still contributes its cost (the money was spent) but must
		// not become the session the next visible turn resumes.
		const sessionId = msg.session_id ?? cur.sessionId;
		const turnCost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined;
		if ((sessionId && !cur.isolated) || turnCost !== undefined) {
			const prev = this._sessions.get(cur.projectKey) ?? {};
			if (sessionId && !cur.isolated) {
				prev.sessionId = sessionId;
			}
			if (turnCost !== undefined) {
				// The SDK reports the cost of this turn; sum it across the session.
				prev.totalCostUsd = (prev.totalCostUsd ?? 0) + turnCost;
			}
			this._sessions.set(cur.projectKey, prev);
		}

		// `is_error` is false for an endpoint or credential failure — the engine treats
		// having relayed the API's complaint as a successful turn — so the verdict the
		// text emits reached counts here too.
		const isError = msg.is_error === true || cur.isApiError === true;
		const resultText = this._dropPlaceholder(typeof msg.result === 'string' ? msg.result : cur.text)
			|| (isError ? 'Engine returned an error.' : 'No response.');
		const u = msg.usage ?? {};
		const usage: ICodeMindEngineUsage | undefined = (u.input_tokens != null || u.output_tokens != null)
			? { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheCreationInputTokens: u.cache_creation_input_tokens, cacheReadInputTokens: u.cache_read_input_tokens }
			: undefined;
		const model = cur.model;
		if (usage) {
			this._accumulateUsage(cur.projectKey, usage, msg.duration_ms ?? msg.duration_api_ms, model, cur.isolated === true);
		}
		const response: ICodeMindEngineResponse = {
			text: resultText, model, sessionId,
			usage, totalCostUsd: msg.total_cost_usd ?? msg.cost_usd,
			durationMs: msg.duration_ms ?? msg.duration_api_ms, isError,
		};
		this._emit(queryId, { kind: 'result', text: resultText, isError, usage, totalCostUsd: response.totalCostUsd, durationMs: response.durationMs, sessionId, contextTokens: cur.contextTokens });
		const pending = this._pending.get(queryId);
		this._pending.delete(queryId);
		this._states.delete(queryId);
		if (pending) { pending.resolve(response); }
	}

	/**
	 * Add a finished turn's usage to the session totals. The engine reports these
	 * per turn and never cumulatively, so `/usage`, `/cost` and `/stats` can only
	 * be honest about the session if the worker keeps the running sum.
	 */
	private _accumulateUsage(projectKey: string, usage: ICodeMindEngineUsage, durationMs: number | undefined, model: string | undefined, isolated: boolean): void {
		const state = this._sessions.get(projectKey) ?? {};
		const prev = state.usage;
		// Fresh input plus cache reads is what the request actually carried, which is
		// the closest a turn's usage comes to reporting context window pressure. An
		// isolated side question runs on its own tiny context, so it must not be
		// mistaken for the conversation's size — its tokens still count towards the
		// totals, because they were still spent.
		const lastRequestTokens = usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
		state.usage = {
			turns: (prev?.turns ?? 0) + 1,
			inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
			outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
			cacheReadInputTokens: (prev?.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
			cacheCreationInputTokens: (prev?.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
			totalDurationMs: (prev?.totalDurationMs ?? 0) + (durationMs ?? 0),
			lastRequestTokens: isolated ? prev?.lastRequestTokens : lastRequestTokens,
			lastModel: (isolated ? prev?.lastModel : model) ?? prev?.lastModel,
		};
		this._sessions.set(projectKey, state);
	}

	private _stringify(content: unknown): string {
		if (typeof content === 'string') { return content; }
		if (Array.isArray(content)) {
			// Tool results arrive as content blocks; text blocks read best as text and
			// everything else (images, resources) is shown as its raw shape.
			return content.map(part => {
				const text = (part as { text?: unknown } | null)?.text;
				return typeof text === 'string' ? text : JSON.stringify(part);
			}).join('\n');
		}
		if (content && typeof content === 'object') { return JSON.stringify(content, null, 2); }
		return String(content ?? '');
	}

	/**
	 * Append one JSONL record to the engine log, if the user asked for one by setting
	 * `CODEMIND_ENGINE_LOG` to a file path. Nothing consumes this process's stdout, so
	 * a file is the only way to see what the SDK actually sent us.
	 *
	 * Two rules hold for every caller: the record is best-effort (a log that cannot be
	 * written must never break a turn), and no secret goes in it — callers pass shapes
	 * and counts, and `_redact` scrubs anything key-shaped that slips through.
	 */
	private _trace(kind: string, data?: Record<string, unknown>): void {
		const path = process.env['CODEMIND_ENGINE_LOG'];
		if (!path) { return; }
		try {
			const safe = this._redact(data ?? {}) as Record<string, unknown>;
			appendFileSync(path, JSON.stringify({ t: new Date().toISOString(), kind, ...safe }) + '\n');
		} catch {
			// A broken log path is not a reason to lose the turn.
		}
	}

	/**
	 * Drop anything that could carry a credential before it reaches the log: values
	 * under a key-ish name, and any string holding an `sk-`-prefixed token.
	 */
	private _redact(value: unknown, depth = 0): unknown {
		if (typeof value === 'string') {
			return value.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
		}
		if (!value || typeof value !== 'object' || depth > 4) { return value; }
		if (Array.isArray(value)) { return value.slice(0, 40).map(v => this._redact(v, depth + 1)); }
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			out[key] = /key|token|secret|password|authorization|^env$/i.test(key) ? '***' : this._redact(val, depth + 1);
		}
		return out;
	}

	/**
	 * Drop the engine's `<system-reminder>` blocks from a tool result before the panel
	 * shows it. They are instructions the engine appends for the model — the malware
	 * notice on every file read, for one — and they are not part of what the tool
	 * returned. The model still receives them; only the card is cleaned up.
	 */
	private _stripReminders(text: string): string {
		if (!text.includes('<system-reminder>')) { return text; }
		return text.replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/g, '\n').trim();
	}

	/** Remove the engine's empty-content placeholder from text on its way to the panel. */
	private _dropPlaceholder(text: string): string {
		if (!text.includes(SDK_EMPTY_CONTENT_PLACEHOLDER)) { return text; }
		let out = text.split('\n').filter(line => line.trim() !== SDK_EMPTY_CONTENT_PLACEHOLDER).join('\n');
		// A gateway that packs the placeholder and the answer into one block leaves it as
		// a prefix rather than a line of its own.
		while (out.trimStart().startsWith(SDK_EMPTY_CONTENT_PLACEHOLDER)) {
			out = out.trimStart().slice(SDK_EMPTY_CONTENT_PLACEHOLDER.length);
		}
		return out.replace(/^\s+/, '');
	}

	private _emit(queryId: string, event: ICodeMindEngineEvent): void {
		this._onEvent.fire({ queryId, event });
	}

	private _rejectPending(reason: Error): void {
		for (const [, entry] of this._pending) { entry.reject(reason); }
		this._pending.clear();
		this._pendingPermissions.clear();
		this._states.clear();
	}

	private _detectEngineRoot(): string | undefined {
		// In the utility process, appRoot isn't available via IWorkbenchEnvironmentService.
		// Anchor on the location of this module's compiled output and climb to find the
		// sibling 'claude-code' directory. Use import.meta.url (ESM-safe) instead of
		// __dirname, which is undefined in the ESM utility process.
		let dir = dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 12; i++) {
			const candidate = resolve(dir, '..', 'claude-code');
			try {
				if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'src', 'entrypoints', 'cli.tsx'))) {
					return candidate;
				}
			} catch { /* ignore */ }
			const parent = dirname(dir);
			if (parent === dir) { break; }
			dir = parent;
		}
		return undefined;
	}

	override dispose(): void {
		this._rejectPending(new Error('Engine disposed'));
		this._onEvent.dispose();
		super.dispose();
	}
}

// --- utility process entry: host the service on an IPC channel

let server: ChildProcessServer<string> | UtilityProcessServer;
if (isUtilityProcess(process)) {
	server = new UtilityProcessServer();
} else {
	server = new ChildProcessServer('codeMindAgentEngine');
}

const service = new CodeMindAgentEngineMainService();
server.registerChannel('codeMindAgentEngine', ProxyChannel.fromService(service, new DisposableStore()));
