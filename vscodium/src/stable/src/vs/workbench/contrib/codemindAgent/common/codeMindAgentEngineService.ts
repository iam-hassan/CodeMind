/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Shared protocol types between the CodeMind Agent panel and the Claude Code engine.
 *
 * The engine is driven by the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
 * from the node-side utility process worker (see node/codeMindAgentEngineMain.ts).
 * The renderer-side service is a thin proxy that forwards calls over IPC.
 */

/** A file or image the user attached to a prompt. */
export interface ICodeMindEngineAttachment {
	readonly kind: 'file' | 'image';
	readonly name: string;
	/** Absolute workspace path, when the attachment came from the file system. */
	readonly path?: string;
	/** `data:<mime>;base64,<payload>` — set for pasted/picked images. */
	readonly dataUrl?: string;
}

export interface ICodeMindEngineRequest {
	readonly prompt: string;
	readonly cwd?: string;
	/** Session id to resume; omitted to start a fresh session. */
	readonly sessionId?: string;
	/** Extra system prompt text appended to the engine's own system prompt. */
	readonly systemPromptSuffix?: string;
	readonly history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
	/** Classified intent (CodeMind FYP Feature 2). Optional metadata only. */
	readonly intent?: { id: string; label: string };
	/** Files and images attached to this turn. */
	readonly attachments?: ReadonlyArray<ICodeMindEngineAttachment>;
	/** When true the engine runs read-only: no edits, no commands. */
	readonly planMode?: boolean;
	/** Per-turn overrides used by side questions (`/btw`). */
	readonly turnOverrides?: ICodeMindTurnOverrides;
}

/**
 * Overrides that apply to a single turn instead of the whole session. Used by
 * `/btw`, which asks a one-shot side question that must not touch the workspace
 * or become part of the main conversation.
 */
export interface ICodeMindTurnOverrides {
	/** Cap on tool round trips for this turn only. */
	readonly maxTurns?: number;
	/** Deny every tool call, so the model can only answer from what it already knows. */
	readonly blockAllTools?: boolean;
	/** Neither resume the workspace session nor record the one this turn creates. */
	readonly isolated?: boolean;
}

/** Sandbox restrictions applied to the commands the agent runs. */
export interface ICodeMindSandboxSettings {
	readonly enabled?: boolean;
	/** Skip the permission prompt for commands that do run sandboxed. */
	readonly autoAllowBashIfSandboxed?: boolean;
	/** Let a command that cannot be sandboxed run outside it. */
	readonly allowUnsandboxedCommands?: boolean;
	readonly excludedCommands?: readonly string[];
}

/** How much reasoning the agent spends per turn. `auto` leaves it to the model. */
export type CodeMindEffortLevel = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Engine-wide settings the settings panel can change. */
export interface ICodeMindEngineSettings {
	readonly model?: string;
	/**
	 * Anthropic-compatible endpoint the engine talks to, e.g. a gateway or a
	 * self-hosted proxy. Empty or unset means the official API (or whatever
	 * `ANTHROPIC_BASE_URL` the process was started with).
	 */
	readonly baseUrl?: string;
	/**
	 * Model the engine falls back to when the primary one is overloaded or the
	 * account is out of capacity for it. Empty means no fallback.
	 */
	readonly fallbackModel?: string;
	readonly maxTurns?: number;
	readonly maxThinkingTokens?: number;
	readonly systemPrompt?: string;
	readonly permissionMode?: string;
	/** Reasoning budget preset. Ignored when `maxThinkingTokens` is set explicitly. */
	readonly effort?: CodeMindEffortLevel;
	/** Ask the provider for faster output from the same model. */
	readonly fastMode?: boolean;
	/** A second model the agent may consult for advice. Omitted or '' disables it. */
	readonly advisorModel?: string;
	readonly sandbox?: ICodeMindSandboxSettings;
	/**
	 * Which settings files the engine loads. Without `project` the engine runs in
	 * isolation mode and CLAUDE.md, project hooks and project skills are ignored.
	 */
	readonly settingSources?: readonly ('user' | 'project' | 'local')[];
}

/**
 * How the user answered a permission request.
 *
 * `allow_scope` carries a {@link ICodeMindPermissionScope.id} in the answer's
 * detail and grants exactly that scope; `allow_session` is the blunter
 * "stop asking about this tool entirely for now" whitelist.
 */
export type CodeMindPermissionDecision = 'allow_once' | 'allow_scope' | 'allow_session' | 'deny';

/**
 * Where a scoped grant is remembered. `session` lives in the worker for as long
 * as the conversation does; the others are settings files the engine writes.
 */
export type CodeMindPermissionScopeStore = 'session' | 'localSettings' | 'projectSettings' | 'userSettings';

/**
 * One "…and don't ask again" option offered next to a permission request.
 *
 * The worker derives these from the rules the engine itself suggested, so
 * accepting one grants precisely what the CLI would have granted. The webview
 * only ever echoes {@link id} back; it never composes a rule of its own.
 */
export interface ICodeMindPermissionScope {
	/** Opaque id, echoed back as {@link ICodeMindPermissionAnswer.scopeId}. */
	readonly id: string;
	/** Button text, e.g. "Yes, and don't ask again for git status commands in …". */
	readonly label: string;
	/** Where the grant is remembered, shown as a caption under the button. */
	readonly store: CodeMindPermissionScopeStore;
	/** Set when accepting this option also switches the permission mode. */
	readonly mode?: string;
}

/** The extra detail a permission answer can carry beyond the decision itself. */
export interface ICodeMindPermissionAnswer {
	/** Which of the offered scopes was picked. Required for `allow_scope`. */
	readonly scopeId?: string;
	/** "…and tell Claude what to do differently" — forwarded to the model. */
	readonly feedback?: string;
}

/** An MCP server the engine should connect to. */
export interface ICodeMindMcpServer {
	readonly name: string;
	readonly type?: 'stdio' | 'sse' | 'http';
	readonly command?: string;
	readonly args?: readonly string[];
	readonly url?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly enabled?: boolean;
	/** Last known connection state, learned from the engine's init message. */
	readonly status?: 'connected' | 'disconnected' | 'error' | 'unknown';
	/** Tool names this server contributed, learned from the engine's init message. */
	readonly tools?: readonly string[];
}

/** A single process execution requested by a slash command. */
export interface ICodeMindExecRequest {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	/** Written to the child's stdin, then stdin is closed. */
	readonly input?: string;
	/** Hard timeout in milliseconds. Defaults to 60s. */
	readonly timeoutMs?: number;
}

export interface ICodeMindExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Set when the process could not be started at all. */
	readonly error?: string;
}

/**
 * A command line the user typed themselves into the panel's shell mode (`!`).
 *
 * Unlike {@link ICodeMindExecRequest} this *is* handed to the platform shell,
 * because `!cd build && make` cannot be reproduced without one — that is the
 * whole point of the mode. It is only ever reachable from text the user typed
 * into their own workspace's panel, never from model output, which puts it at
 * the same trust level as the integrated terminal.
 */
export interface ICodeMindShellRequest {
	readonly command: string;
	readonly cwd?: string;
	/** Hard timeout in milliseconds. Defaults to 60s. */
	readonly timeoutMs?: number;
}

/** One environment check reported by {@link ICodeMindAgentEngineService.doctor}. */
export interface ICodeMindDoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

/** Result of {@link ICodeMindAgentEngineService.heapSnapshot}. */
export interface ICodeMindHeapSnapshotResult {
	/** Absolute path of the written `.heapsnapshot` file. */
	readonly path?: string;
	/** Set instead of `path` when the snapshot could not be written. */
	readonly error?: string;
}

/** The account the engine is authenticated as, as reported by the engine. */
export interface ICodeMindAccountInfo {
	readonly email?: string;
	readonly organization?: string;
	readonly subscriptionType?: string;
	readonly tokenSource?: string;
	readonly apiKeySource?: string;
}

/** One model the engine reports as available. */
export interface ICodeMindModelInfo {
	readonly value: string;
	readonly displayName: string;
	readonly description: string;
}

/**
 * A configured Anthropic-compatible provider: an endpoint the engine can talk to,
 * plus the models the user curated from it for the composer picker. The API key is
 * never part of this shape — it lives in secret storage keyed by {@link id}.
 */
export interface ICodeMindProvider {
	/** Stable id; also the secret-storage key suffix and the active-provider selector. */
	readonly id: string;
	/** Display name, e.g. "Anthropic". */
	readonly name: string;
	/** Base URL; '' means the official API / launch-environment ANTHROPIC_BASE_URL. */
	readonly baseUrl: string;
	/** Model ids/aliases the user curated for this provider; these fill the picker. */
	readonly models: readonly string[];
	/** Whether this provider can be made active. */
	readonly enabled: boolean;
	/**
	 * Protocol the endpoint speaks, as determined by "Fetch models": `anthropic`
	 * (`/v1/messages`) or `openai` (`/v1/chat/completions`). Absent on providers saved
	 * before detection existed, or added by hand — treat that as "not yet known"
	 * rather than as Anthropic. Only `anthropic` endpoints can serve a turn today;
	 * the engine has no OpenAI translation layer.
	 */
	readonly wire?: 'anthropic' | 'openai';
}

/**
 * What a key/endpoint check found out.
 *
 * A custom endpoint can fail in ways a plain boolean cannot express — wrong host,
 * no route for `/v1/messages`, a gateway that answers 502 — and the dialog has to
 * say which, because "rejected" would send the user hunting for a new key when the
 * URL is what is wrong. `endpoint` is the base URL that was tested and never
 * carries the key.
 */
export interface ICodeMindEndpointCheck {
	/** The key was accepted (or at least not rejected) by the endpoint. */
	readonly ok: boolean;
	/** HTTP status, when the endpoint answered at all. */
	readonly status?: number;
	/** Short human-readable reason, suitable for a system message. */
	readonly detail: string;
	/** Base URL that was tested. */
	readonly endpoint: string;
}

/**
 * A slash command the engine itself provides — its built-ins plus everything
 * `.claude/commands/`, plugins and skills contribute. The panel merges these into
 * its own command menu so project commands are discoverable, not just typeable.
 */
export interface ICodeMindEngineCommandInfo {
	readonly name: string;
	readonly description: string;
	/** Placeholder text for the command's arguments, e.g. `<branch>`. */
	readonly argumentHint: string;
}

/**
 * A point the workspace can be rewound to — one user turn. The engine keys its
 * file checkpoints by the uuid of the user message that started the turn.
 */
export interface ICodeMindCheckpoint {
	readonly uuid: string;
	/** Short label for the picker, taken from the prompt that started the turn. */
	readonly label: string;
	/** When the turn started, ms since epoch. */
	readonly at: number;
}

/**
 * What one of the engine's own slash commands printed.
 *
 * The engine implements a handful of commands itself (`/context`, `/compact`,
 * `/version`, `/release-notes`). Running them there instead of reimplementing
 * them is the only way to report the engine's real state rather than the
 * panel's estimate of it.
 */
export interface ICodeMindEngineCommandResult {
	/** Everything the command printed, already stripped of its wrapper tags. */
	readonly text: string;
	readonly isError: boolean;
	/** Set when the command failed before the engine could run it. */
	readonly error?: string;
	/** Set when the command compacted the conversation. */
	readonly compacted?: { readonly trigger: string; readonly preTokens: number };
	readonly sessionId?: string;
}

/**
 * Token and cost totals the engine reported for this workspace's session,
 * summed over the turns this panel has run.
 */
export interface ICodeMindSessionUsage {
	readonly turns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadInputTokens: number;
	readonly cacheCreationInputTokens: number;
	readonly totalCostUsd?: number;
	readonly totalDurationMs: number;
	/**
	 * Tokens the last request actually carried (fresh input plus cache reads) —
	 * the closest thing to "how full is the context window" that a turn reports.
	 */
	readonly lastRequestTokens?: number;
	readonly lastModel?: string;
}

// --- context window pressure
//
// The numbers below are the engine's own (`services/compact/autoCompact.ts` and
// `utils/context.ts`); they live here so the panel measures context the same way
// the CLI does instead of guessing.

/**
 * Window assumed for a model whose real one we cannot ask about. The engine uses
 * the same figure whenever its capability table has no entry for the model, and
 * every current Claude model is at least this large.
 */
export const CODEMIND_CONTEXT_WINDOW_DEFAULT = 200_000;

/** Window for a model explicitly opted into the long-context beta (`opus[1m]`). */
export const CODEMIND_CONTEXT_WINDOW_1M = 1_000_000;

/**
 * Held back so a compaction always has room to write its summary. The engine
 * reserves `min(model max output, 20k)`, and every model it currently ships with
 * has a larger output limit than that, so the cap is what applies.
 */
export const CODEMIND_SUMMARY_RESERVE_TOKENS = 20_000;

/** How far below the effective window auto-compaction triggers. */
export const CODEMIND_AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/**
 * How far below the threshold the panel starts warning. The engine uses the same
 * buffer for its warning and error tiers, so the first warning already shows in
 * the error colour — mirrored here rather than invented.
 */
export const CODEMIND_WARNING_BUFFER_TOKENS = 20_000;

/** Below this much headroom a turn is refused outright rather than warned about. */
export const CODEMIND_BLOCKING_BUFFER_TOKENS = 3_000;

/** How full the context window is, and what the panel should do about it. */
export interface ICodeMindContextStatus {
	/** Tokens the last request carried: fresh input plus cache reads and writes. */
	readonly usedTokens: number;
	/** The model's whole window, which `percentUsed` is measured against. */
	readonly contextWindow: number;
	/** The window minus the summary reserve — all a conversation can really use. */
	readonly effectiveWindow: number;
	/** Where compaction happens, and what `percentLeft` is measured against. */
	readonly threshold: number;
	/** Headroom left before the threshold, as the CLI's warning reports it. */
	readonly percentLeft: number;
	/** Share of the whole window in use, as the CLI's status line reports it. */
	readonly percentUsed: number;
	readonly level: 'ok' | 'warning' | 'blocked';
	/** True once the threshold is crossed and auto-compaction is allowed. */
	readonly shouldAutoCompact: boolean;
	readonly autoCompactEnabled: boolean;
	readonly model?: string;
}

/**
 * Work out context pressure from the tokens a turn reported.
 *
 * With auto-compaction off there is nothing between the conversation and the
 * effective window, so headroom is measured against that instead — which is what
 * makes the warning appear later, and matter more, when the user has opted out.
 */
export function calculateContextStatus(usedTokens: number, model: string | undefined, autoCompactEnabled: boolean): ICodeMindContextStatus {
	const contextWindow = /\[1m\]/i.test(model ?? '') ? CODEMIND_CONTEXT_WINDOW_1M : CODEMIND_CONTEXT_WINDOW_DEFAULT;
	const effectiveWindow = contextWindow - CODEMIND_SUMMARY_RESERVE_TOKENS;
	const autoCompactThreshold = effectiveWindow - CODEMIND_AUTOCOMPACT_BUFFER_TOKENS;
	const threshold = autoCompactEnabled ? autoCompactThreshold : effectiveWindow;

	const percentLeft = Math.max(0, Math.round(((threshold - usedTokens) / threshold) * 100));
	const percentUsed = Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100)));

	const isBlocked = usedTokens >= effectiveWindow - CODEMIND_BLOCKING_BUFFER_TOKENS;
	const isWarning = usedTokens >= threshold - CODEMIND_WARNING_BUFFER_TOKENS;

	return {
		usedTokens,
		contextWindow,
		effectiveWindow,
		threshold,
		percentLeft,
		percentUsed,
		level: isBlocked ? 'blocked' : (isWarning ? 'warning' : 'ok'),
		shouldAutoCompact: autoCompactEnabled && usedTokens >= autoCompactThreshold,
		autoCompactEnabled,
		model,
	};
}

/** Result of rewinding (or previewing a rewind of) the workspace files. */
export interface ICodeMindRewindResult {
	readonly canRewind: boolean;
	readonly error?: string;
	readonly filesChanged?: readonly string[];
	readonly insertions?: number;
	readonly deletions?: number;
}


export interface ICodeMindEngineUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheCreationInputTokens?: number;
	readonly cacheReadInputTokens?: number;
}

export interface ICodeMindEngineResponse {
	readonly text: string;
	readonly model?: string;
	readonly sessionId?: string;
	readonly usage?: ICodeMindEngineUsage;
	readonly totalCostUsd?: number;
	readonly durationMs?: number;
	readonly isError?: boolean;
}

/**
 * A parsed, UI-ready event streamed from the engine.
 *
 * `parentToolUseId` is set when the event came from a sub-agent — the engine
 * reports a Task's inner turns as ordinary messages tagged with the Task's tool
 * id, and the panel nests them inside that tool's card.
 */
export type ICodeMindEngineEvent =
	| { kind: 'system'; model?: string; sessionId?: string; tools?: string[] }
	| { kind: 'text'; text: string }                      // assistant text block, accumulating (cumulative, not a delta)
	// A turn that is a failure rather than an answer: the engine does not reject the
	// stream when the endpoint refuses the request or the key is bad — it sends back an
	// ordinary assistant turn carrying the API's own message ("API Error: 401 …") and a
	// `result` of subtype success, and only later exits non-zero. Accumulating like
	// `text`, and mutually exclusive with it for a given turn.
	| { kind: 'error'; text: string }
	| { kind: 'thinking'; text: string }                  // thinking block, accumulating (cumulative, not a delta)
	| { kind: 'agent_text'; parentToolUseId: string; text: string }   // a sub-agent's own text, accumulating
	| { kind: 'tool_use_start'; toolUseId: string; toolName: string; input?: unknown; parentToolUseId?: string }
	| { kind: 'tool_use_delta'; toolUseId: string; partialJson: string }
	// The finished input for a call whose `tool_use_start` was streamed, and so went
	// out before the arguments existed. The panel rebuilds the card from the deltas;
	// this is for the bookkeeping that needs the arguments as an object rather than a
	// string, and it carries no rendering of its own.
	| { kind: 'tool_use_input'; toolUseId: string; toolName: string; input: unknown; parentToolUseId?: string }
	| { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean; parentToolUseId?: string }
	| { kind: 'tool_progress'; toolUseId: string; toolName: string; elapsedSeconds: number; parentToolUseId?: string }
	| {
		kind: 'permission_request';
		toolUseId: string;
		toolName: string;
		input?: unknown;
		/** "Don't ask again" options, built from the engine's own suggestions. */
		scopes?: readonly ICodeMindPermissionScope[];
		/** The path that put the tool behind a prompt, when the engine named one. */
		blockedPath?: string;
		/** Why the engine asked, when it said. */
		reason?: string;
		/** Set when a sub-agent asked, so the dialog can say which one. */
		agentId?: string;
	}
	// The engine compacted the conversation mid-turn: everything before this point
	// is now a summary. The panel needs it to stop showing stale context pressure
	// and to know it must not compact again itself.
	| { kind: 'compact_boundary'; trigger?: string; preTokens?: number }
	| { kind: 'result'; text: string; isError: boolean; usage?: ICodeMindEngineUsage; totalCostUsd?: number; durationMs?: number; sessionId?: string; contextTokens?: number }

	// Phase 2 Orchestration events
	| {
		kind: 'orchestration_progress';
		queryId: string;
		phase: string;
		status: 'running' | 'complete' | 'failed' | 'cache_hit' | 'timeout';
		toolId?: string;
		intent?: string;
		durationMs?: number;
		message?: string;
	}
	| {
		kind: 'orchestration_trace';
		queryId: string;
		trace: unknown; // JSON-safe OrchestrationTrace object
	};

/** A query stream is identified by an id so events can be correlated. */
export interface ICodeMindEngineQueryStart {
	readonly queryId: string;
	readonly request: ICodeMindEngineRequest;
}

export const ICodeMindAgentEngineService = createDecorator<ICodeMindAgentEngineService>('codeMindAgentEngineService');

export interface ICodeMindAgentEngineService {
	readonly _serviceBrand: undefined;

	/** Streamed engine events, each carrying the queryId they belong to. */
	readonly onEvent: Event<{ queryId: string; event: ICodeMindEngineEvent }>;

	/** Resolves to a human-readable error string, or undefined if the engine is usable. */
	diagnose(): Promise<string | undefined>;

	/**
	 * Persist a provider's API key into secret storage. With no `providerId` the
	 * active provider's key is written (falling back to the legacy single-key slot).
	 */
	storeApiKey(key: string, providerId?: string): Promise<void>;

	/** Remove a provider's stored API key (active provider when `providerId` is omitted). */
	deleteApiKey(providerId?: string): Promise<void>;

	/** Load a provider's stored API key, if any (active provider when omitted). */
	getApiKey(providerId?: string): Promise<string | undefined>;

	// Phase 2 Dev Mode + Telemetry (B.3)
	setDevMode(enabled: boolean): void;
	getOrchestrationPerf(): Promise<any>;
	getTraceHistory(): Promise<any[]>;

	/**
	 * Tell the service which provider is active, so `getApiKey()`/`apiKeyState` with no
	 * id resolve that provider's key. Set by the view pane from configuration.
	 */
	setActiveProviderId(providerId: string | undefined): void;

	/**
	 * One-time migration: copy the legacy single key into `providerId`'s slot if that
	 * slot is empty. Returns true when a copy happened. Safe to call repeatedly.
	 */
	migrateLegacyKey(providerId: string): Promise<boolean>;

	/**
	 * Whether a key is in hand, readable synchronously — `undefined` until the first
	 * {@link getApiKey} read populates the cache. Callers that must decide without
	 * awaiting (the composer's send path) use this; it stays accurate afterwards
	 * because {@link storeApiKey} and {@link deleteApiKey} both update the cache.
	 */
	readonly apiKeyState: boolean | undefined;

	/**
	 * Check a key without storing it, against `baseUrl` when one is given — the
	 * settings panel passes the URL currently in the form so the endpoint can be
	 * tested before it is saved. Omit it to use the configured endpoint.
	 *
	 * Omit `key` to check the stored one, which is what Validate does once a key has
	 * been saved: the field is cleared after saving, so requiring it there would make
	 * the button unusable for the only key the panel actually has.
	 */
	validateApiKey(key?: string, baseUrl?: string): Promise<ICodeMindEndpointCheck>;

	/**
	 * Models the endpoint itself advertises over `GET /v1/models`, newest first.
	 * Non-Anthropic entries are dropped: the engine only speaks the Messages API,
	 * so a gateway's OpenAI-shaped models would fail on the first turn. Rejects
	 * with a readable message when the endpoint cannot be listed, so the panel can
	 * tell "no models" apart from "wrong URL".
	 */
	listEndpointModels(key?: string, baseUrl?: string): Promise<readonly ICodeMindModelInfo[]>;

	/**
	 * Start a streaming query with the given {@link queryId}. Events for this
	 * query arrive via {@link onEvent} (filtered by queryId). Resolves with the
	 * final response when the stream completes (or rejects on error).
	 */
	queryStream(queryId: string, request: ICodeMindEngineRequest, token: CancellationToken): Promise<ICodeMindEngineResponse>;

	/** Cancel an in-flight query by id. */
	cancelQuery(queryId: string): Promise<void>;

	/**
	 * Respond to a pending permission request ({@link ICodeMindEngineEvent}
	 * kind `permission_request`) with the user's decision. `allow_scope` needs
	 * `answer.scopeId` naming one of the scopes the request offered;
	 * `allow_session` suppresses future prompts for the same tool this session;
	 * a `deny` may carry `answer.feedback` telling the model what to do instead.
	 */
	respondToPermission(toolUseId: string, decision: CodeMindPermissionDecision, answer?: ICodeMindPermissionAnswer): Promise<void>;

	/**
	 * Switch the model used for subsequent queries in the current session.
	 */
	setModel(model: string): Promise<void>;

	/** Apply engine settings (model, turn limits, system prompt, permission mode). */
	updateSettings(settings: ICodeMindEngineSettings): Promise<void>;

	/** Replace the set of MCP servers the engine connects to. */
	setMcpServers(servers: readonly ICodeMindMcpServer[]): Promise<void>;

	/** Return the MCP servers currently configured on the engine. */
	getMcpServers(): Promise<readonly ICodeMindMcpServer[]>;

	/**
	 * Ask the engine for the live connection state of every configured MCP server
	 * and return the configured list decorated with it. Costs a short engine
	 * handshake, so call it when the user asks rather than on every render.
	 */
	refreshMcpStatus(): Promise<readonly ICodeMindMcpServer[]>;

	/**
	 * The account the engine is authenticated as, or undefined when the engine
	 * could not be reached. Answered from the engine's init handshake, so it costs
	 * no tokens.
	 */
	getAccountInfo(): Promise<ICodeMindAccountInfo | undefined>;

	/**
	 * Models the engine reports as available. Empty when the engine could not be
	 * asked, in which case callers should fall back to their own list.
	 */
	getSupportedModels(): Promise<readonly ICodeMindModelInfo[]>;

	/**
	 * Slash commands the engine provides, including the ones a project or plugin
	 * contributes. Empty when the engine could not be asked. Answered from the
	 * engine's handshake, so it costs no tokens.
	 */
	getEngineCommands(): Promise<readonly ICodeMindEngineCommandInfo[]>;

	/** Rewind points recorded for this workspace, oldest first. */
	getCheckpoints(): Promise<readonly ICodeMindCheckpoint[]>;

	/**
	 * Restore the files the agent touched to their state at the given checkpoint.
	 * With `dryRun` the engine only reports what it would change.
	 */
	rewindFiles(userMessageId: string, dryRun?: boolean): Promise<ICodeMindRewindResult>;

	/**
	 * Run one of the engine's own slash commands against the current session and
	 * return what it printed. Only the engine can answer `/context` (it knows the
	 * real system prompt, tool and memory sizes) or perform `/compact` (it rewrites
	 * the conversation it will resume), so those are forwarded rather than faked.
	 */
	runEngineCommand(command: string, timeoutMs?: number): Promise<ICodeMindEngineCommandResult>;

	/**
	 * Token, cost and duration totals the engine reported across this session's
	 * turns. Undefined until the first turn has finished.
	 */
	getSessionUsage(): Promise<ICodeMindSessionUsage | undefined>;

	/**
	 * Return the cost accumulated by the current session, if known.
	 */
	getSessionCost(): Promise<{ totalCostUsd?: number } | undefined>;

	/** The session id the engine will resume on the next query, if any. */
	getSessionId(): Promise<string | undefined>;

	/** Force the next query to resume the given session id. */
	resumeSession(sessionId: string): Promise<void>;

	/**
	 * Make the next query fork the session it resumes instead of continuing it:
	 * the history carries over, the new turns land under a new session id, and the
	 * original session stays exactly as it was. Resolves to the session that will
	 * be forked, or undefined when there is nothing to fork yet.
	 */
	forkSession(): Promise<string | undefined>;

	/**
	 * Clear the in-memory session state (history / session id) so the next
	 * query starts a fresh session.
	 */
	clearSession(): Promise<void>;

	/**
	 * Run a process on the node side and return its captured output. Used by the
	 * git / diagnostics slash commands, which need real tooling (`git`, `gh`,
	 * `node`) that the renderer cannot reach directly.
	 */
	exec(request: ICodeMindExecRequest): Promise<ICodeMindExecResult>;

	/**
	 * Run a command line through the platform shell and return its output. Backs
	 * the composer's `!` mode, which is the only caller — see
	 * {@link ICodeMindShellRequest} for why this one gets a shell.
	 */
	execShell(request: ICodeMindShellRequest): Promise<ICodeMindExecResult>;

	/** Run environment diagnostics (the `/doctor` command). */
	doctor(): Promise<readonly ICodeMindDoctorCheck[]>;

	/**
	 * Write a V8 heap snapshot of the engine worker to disk (the `/heapdump`
	 * command). The worker is the process that holds the agent session, so this is
	 * the heap worth inspecting.
	 */
	heapSnapshot(): Promise<ICodeMindHeapSnapshotResult>;

	/** Feature flags the engine build exposes (voice mode, etc.). */
	getFeatureFlags(): Promise<Readonly<Record<string, boolean>>>;
}
