/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { getWindow, findParentWithClass, addDisposableListener } from '../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { isEqual } from '../../../../base/common/resources.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { asWebviewUri } from '../../webview/common/webview.js';
import { IOverlayWebview, IWebviewService, WebviewInitInfo } from '../../webview/browser/webview.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ISearchService, QueryType } from '../../../services/search/common/search.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Memento } from '../../../common/memento.js';
import {
	calculateContextStatus,
	CodeMindEffortLevel,
	CodeMindPermissionDecision,
	ICodeMindAgentEngineService,
	ICodeMindContextStatus,
	ICodeMindEngineCommandInfo,
	ICodeMindEngineRequest,
	ICodeMindEngineUsage,
	ICodeMindExecResult,
	ICodeMindMcpServer,
	ICodeMindModelInfo,
	ICodeMindPermissionScope,
	ICodeMindProvider,
	ICodeMindSandboxSettings,
	ICodeMindTurnOverrides,
} from '../common/codeMindAgentEngineService.js';
import { commandRegistry, ICodeMindColorTheme, ICodeMindCommandContext, ICodeMindOutputStyle, ICodeMindProjectInsights, ICodeMindSessionSummary, OUTPUT_STYLES, PERMISSION_MODES, runCompaction } from './codeMindCommands.js';
import { CodeMindConsensusPanel } from './codeMindConsensusPanel.js';
import {
	companionHatchPrompt,
	companionIntroText,
	companionReactionPrompt,
	ICodeMindCompanion,
	ICodeMindCompanionSoul,
	ICodeMindCompanionView,
	parseCompanionSoul,
	RARITY_STARS,
	rollCompanionBones,
} from './codeMindBuddy.js';

/** A single chat message held in memory. */
interface AgentMessage {
	id: string;
	/** `shell` is the output of a `!` shell-mode line, shown as terminal output. */
	type: 'user' | 'assistant' | 'system' | 'tool' | 'error' | 'shell';
	content: string;
	timestamp: number;
	intent?: { id: string; label: string };
	metadata?: {
		intent?: string;
		model?: string;
		usage?: ICodeMindEngineUsage;
		costUsd?: number;
		durationMs?: number;
		sessionId?: string;
		/** The user stopped this turn part-way; the content is what had arrived. */
		interrupted?: boolean;
	};
}

/** A file or image the user attached to a prompt. */
interface AgentAttachment {
	kind: 'file' | 'image';
	name: string;
	path?: string;
	dataUrl?: string;
}

/**
 * One past session in the Chat History panel. Built from the engine's on-disk
 * transcripts (`~/.claude/projects/<projectDir>/<id>.jsonl`), so it also sees
 * sessions started from the CLI.
 */
interface ICodeMindHistoryEntry {
	/** Session id = transcript filename stem; used to resume and to delete. */
	id: string;
	/** First user prompt, clipped to one line; '' when none was recorded. */
	topic: string;
	/** Transcript mtime in ms — the row's date. */
	at: number;
	/** Line count, a rough sense of length. */
	messages: number;
	/** The engine's dashed project directory; locates the `.jsonl` for open/delete. */
	projectDir: string;
	/** The real folder path read from the transcript; falls back to projectDir for display. */
	cwd?: string;
	/** Whether the session belongs to the current workspace (only those can resume). */
	current: boolean;
}

/**
 * What the panel writes into its memento so a window reload does not lose the
 * conversation. Both halves of the panel forget everything on reload — the
 * webview is rebuilt from scratch and the engine worker keeps its per-project
 * session map in memory — so the transcript and the engine session id have to be
 * written down here for the conversation to come back.
 */
interface ICodeMindPanelMemento {
	/** Bumped when the shape changes, so an older entry is dropped, not misread. */
	version: number;
	/** When the panel last wrote this, so a long-abandoned conversation is not revived. */
	savedAt: number;
	history: AgentMessage[];
	/** Engine session the transcript belongs to; the first turn after a reload resumes it. */
	sessionId?: string;
	/** Composer text the user had typed but not sent. */
	draft?: string;
	/** `/rename`, `/tag` and `/color` decorations, which belong to this conversation. */
	sessionName?: string;
	sessionTags?: string[];
	promptColor?: string;
	planMode?: boolean;
	todos?: Array<{ content: string; status: string; activeForm?: string }>;
	/** Shell-mode output still queued in front of the next prompt. */
	pendingContext?: string[];
	/** Partial text of a turn the user stopped, still owed to the engine's transcript. */
	interruptedTurn?: string;
}

/** Messages flowing from the webview to the workbench. */
type WebviewInbound =
	| { type: 'ready' }
	| { type: 'sendMessage'; payload: { text: string; attachments?: AgentAttachment[]; planMode?: boolean } }
	/** Composer shell mode (`!`): a command line the user wants run right now. */
	| { type: 'runShell'; payload: { command: string } }
	/** Composer memory mode (`#`): a note to append to a CLAUDE.md memory file. */
	| { type: 'addMemory'; payload: { text: string } }
	| { type: 'setApiKey'; payload: string }
	/** Test a key, optionally against the endpoint currently typed in the form. */
	| { type: 'validateApiKey'; payload: string | { key?: string; baseUrl?: string } }
	/** Ask the endpoint which models it serves (settings panel "Fetch models"). */
	| { type: 'fetchEndpointModels'; payload?: { key?: string; baseUrl?: string } }
	/** Provider management (multi-provider settings). */
	| { type: 'providersUpdate'; payload: ICodeMindProvider[] }
	| { type: 'setProviderKey'; payload: { providerId: string; key: string } }
	| { type: 'deleteProviderKey'; payload: { providerId: string } }
	| { type: 'validateProviderKey'; payload: { providerId?: string; key?: string; baseUrl?: string } }
	| { type: 'fetchProviderModels'; payload: { providerId: string; key?: string; baseUrl?: string } }
	/**
	 * Probe an endpoint the user has typed but not yet saved: work out whether it
	 * speaks the Anthropic or the OpenAI wire format and list its models in one go.
	 */
	| { type: 'detectProvider'; payload: { providerId?: string; baseUrl: string; apiKey: string; requestId?: number } }
	| { type: 'setActiveProvider'; payload: { providerId: string } }
	/**
	 * A composer picker model was chosen. Carries the provider that serves it so the
	 * pane can switch endpoint + key + model together — a model can belong to a
	 * provider other than the active one, and running it against the wrong endpoint
	 * would fail.
	 */
	| { type: 'selectPickerModel'; payload: { providerId: string; model: string } }
	/** Chat history panel: list past sessions, open one back into the chat, delete one. */
	| { type: 'requestHistory'; payload?: { allProjects?: boolean } }
	| { type: 'openSession'; payload: { id: string; projectDir: string; current: boolean } }
	| { type: 'deleteSession'; payload: { id: string; projectDir: string } }
	| { type: 'clearHistory' }
	| { type: 'cancel'; payload: { queryId: string } }
	| { type: 'setPlanMode'; payload: { enabled: boolean } }
	/**
	 * The composer's mode pill chose a permission mode. Separate from `runCommand
	 * permissions` because a control that already names the active mode does not also
	 * need the command's confirmation line in the transcript.
	 */
	| { type: 'setPermissionMode'; payload: { mode: string } }
	/**
	 * The composer text changed. Debounced in the webview: it exists so an unsent
	 * draft can be written to the memento, not to stream every keystroke.
	 */
	| { type: 'draftChanged'; payload: string }
	| { type: 'setModel'; payload: { model: string } }
	| { type: 'settingsUpdate'; payload: ICodeMindPanelSettings }
	| { type: 'requestSettings' }
	| { type: 'mcpUpdate'; payload: ICodeMindMcpServer[] }
	| { type: 'requestMcpServers' }
	| { type: 'mcpReconnect' }
	| { type: 'dispatch'; command: string }
	| { type: 'openConsensus' }
	| { type: 'closeConsensus' }
	| { type: 'runCommand'; payload: { name: string; args: string } }
	| { type: 'requestPanelData'; payload: { panelId: PanelId } }
	| { type: 'openFile'; payload: { path: string } }
	| { type: 'createMemoryFile'; payload: { scope: MemoryScope; name: string } }
	| { type: 'deleteFile'; payload: { path: string; panelId: PanelId } }
	| { type: 'setSkillEnabled'; payload: { name: string; enabled: boolean } }
	| { type: 'createSkill'; payload: { scope: MemoryScope; name: string } }
	| { type: 'updateTaskStatus'; payload: { index: number; status: string } }
	| { type: 'pickFiles' }
	| { type: 'requestMentionItems'; payload: { query: string; requestId: string } }
	| { type: 'cancelMentionRequest'; payload: { requestId: string } }
	| { type: 'resolveImagePreview'; payload: { path: string } }
	| { type: 'permissionResponse'; payload: { toolUseId: string; decision?: CodeMindPermissionDecision; allow: boolean; scopeId?: string; feedback?: string } }
	| { type: 'commitResponse'; payload: { confirmed: boolean; message?: string } }
	/**
	 * The composer gained or lost focus. Drives `codemindAgentComposerFocused`, which
	 * the contribution uses to shadow the workbench keybindings the composer's own
	 * readline and vim bindings need (Ctrl+B/D/E/F/K/N/P/U/W/Y, Alt+B/D/F/Y).
	 */
	| { type: 'composerFocus'; payload: { focused: boolean } }
	/**
	 * Ctrl+G / Ctrl+X Ctrl+E: edit the prompt in a real editor. The CLI writes a temp
	 * file and blocks on `$EDITOR`; here the text goes into an untitled buffer that
	 * streams its edits back, so the panel stays usable and nothing touches disk.
	 */
	| { type: 'editComposerInEditor'; payload: { text: string } };

/** The data panels the webview can ask the workbench to populate. */
type PanelId = 'memory' | 'skills' | 'tasks';

/** Where a memory file or skill is created: user profile or the open workspace. */
type MemoryScope = 'user' | 'project';

/** Settings the webview settings panel can change. */
interface ICodeMindPanelSettings {
	/**
	 * Anthropic-compatible endpoint turns go to; '' means the launch environment's
	 * `ANTHROPIC_BASE_URL`, or the official API. The API key is deliberately not
	 * part of this shape — it travels through secret storage, never a settings echo.
	 */
	baseUrl?: string;
	model?: string;
	/** Configured Anthropic-compatible providers (endpoint + curated models). Keys are not echoed. */
	providers?: ICodeMindProvider[];
	/** Id of the active provider whose endpoint/key/models drive the engine and picker. */
	activeProviderId?: string;
	/**
	 * The models offered in the composer picker, each tied to the provider that serves
	 * it. Curated separately from what a provider imports: a provider auto-imports all
	 * its models, and this is the hand-picked subset — across every provider — that the
	 * GUI shows. Empty means "fall back to the active provider's models".
	 */
	pickerModels?: Array<{ providerId: string; model: string }>;
	/** Model used when the primary one is overloaded; '' means no fallback. */
	fallbackModel?: string;
	maxTurns?: number;
	maxThinkingTokens?: number;
	systemPrompt?: string;
	permissionMode?: string;
	/** How the agent writes its answers: default | explanatory | concise | learning. */
	outputStyle?: string;
	/** Every style the panel knows about, including the ones found on disk. */
	outputStyleOptions?: string[];
	/** Reasoning depth per turn; `auto` leaves it to the model. */
	effort?: CodeMindEffortLevel;
	/** Ask for faster output from the same model. */
	fastMode?: boolean;
	/** Delegate the work to subagents and synthesize what they report. */
	coordinatorMode?: boolean;
	/** Second model consulted for advice on hard turns; '' disables it. */
	advisorModel?: string;
	sandbox?: ICodeMindSandboxSettings;
	/** Which settings files the engine loads; `project` is what turns CLAUDE.md on. */
	settingSources?: ('user' | 'project' | 'local')[];
	vimMode?: boolean;
	voiceMode?: boolean;
	showOnStartup?: boolean;
	/** Summarise the conversation automatically when the context window fills up. */
	autoCompact?: boolean;
}

/** One row rendered by the memory / skills / tasks panels. */
interface IPanelDataItem {
	label: string;
	detail?: string;
	/** Absolute path, when the row maps to a file that can be opened. */
	path?: string;
	/** Task rows only. */
	status?: string;
	/** Task rows only: index into the agent's todo list, for manual updates. */
	index?: number;
	/** File rows only: size in bytes and last-modified time. */
	size?: number;
	mtime?: number;
	/** Memory rows only: true when the engine loads this file automatically. */
	loaded?: boolean;
	/** Skill rows only. */
	enabled?: boolean;
	tools?: string[];
	/** Whether the row can be deleted from the panel. */
	deletable?: boolean;
}

/** Messages flowing from the workbench to the webview. */
type WebviewOutbound =
	| { type: 'history'; payload: AgentMessage[] }
	| { type: 'consensusState'; payload: { open: boolean; running: boolean } }
	| { type: 'status'; payload: 'ready' | 'busy' | 'error' }
	| { type: 'newMessage'; payload: AgentMessage }
	| { type: 'streamStart'; payload: { id: string; intent?: { id: string; label: string }; metadata?: { model?: string }; endpoint?: string } }
	| { type: 'streamMeta'; payload: { id: string; model?: string; sessionId?: string } }
	| { type: 'streamDelta'; payload: { id: string; content: string } }
	/**
	 * This turn is a failure, not an answer — a refused key or an unreachable
	 * endpoint. Carries the whole message rather than a delta: the engine only
	 * recognises the failure once it has the text, and the bubble has to change
	 * kind, not grow.
	 */
	| { type: 'streamError'; payload: { id: string; content: string } }
	| { type: 'thinkingDelta'; payload: { id: string; content: string } }
	| { type: 'agentText'; payload: { streamId: string; parentId: string; text: string } }
	| { type: 'tool'; payload: { streamId: string; id: string; toolName: string; input?: unknown; result?: string; isError?: boolean; status: 'running' | 'done'; parentId?: string } }
	| { type: 'toolDelta'; payload: { streamId: string; id: string; partialJson: string } }
	| { type: 'toolProgress'; payload: { id: string; toolName: string; elapsedSeconds: number; toolUseId?: string } }
	| {
		type: 'permissionRequest';
		payload: {
			toolUseId: string;
			toolName: string;
			input?: unknown;
			scopes?: readonly ICodeMindPermissionScope[];
			blockedPath?: string;
			reason?: string;
			agentId?: string;
		};
	}
	| { type: 'streamEnd'; payload: { id: string; metadata?: { model?: string; usage?: ICodeMindEngineUsage; costUsd?: number; durationMs?: number; sessionId?: string; interrupted?: boolean } } }
	| { type: 'openPanel'; payload: { panelId: string } }
	| { type: 'panelData'; payload: { panelId: PanelId; items: IPanelDataItem[] } }
	| { type: 'commandList'; payload: Array<{ name: string; description: string; args?: string; aliases?: readonly string[]; hidden?: boolean }> }
	| { type: 'sessionCost'; payload: { totalCostUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number; model?: string } }
	/**
	 * How full the model's context window is. `undefined` means "not known yet",
	 * which is also what the panel sends after a compaction: the figure it had came
	 * from the turn before and no longer describes the conversation.
	 */
	| { type: 'contextStatus'; payload: ICodeMindContextStatus | undefined }
	| { type: 'settingsData'; payload: ICodeMindPanelSettings }
	/**
	 * Models the configured endpoint advertises. `error` instead of `models` when the
	 * endpoint could not be listed, so the panel can say why rather than showing an
	 * empty dropdown that looks like a working endpoint with nothing in it.
	 */
	| { type: 'endpointModels'; payload: { endpoint: string; models?: ICodeMindModelInfo[]; error?: string } }
	| { type: 'providerModels'; payload: { providerId: string; endpoint: string; models?: ICodeMindModelInfo[]; error?: string } }
	/**
	 * Result of a {@link detectProvider} probe. `wire` is null with `success: false`
	 * when neither protocol answered; `models` carries plain ids, since a detected
	 * gateway's ids are not necessarily Anthropic-shaped.
	 */
	| { type: 'providerDetection'; payload: { providerId?: string; baseUrl: string; wire: 'anthropic' | 'openai' | null; models: string[]; success: boolean; error?: string; requestId?: number } }
	/** Past sessions for the Chat History panel, newest first. */
	| { type: 'historyData'; payload: { entries: ICodeMindHistoryEntry[]; allProjects: boolean } }
	| { type: 'mcpData'; payload: ICodeMindMcpServer[] }
	| { type: 'mentionItems'; payload: { query: string; requestId: string; items: Array<{ label: string; path: string; detail?: string }> } }
	| { type: 'imagePreview'; payload: { path: string; dataUrl: string } }
	| { type: 'featureFlags'; payload: { voiceMode?: boolean } }
	| { type: 'commitReview'; payload: { message: string; files: string[] } }
	| { type: 'planMode'; payload: boolean }
	| { type: 'attachPaths'; payload: string[] }
	| { type: 'sessionName'; payload: { name: string; tags: readonly string[] } }
	| { type: 'promptColor'; payload: { color: string } }
	/** An unsent composer draft recovered from the memento after a reload. */
	| { type: 'restoreDraft'; payload: string }
	/**
	 * Replace the composer text outright — the external-editor buffer reporting what
	 * it now holds. Unlike `restoreDraft` this wins over whatever is in the composer,
	 * because the editor is where the user is typing.
	 */
	| { type: 'composerText'; payload: { text: string } }
	/**
	 * The companion beside the composer. `undefined` when there is none, or when the
	 * user has muted it — the webview draws nothing either way, and muting keeps the
	 * soul so unmuting brings the same creature back.
	 */
	| { type: 'companion'; payload: ICodeMindCompanionView | undefined }
	/** `/buddy pet` — start the heart burst. Purely visual, so the webview owns the timing. */
	| { type: 'companionPet' }
	/** Something for the speech bubble to say, or '' to take it down early. */
	| { type: 'companionReaction'; payload: { text: string } }
	| { type: 'focusInput' };

export const CodeMindAgentViewIcon = registerIcon('codemind-agent-view-icon', Codicon.copilot, localize('codeMindAgentViewIcon', 'Icon for the CodeMind Agent view.'));

/**
 * True while the agent panel's composer has keyboard focus.
 *
 * The webview host posts every keydown back to the workbench and re-dispatches it
 * into the keybinding service whether or not the webview consumed it, so a
 * composer binding like Ctrl+W (delete word) would also fire the workbench's
 * Ctrl+W. The contribution shadows those chords with no-op commands guarded by
 * this key.
 */
export const CodeMindComposerFocusedContext = new RawContextKey<boolean>('codemindAgentComposerFocused', false, localize('codemindAgentComposerFocused', 'Whether the CodeMind Agent composer has keyboard focus.'));

/** Shortest gap between two unprompted companion remarks. */
const COMPANION_REACTION_INTERVAL_MS = 30_000;

/**
 * A side-panel view that hosts the CodeMind Agent chat webview and bridges it
 * to the Claude Code engine service. The webview implements the UI
 * (media/agent.js + agent.css); this pane owns the streaming protocol and
 * forwards engine events to the webview with provider-side delta computation.
 */
export class CodeMindAgentViewPane extends ViewPane {

	private static readonly MEDIA_ROOT = 'vs/workbench/contrib/codemindAgent/browser/media/';

	/** Storage id of the panel memento. Workspace-scoped: a conversation is about one project. */
	private static readonly MEMENTO_ID = 'codemind.agent.panel';
	/** Shape version of {@link ICodeMindPanelMemento}. */
	private static readonly MEMENTO_VERSION = 1;
	/**
	 * Transcript entries carried across a reload. Tool results can be enormous and
	 * workspace storage is a single JSON blob read on startup, so the tail is kept
	 * and the rest dropped — the engine still has the whole conversation.
	 */
	private static readonly MEMENTO_MAX_MESSAGES = 200;
	/** Cap on one persisted message body, for the same reason. */
	private static readonly MEMENTO_MAX_MESSAGE_CHARS = 20_000;
	/** Cap on the partial answer a stopped turn hands to the next prompt. */
	private static readonly INTERRUPTED_TURN_MAX_CHARS = 4_000;
	/**
	 * How stale a saved conversation may be and still be restored. The engine
	 * deletes its own transcripts after 30 days by default, and resuming a session
	 * it has forgotten fails the turn, so the panel stops offering to well before
	 * that — and a month-old conversation is not what reopening a project means.
	 */
	private static readonly MEMENTO_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

	/**
	 * Tools the engine provides out of the box, listed in the Skills panel when the
	 * engine has not reported its own set yet. Kept in step with the engine's base
	 * tool list; the engine's init handshake overrides it (see {@link _engineTools}),
	 * because which of these exist depends on its build and feature flags.
	 */
	private static readonly BUILTIN_TOOLS = [
		'Agent', 'AskUserQuestion', 'Bash', 'Brief', 'CronCreate', 'CronDelete', 'CronList',
		'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Edit', 'Glob',
		'Grep', 'ListMcpResources', 'Monitor', 'NotebookEdit', 'PushNotification', 'Read',
		'ReadMcpResource', 'SendMessage', 'Skill', 'TaskCreate', 'TaskGet', 'TaskList',
		'TaskOutput', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WebFetch',
		'WebSearch', 'Write',
	];

	/**
	 * What each `/output-style` choice adds to the system prompt. `default` is
	 * absent on purpose: it is the engine's own voice with nothing layered on.
	 */
	private static readonly OUTPUT_STYLE_PROMPTS: Readonly<Record<string, string>> = {
		explanatory: 'Output style: explanatory. Explain the reasoning behind each step as you work — '
			+ 'why this approach over the alternatives, what the trade-offs are, and what the code you '
			+ 'write is doing. Keep the explanation woven into the work rather than appended as a lecture.',
		concise: 'Output style: concise. Give the shortest correct answer. Skip preamble, restatement, '
			+ 'and summaries of work the user can see. Prefer a code block or a single sentence over a paragraph.',
		learning: 'Output style: learning. Teach as you work: name the concepts in play, point at the '
			+ 'part of the codebase that demonstrates them, and end with one small exercise the user could '
			+ 'do themselves to cement the idea. Never skip the working solution in favour of the lesson.',
	};

	private readonly _webview = this._register(new MutableDisposable<IOverlayWebview>());
	private _bodyContainer: HTMLElement | undefined;
	private _rootContainer: HTMLElement | undefined;
	private readonly _history: AgentMessage[] = [];
	private readonly _requestCts = this._register(new MutableDisposable<CancellationTokenSource>());
	/**
	 * Styles found in `.claude/output-styles/`, keyed by name. Refreshed from disk
	 * rather than read per turn: the system-prompt suffix is built synchronously on
	 * every request and cannot wait for a directory walk.
	 */
	private readonly _customOutputStyles = new Map<string, ICodeMindOutputStyle>();
	/** Read-only mode: the engine refuses workspace-mutating tools while on. */
	private _planMode = false;
	/** Set when plan mode was just switched off, so the next turn is told the block is lifted. */
	private _planModeLifted = false;
	/** Latest todo list seen from a TodoWrite tool call; drives the Tasks panel. */
	private _todos: Array<{ content: string; status: string; activeForm?: string }> = [];
	/** Engine session id of the most recent completed turn, for /resume. */
	private _lastSessionId: string | undefined;
	/** Files staged by the in-flight /commit, kept until the review sheet answers. */
	private _pendingCommitFiles: string[] = [];
	/** The MCP set last handed to the engine, so following configuration does not re-dial working servers. */
	private _lastMcpPush = '';
	/** Display name set by `/rename`, for this session only. */
	private _sessionName = '';
	/** Prompt-bar accent set by `/color`, for this session only. */
	private _promptColor = '';
	/** Searchable tags set by `/tag`, for this session only. */
	private _sessionTags: string[] = [];
	/** Tool names the engine reported in its last init handshake, if any. */
	private _engineTools: string[] | undefined;
	/** Slash commands the engine contributes, fetched once per panel load. */
	private _engineCommandList: readonly ICodeMindEngineCommandInfo[] | undefined;
	/**
	 * Blocks waiting to be prepended to the next prompt — shell-mode output, which
	 * the CLI puts in the conversation as local command output. The engine owns its
	 * own transcript, so the only way in is the next turn's prompt.
	 */
	private readonly _pendingContext: string[] = [];
	/**
	 * What a turn the user stopped had said before it was cut off, waiting to be handed
	 * to the next prompt.
	 *
	 * The engine's transcript is written by its own process: it records an assistant turn
	 * when the turn completes, so a turn that was interrupted mid-sentence leaves the
	 * user's prompt in the session file with no reply after it. The panel keeps the
	 * partial answer in its own history either way, but a resumed session reads the
	 * engine's file — so the text has to travel back in the only direction that reaches
	 * it, in front of the next prompt.
	 */
	private _interruptedTurn: string | undefined;
	/**
	 * Tokens the last completed turn carried, and the model that carried them.
	 * Undefined until a turn reports usage, and reset by a compaction — the figure
	 * describes the conversation as it was, so it is worse than nothing once the
	 * conversation has been summarised.
	 */
	private _contextTokens: number | undefined;
	private _contextModel: string | undefined;
	/** Set while the panel is compacting, so a turn cannot start a second one. */
	private _compacting = false;
	/**
	 * Consecutive failed auto-compactions. The engine gives up after three rather
	 * than retrying on every turn, and so does this.
	 */
	private _autoCompactFailures = 0;
	/** True when a turn reported that the engine compacted the session itself. */
	private _engineCompactedThisTurn = false;
	/** Cleared by the engine's `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT`. */
	private _engineAutoCompactAllowed = true;
	/** Unsent composer text, reported by the webview so it can be persisted. */
	private _draft = '';
	/**
	 * Engine session read back from the memento, waiting to be attached. The worker
	 * keeps its session map in memory, so after a reload it no longer knows which
	 * conversation the panel is showing — the first turn has to say, once.
	 */
	private _pendingResumeSessionId: string | undefined;
	/** The scope the Chat History panel last asked for, so a delete refreshes the same view. */
	private _lastHistoryAllProjects = false;
	/** Active mention-search cancellation tokens, keyed by requestId. */
	private readonly _mentionCancellation = new Map<string, CancellationTokenSource>();
	private readonly _memento: Memento<ICodeMindPanelMemento>;
	private readonly _mementoState: Partial<ICodeMindPanelMemento>;
	/**
	 * Profile-wide storage, used for the one thing the panel keeps per user rather
	 * than per workspace: the seed a companion's bones are rolled from.
	 */
	private readonly _storageService: IStorageService;
	/** When the companion last said something, so a burst of short turns is not a burst of quips. */
	private _lastCompanionReactionAt = 0;
	/** True while the webview's composer holds focus; see {@link CodeMindComposerFocusedContext}. */
	private readonly _composerFocusedKey: IContextKey<boolean>;
	/**
	 * The live external-editor round trip: a model reference plus its listeners. Only
	 * one runs at a time, because the composer can only mirror one buffer.
	 */
	private readonly _composerEditor = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@ICodeMindAgentEngineService private readonly _engineService: ICodeMindAgentEngineService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@ISearchService private readonly _searchService: ISearchService,
		@ICommandService private readonly _commandService: ICommandService,
		@IEditorService private readonly _editorService: IEditorService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IWorkspaceEditingService private readonly _workspaceEditingService: IWorkspaceEditingService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IWorkbenchThemeService private readonly _workbenchThemeService: IWorkbenchThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._storageService = storageService;
		this._memento = new Memento<ICodeMindPanelMemento>(CodeMindAgentViewPane.MEMENTO_ID, storageService);
		this._mementoState = this._memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._composerFocusedKey = CodeMindComposerFocusedContext.bindTo(contextKeyService);
		// The webview keeps focus across a hide, but its keydowns stop arriving — and a
		// stale `true` would leave the workbench shortcuts shadowed panel-wide.
		this._register(toDisposable(() => this._composerFocusedKey.set(false)));
		this._restoreState();
		// `saveState` covers shutdown; this covers the view being closed or moved,
		// which disposes the pane without the container ever asking it to save.
		this._register(toDisposable(() => this._persistState()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._bodyContainer = container;
		this._rootContainer = undefined;

		// The webview iframe lives in an overlay anchored to this container rather than
		// mounted inside it. An iframe cannot be reparented without reloading, and the
		// workbench rebuilds this body's DOM every time the Secondary Side Bar is toggled
		// or the view is moved — a mounted iframe would end up detached and blank. An
		// overlay is re-anchored on each visibility change instead, so the panel always
		// re-appears. The container itself is made focusable so keyboard users can Tab in.
		container.tabIndex = 0;
		container.setAttribute('role', 'document');
		this._register(addDisposableListener(container, 'focus', e => {
			if (e.target === container) {
				this._webview.value?.focus();
			}
		}));

		const mediaRootUri = FileAccess.asFileUri(CodeMindAgentViewPane.MEDIA_ROOT);
		const init: WebviewInitInfo = {
			title: localize('codeMindAgent', 'CodeMind Agent'),
			options: { retainContextWhenHidden: true },
			contentOptions: { allowScripts: true, localResourceRoots: [mediaRootUri] },
			extension: undefined,
		};
		const webview = this._webviewService.createWebviewOverlay(init);
		this._webview.value = webview;

		webview.setHtml(this._getHtml(webview));
		this._layoutWebview();

		// Claim the overlay while visible so it anchors to this body, and release it when
		// hidden so another view can take over the overlay host. This is what survives a
		// Secondary Side Bar toggle.
		this._register(this.onDidChangeBodyVisibility(() => {
			if (this.isBodyVisible()) {
				this._webview.value?.claim(this, getWindow(this.element), undefined);
				this._layoutWebview();
			} else {
				this._webview.value?.release(this);
			}
		}));
		if (this.isBodyVisible()) {
			webview.claim(this, getWindow(this.element), undefined);
			this._layoutWebview();
		}

		this._register(webview.onMessage(e => this._handleWebviewMessage(e.message as WebviewInbound)));

		// Mirror the Multi-Agent Consensus window's lifecycle into the composer toggle:
		// open/closed drives the switch's on/off, and running locks it so the window can't
		// be closed mid-run from the composer. The initial value is sent on the webview's
		// 'ready' message, once its listener is attached.
		this._register(CodeMindConsensusPanel.onDidChangeState(state => {
			this._postMessage({ type: 'consensusState', payload: state });
		}));

		// The worker boots with empty settings, so seed it from configuration before
		// the first turn can be sent.
		this._pushEngineSettings();

		// Fold any pre-provider single-endpoint config into a default provider, then
		// re-seed the engine and re-echo settings so the webview shows the migrated state.
		this._migrateProvidersIfNeeded().then(() => {
			this._pushEngineSettings();
			this._postMessage({ type: 'settingsData', payload: this._readSettings() });
		}).catch(() => { });

		// Same for MCP: the worker keeps its server list in memory only, so without this
		// a server added in an earlier window is in settings.json but unknown to the
		// engine — it would neither connect nor show up in the panel.
		this._syncMcpServers();

		// Styles on disk are part of the settings payload, so load them once now and
		// let the refresh repost when the walk finishes. Not awaited: a slow home
		// directory must not hold up the first paint.
		this._refreshOutputStyles();

		// Configuration is the single source of truth for the panel, so follow it when
		// it changes outside the panel too — a settings.json edit, another window, or a
		// slash command. Repainting is idempotent: the webview only moves state that
		// actually differs from what it is showing.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('codemind')) {
				return;
			}
			this._postMessage({ type: 'settingsData', payload: this._readSettings() });
			this._pushEngineSettings();
			if (e.affectsConfiguration('codemind.voiceMode')) {
				this._pushFeatureFlags();
			}
			if (e.affectsConfiguration('codemind.companion')
				|| e.affectsConfiguration('codemind.companionSoul')
				|| e.affectsConfiguration('codemind.companionMuted')) {
				this._pushCompanion();
			}
			if (e.affectsConfiguration('codemind.mcpServers')) {
				this._syncMcpServers();
			}
		}));
	}

	/**
	 * Called by the view container before the window saves its state, and by the
	 * storage service's periodic flush. Writing here is what makes a reload keep
	 * the conversation.
	 */
	override saveState(): void {
		this._persistState();
		super.saveState();
	}

	/** Read the conversation back out of the memento into this pane's fields. */
	private _restoreState(): void {
		const state = this._mementoState;
		// Absent on first run, different after a shape change: either way there is
		// nothing here this build can read, and the next save overwrites it.
		if (state.version !== CodeMindAgentViewPane.MEMENTO_VERSION) {
			return;
		}
		// Too old to trust: the engine may have cleaned up the session behind it.
		if (!state.savedAt || Date.now() - state.savedAt > CodeMindAgentViewPane.MEMENTO_MAX_AGE_MS) {
			return;
		}
		if (state.history?.length) {
			this._history.push(...state.history);
		}
		this._lastSessionId = state.sessionId;
		this._pendingResumeSessionId = state.sessionId;
		this._draft = state.draft ?? '';
		this._sessionName = state.sessionName ?? '';
		this._sessionTags = state.sessionTags ? [...state.sessionTags] : [];
		this._promptColor = state.promptColor ?? '';
		this._planMode = false;
		this._todos = state.todos ? state.todos.map(t => ({ ...t })) : [];
		if (state.pendingContext?.length) {
			this._pendingContext.push(...state.pendingContext);
		}
		this._interruptedTurn = state.interruptedTurn || undefined;
	}

	/** Write the conversation into the memento. Cheap enough to call on every change. */
	private _persistState(): void {
		const state = this._mementoState;
		const history = this._history
			.slice(-CodeMindAgentViewPane.MEMENTO_MAX_MESSAGES)
			.map(m => this._trimForStorage(m));
		state.version = CodeMindAgentViewPane.MEMENTO_VERSION;
		state.savedAt = Date.now();
		state.history = history;
		// A session id with no transcript would resume a conversation the panel
		// cannot show, so the two are kept or dropped together.
		state.sessionId = history.length ? this._lastSessionId : undefined;
		state.draft = this._draft || undefined;
		state.sessionName = this._sessionName || undefined;
		state.sessionTags = this._sessionTags.length ? [...this._sessionTags] : undefined;
		state.promptColor = this._promptColor || undefined;
		state.planMode = this._planMode || undefined;
		state.todos = this._todos.length ? this._todos.map(t => ({ ...t })) : undefined;
		state.pendingContext = this._pendingContext.length ? [...this._pendingContext] : undefined;
		state.interruptedTurn = this._interruptedTurn || undefined;
		this._memento.saveMemento();
	}

	/** Cap one message's body, marking it so the user knows why it is short. */
	private _trimForStorage(message: AgentMessage): AgentMessage {
		if (message.content.length <= CodeMindAgentViewPane.MEMENTO_MAX_MESSAGE_CHARS) {
			return message;
		}
		return {
			...message,
			content: `${message.content.slice(0, CodeMindAgentViewPane.MEMENTO_MAX_MESSAGE_CHARS)}\n\n… truncated when the panel saved this conversation.`,
		};
	}

	/**
	 * The engine session the next turn should attach to, consumed on first use. It
	 * is only set once per reload: after one turn the worker has the session in its
	 * own map again and resumes it without being told.
	 */
	private _takeResumeSessionId(): string | undefined {
		const sessionId = this._pendingResumeSessionId;
		this._pendingResumeSessionId = undefined;
		return sessionId;
	}

	/**
	 * Whether a failed turn failed because the session it was asked to resume is
	 * gone. The engine reports this as a load error naming the id, and it is worth
	 * telling apart from a network or key problem: the fix is different.
	 */
	private _isMissingSessionError(error: unknown, sessionId: string): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return message.includes(sessionId) || /no conversation found/i.test(message);
	}

	private _getHtml(webview: IOverlayWebview): string {
		const cssUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindAgentViewPane.MEDIA_ROOT}agent.css`));
		const jsUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindAgentViewPane.MEDIA_ROOT}agent.js`));
		const panelsUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindAgentViewPane.MEDIA_ROOT}panels.js`));
		const inputUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindAgentViewPane.MEDIA_ROOT}input.js`));
		const buddyUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindAgentViewPane.MEDIA_ROOT}buddy.js`));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>CodeMind Agent</title>
	<link rel="stylesheet" href="${cssUri.toString(true)}">
</head>
<body>
	<header class="header">
		<div class="header-left">
			<div class="logo" aria-hidden="true">
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
				<span>CodeMind</span>
			</div>
			<span class="session-name hidden" id="sessionName" title="Session name (/rename)"></span>
			<span class="session-tags hidden" id="sessionTags" title="Session tags (/tag)"></span>
		</div>
		<!-- Turn status lives in the header centre now: the pulsing dot + "Thinking…" is
		     silent at rest (setStatus writes text only for a running turn or an error), so at
		     idle it contributes nothing and the header reads as usual. -->
		<span class="status-pill" id="statusPill">
			<span class="status-dot ready" id="statusDot"></span>
			<span id="statusText"></span>
		</span>
		<!-- Section 3.2: two buttons only. The plan toggle moves into the input bar's mode
		     control (Section 2.4); Clear History discarded the visible conversation, which is
		     exactly what New Session already does through the same \`discardConversation()\`;
		     and the key button's dialog is reachable from Settings, which has its own key
		     field with Save and Test. The status chip moves to the composer footer, where
		     "Still connecting to …" is next to the box the user is waiting on. -->
		<div class="header-right header-actions">
			<button class="icon-btn" id="newSessionBtn" title="New Session" aria-label="Start a new session">
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
			</button>
			<button class="icon-btn" id="historyBtn" title="Chat History" aria-label="Browse chat history">
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg>
			</button>
			<button class="icon-btn" id="settingsBtn" title="Settings" aria-label="Open settings">
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
			</button>
		</div>
	</header>

	<div class="chat-scroll" id="chatScroll">
		<div class="messages" id="messages"></div>
	</div>

	<div class="input-area">
		<div class="attachments hidden" id="attachments"></div>
		<div class="slash-menu hidden" id="slashMenu"></div>
		<div class="mention-menu hidden" id="mentionMenu"></div>
		<div class="input-mode hidden" id="inputMode"></div>
		<div class="bg-tasks hidden" id="bgTasks"></div>
		<div class="prompt-queue hidden" id="promptQueue"></div>
		<div class="buddy-card hidden" id="buddyCard"></div>
		<div class="buddy hidden" id="buddy">
			<div class="buddy-bubble hidden" id="buddyBubble"></div>
			<button class="buddy-sprite" id="buddySprite" type="button" title="Your companion — click to pet, double-click for its card">
				<pre class="buddy-art" id="buddyArt" aria-hidden="true"></pre>
				<span class="buddy-name" id="buddyName"></span>
			</button>
		</div>
		<!-- Section 2.1: one strip, two rows, one top border, no internal rules. Row A carries
		     the controls that used to be scattered through the header and the footer; row B is
		     the entry line. Everything above this element (attachments, the two autocompletes,
		     the mode banner, the queue, the companion) still floats over the transcript. -->
		<div class="composer" id="composer">
			<div class="composer-controls">
				<div class="composer-controls-left">
					<div class="model-pill-wrap">
						<button class="model-pill" id="modelPill" type="button" aria-haspopup="listbox" aria-expanded="false" title="Model for new turns"></button>
						<!-- Opens upward only (Section 2.2): the strip sits at the bottom of the
						     panel, so a downward menu would be off-screen. -->
						<div class="model-menu hidden" id="modelMenu" role="listbox" aria-label="Model for new turns"></div>
					</div>
					<!-- Section 2.3. One menu, not a row of segments: it names the mode the next
					     turn will run in, and because a menu can show whatever is chosen,
					     bypassPermissions is listed here too rather than only in /permissions and
					     in Settings. -->
					<div class="model-pill-wrap mode-pill-wrap">
						<button class="model-pill mode-pill" id="modePill" type="button" aria-haspopup="listbox" aria-expanded="false" data-mode="default" title="Agent mode for new turns">Normal</button>
						<div class="model-menu mode-menu hidden" id="modeMenu" role="listbox" aria-label="Agent mode for new turns"></div>
					</div>
					<div class="model-pill-wrap" id="consensusPillWrap" style="display: none; margin-left: 4px; align-items: center;">
						<label title="Consensus Mode" style="position: relative; display: inline-block; width: 28px; height: 16px; margin: 0; cursor: pointer; display: flex; align-items: center;">
							<input type="checkbox" id="consensusPillCheckbox" style="opacity: 0; width: 0; height: 0; position: absolute;">
							<span id="consensusPillSliderBg" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: transparent; border: 1px solid var(--cm-accent); border-radius: 16px; transition: .2s; box-sizing: border-box;"></span>
							<span id="consensusPillSliderKnob" style="position: absolute; height: 10px; width: 10px; left: 2px; top: 50%; transform: translateY(-50%); background-color: var(--cm-accent); border-radius: 50%; transition: .2s;"></span>
						</label>
					</div>
				</div>
				<div class="composer-controls-right">
					<button class="composer-icon" id="attachBtn" title="Attach files or images" aria-label="Attach files or images">
						<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
					</button>
					<button class="composer-icon" id="mentionBtn" title="Reference a file or folder (@)" aria-label="Reference a file or folder">
						<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>
					</button>
					<button class="composer-icon mic-btn" id="micBtn" title="Voice input" aria-label="Start voice input">
						<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
					</button>
				</div>
			</div>
			<div class="composer-entry">
				<textarea id="input" placeholder="Message CodeMind..." rows="1" aria-label="Message CodeMind"></textarea>
				<!-- Section 2.4: send and stop share one 28px slot and cross-fade, so the button
				     under the pointer is always the one the current state allows. -->
				<div class="send-slot" id="sendSlot">
					<button class="send-btn" id="sendBtn" disabled aria-label="Send message">
						<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
					</button>
					<button class="stop-btn" id="stopBtn" type="button" aria-label="Stop the current turn" title="Stop (Ctrl+C)">
						<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
					</button>
				</div>
			</div>
		</div>
		<input type="file" id="filePicker" class="hidden" multiple accept="*/*">
		<div class="input-footer">
			<span>Enter to send · Shift+Enter for newline</span>
			<span class="slash-hint hidden" id="slashHint"></span>
			<span class="composer-hint hidden" id="composerHint"></span>
			<span class="vim-indicator hidden" id="vimIndicator"></span>
			<button class="bg-pill hidden" id="bgPill" type="button" aria-expanded="false" title="Background tasks — click to list them">
				<span class="bg-pill-dot" aria-hidden="true"></span>
				<span class="bg-pill-text" id="bgPillText"></span>
			</button>
			<button class="context-meter hidden" id="contextMeter" type="button" title="Context window usage — click to compact the conversation">
				<span class="context-bar"><span class="context-bar-fill" id="contextBarFill"></span></span>
				<span class="context-text" id="contextText"></span>
			</button>
		</div>
		<!-- Section 1.4: the one number the session keeps. Its line is always this tall,
		     empty or not, so the first total to arrive moves nothing. -->
		<div class="session-tokens" id="sessionTokens"></div>
	</div>

	<div class="modal-overlay hidden" id="apiKeyModal">
		<div class="modal">
			<h2>Set Anthropic API Key</h2>
			<p>Enter your Anthropic API key to use the CodeMind Agent. Get one from <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>.</p>
			<div class="form-group">
				<label for="apiKeyInput">API Key</label>
				<input type="password" id="apiKeyInput" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">
			</div>
			<div class="modal-actions">
				<button class="btn btn-secondary" id="apiKeyCancel">Cancel</button>
				<button class="btn btn-primary" id="apiKeySave">Save</button>
			</div>
		</div>
	</div>

	<div class="modal-overlay hidden" id="permissionModal">
		<div class="modal permission-modal">
			<h2 id="permTitle">Permission Request</h2>
			<p id="permIntro">CodeMind wants to run a tool:</p>
			<div class="perm-tool-name" id="permToolName"></div>
			<pre class="perm-input" id="permInput"></pre>
			<div class="perm-reason hidden" id="permReason"></div>
			<div class="perm-scopes" id="permScopes"></div>
			<div class="form-group perm-feedback hidden" id="permFeedbackGroup">
				<label for="permFeedback">Tell CodeMind what to do differently (optional)</label>
				<input type="text" id="permFeedback" placeholder="e.g. read the file first, don't touch the lockfile" autocomplete="off" spellcheck="false">
			</div>
			<div class="modal-actions">
				<button class="btn btn-danger" id="permDeny">No</button>
				<button class="btn btn-secondary" id="permAllowSession">Yes, for every use this session</button>
				<button class="btn btn-primary" id="permAllow">Yes</button>
			</div>
		</div>
	</div>

	<script src="${panelsUri.toString(true)}"></script>
	<script src="${inputUri.toString(true)}"></script>
	<script src="${buddyUri.toString(true)}"></script>
	<script src="${jsUri.toString(true)}"></script>
</body>
</html>`;
	}

	private _handleWebviewMessage(message: WebviewInbound): void {
		switch (message.type) {
			case 'ready':
				this._postMessage({ type: 'history', payload: this._history });
				this._postMessage({ type: 'status', payload: 'ready' });
				this._sendCommandList();
				this._postMessage({ type: 'settingsData', payload: this._readSettings() });
				// Re-apply the session-scoped decorations after a webview reload.
				this._postMessage({ type: 'sessionName', payload: { name: this._sessionName, tags: this._sessionTags } });
				this._postMessage({ type: 'promptColor', payload: { color: this._promptColor } });
				// Both restored from the memento, so the reloaded webview shows the
				// conversation as the user left it rather than a clean slate.
				this._postMessage({ type: 'planMode', payload: this._planMode });
					// Reflect whether the Multi-Agent Consensus window is currently open/running.
					this._postMessage({ type: 'consensusState', payload: CodeMindConsensusPanel.state });
				if (this._draft) {
					this._postMessage({ type: 'restoreDraft', payload: this._draft });
				}
				this._sendMcpServers();
				this._pushFeatureFlags();
				this._pushCompanion();
				// The engine's own commands arrive later; the list is re-sent then.
				void this._loadEngineCommands();
				// Primes `apiKeyState` so the composer's first send can tell a missing
				// key from an unread one without awaiting secret storage.
				void this._engineService.getApiKey();
				// Vim state rides along in `settingsData` above — posting `toggleVim`
				// here as well would flip it straight back off.
				break;
			case 'sendMessage':
				this._sendMessage(message.payload.text, message.payload.attachments);
				break;
			case 'runShell':
				void this._runShellInput(message.payload.command);
				break;
			case 'addMemory':
				void this._appendToMemory(message.payload.text);
				break;
			case 'setApiKey':
				this._engineService.storeApiKey(message.payload).then(() => {
					this._postMessage({ type: 'status', payload: 'ready' });
				});
				break;
			case 'validateApiKey':
				this._validateApiKey(message.payload);
				break;
			case 'fetchEndpointModels':
				this._fetchEndpointModels(message.payload?.key, message.payload?.baseUrl);
				break;
			case 'providersUpdate':
				this._applyProviders(message.payload);
				break;
			case 'setProviderKey':
				this._engineService.storeApiKey(message.payload.key, message.payload.providerId).then(() => {
					this._postMessage({ type: 'status', payload: 'ready' });
				}).catch(() => { });
				break;
			case 'deleteProviderKey':
				this._engineService.deleteApiKey(message.payload.providerId).catch(() => { });
				break;
			case 'validateProviderKey':
				this._validateProviderKey(message.payload);
				break;
			case 'fetchProviderModels':
				this._fetchProviderModels(message.payload);
				break;
			case 'setActiveProvider':
				this._setActiveProvider(message.payload.providerId);
				break;
			case 'selectPickerModel':
				// A composer pick carries the provider that serves the model, so the
				// endpoint, key and model all move together — otherwise a model from a
				// non-active provider would run against the wrong endpoint.
				this._setActiveProvider(message.payload.providerId, message.payload.model);
				break;
			case 'requestHistory':
				void this._sendHistory(message.payload?.allProjects === true);
				break;
			case 'openSession':
				void this._openSession(message.payload);
				break;
			case 'deleteSession':
				void this._deleteSession(message.payload);
				break;
			case 'clearHistory':
				this._history.length = 0;
				this._pendingResumeSessionId = undefined;
				// A stopped turn belonged to the conversation being discarded.
				this._interruptedTurn = undefined;
				this._engineService.clearSession().catch(() => { });
				this._postMessage({ type: 'history', payload: [] });
				// Written straight away: a conversation the user cleared must not come
				// back if the window goes down before the next state flush.
				this._persistState();
				break;
			case 'cancel':
				this._requestCts.value?.cancel();
				this._engineService.cancelQuery(message.payload.queryId).catch(() => { });
				break;
			case 'setPlanMode':
				this._setPlanMode(message.payload.enabled);
				break;
			case 'setPermissionMode':
				this._setPermissionModeFromPanel(message.payload.mode);
				break;
			case 'orchestration_trace':
				this._postMessage({ type: 'orchestrationTrace', payload: message.payload });
				break;
			case 'draftChanged':
				this._draft = message.payload;
				break;
			case 'composerFocus':
				this._composerFocusedKey.set(message.payload.focused);
				break;
			case 'setModel':
				this._engineService.setModel(message.payload.model).catch(() => { });
				break;
			case 'settingsUpdate':
				this._applySettings(message.payload);
				break;
			case 'requestSettings':
				this._postMessage({ type: 'settingsData', payload: this._readSettings() });
				break;
			case 'mcpUpdate':
				this._persistMcpServers(message.payload);
				break;
			case 'requestMcpServers':
				this._sendMcpServers();
				break;
			case 'mcpReconnect':
				// Re-push the configured set: the worker tears down and re-dials.
				this._syncMcpServers(this._readMcpServers(), true);
				break;
			case 'runCommand':
				this._runCommand(message.payload.name, message.payload.args);
				break;
			case 'requestPanelData':
				this._sendPanelData(message.payload.panelId);
				break;
			case 'openFile':
				this.openerService.open(URI.file(message.payload.path)).catch(() => { });
				break;
			case 'createMemoryFile':
				this._createMemoryFile(message.payload.scope, message.payload.name);
				break;
			case 'deleteFile':
				this._deleteFile(message.payload.path, message.payload.panelId);
				break;
			case 'setSkillEnabled':
				this._setSkillEnabled(message.payload.name, message.payload.enabled);
				break;
			case 'createSkill':
				this._createSkill(message.payload.scope, message.payload.name);
				break;
			case 'updateTaskStatus': {
				const todo = this._todos[message.payload.index];
				if (todo) {
					todo.status = message.payload.status;
					this._postMessage({ type: 'panelData', payload: { panelId: 'tasks', items: this._collectTasks() } });
				}
				break;
			}
			case 'pickFiles':
				this._pickFiles();
				break;
			case 'requestMentionItems':
				this._sendMentionItems(message.payload.query, message.payload.requestId);
				break;
			case 'cancelMentionRequest':
				this._cancelMentionRequest(message.payload.requestId);
				break;
			case 'resolveImagePreview':
				this._resolveImagePreview(message.payload.path);
				break;
			case 'permissionResponse': {
				// Every decision beyond "just this once" is carried out engine-side:
				// the worker owns the rule text, whitelists the tool for the session,
				// and hands persisted grants to the engine to write.
				const decision = message.payload.decision ?? (message.payload.allow ? 'allow_once' : 'deny');
				this._engineService.respondToPermission(message.payload.toolUseId, decision, {
					scopeId: message.payload.scopeId,
					feedback: message.payload.feedback,
				}).catch(() => { });
				break;
			}
			case 'commitResponse': {
				const approved = message.payload.confirmed ? (message.payload.message ?? '').trim() : '';
				if (approved) {
					this._completeCommit(approved);
				} else {
					this._pendingCommitFiles = [];
					this._appendSystemMessage('Commit cancelled. The files are still staged.');
				}
				break;
			}
			case 'editComposerInEditor':
				this._editComposerInEditor(message.payload.text);
				break;
			case 'dispatch':
				this._commandService.executeCommand(message.command).catch(() => { });
				break;
			case 'openConsensus':
				this._commandService.executeCommand('workbench.action.openCodeMindConsensus').catch(() => { });
				break;
			case 'closeConsensus':
				this._commandService.executeCommand('workbench.action.closeCodeMindConsensus').catch(() => { });
				break;
		}
	}

	/**
	 * Hand the webview the command list for its autocomplete. Hidden commands ride
	 * along with the flag set — the menu only surfaces them on an exact name, which
	 * is how the CLI behaves — and aliases come too, since prefix matching against
	 * them happens webview-side.
	 *
	 * The engine's own commands (project commands in `.claude/commands/`, plugin and
	 * skill commands) are appended: they already work when typed, because an unknown
	 * command falls through to the engine, and this makes them discoverable too.
	 */
	private _sendCommandList(): void {
		const own = commandRegistry.list().map(c => ({
			name: c.name,
			description: c.description,
			args: c.args,
			aliases: c.aliases,
			hidden: c.hidden,
		}));
		const taken = new Set<string>();
		for (const c of own) {
			taken.add(c.name.toLowerCase());
			for (const alias of c.aliases ?? []) {
				taken.add(alias.toLowerCase());
			}
		}
		// A panel command of the same name wins: it is the one that will actually run.
		const engine = (this._engineCommandList ?? [])
			.filter(c => !taken.has(c.name.toLowerCase()))
			.map(c => ({ name: c.name, description: c.description, args: c.argumentHint || undefined }));
		this._postMessage({ type: 'commandList', payload: [...own, ...engine] });
	}

	/**
	 * Ask the engine which commands it has and re-send the merged list. Costs one
	 * control handshake, so it runs once per panel load rather than per keystroke.
	 */
	private async _loadEngineCommands(): Promise<void> {
		if (this._engineCommandList) {
			return;
		}
		try {
			const commands = await this._engineService.getEngineCommands();
			this._engineCommandList = commands;
			if (commands.length) {
				this._sendCommandList();
			}
		} catch {
			// The engine may not be reachable yet; the panel's own list still works.
		}
	}

	/** Read the settings panel's current values out of user configuration. */
	private _readSettings(): ICodeMindPanelSettings {
		const providers = this._readProviders();
		return {
			baseUrl: this.configurationService.getValue<string>('codemind.baseUrl'),
			model: this.configurationService.getValue<string>('codemind.model'),
			providers,
			activeProviderId: this._readActiveProviderId(providers),
			pickerModels: this._readPickerModels(providers),
			fallbackModel: this.configurationService.getValue<string>('codemind.fallbackModel'),
			maxTurns: this.configurationService.getValue<number>('codemind.maxTurns'),
			maxThinkingTokens: this.configurationService.getValue<number>('codemind.maxThinkingTokens'),
			systemPrompt: this.configurationService.getValue<string>('codemind.systemPrompt'),
			permissionMode: this.configurationService.getValue<string>('codemind.permissionMode'),
			outputStyle: this.configurationService.getValue<string>('codemind.outputStyle'),
			outputStyleOptions: [...OUTPUT_STYLES, ...this._customOutputStyles.keys()],
			effort: this.configurationService.getValue<CodeMindEffortLevel>('codemind.effort'),
			fastMode: this.configurationService.getValue<boolean>('codemind.fastMode'),
			coordinatorMode: this.configurationService.getValue<boolean>('codemind.coordinatorMode'),
			advisorModel: this.configurationService.getValue<string>('codemind.advisorModel'),
			sandbox: this._readSandboxSettings(),
			settingSources: this._readSettingSources(),
			vimMode: this.configurationService.getValue<boolean>('codemind.vimMode'),
			voiceMode: this.configurationService.getValue<boolean>('codemind.voiceMode'),
			showOnStartup: this.configurationService.getValue<boolean>('codemind.showOnStartup'),
			autoCompact: this._isAutoCompactEnabled(),
		};
	}

	/**
	 * Read the configured providers, normalising each entry so a partial object from
	 * settings.json is safe. Empty by default until migration or the settings UI fills it.
	 */
	private _readProviders(): ICodeMindProvider[] {
		const raw = this.configurationService.getValue<Partial<ICodeMindProvider>[]>('codemind.providers') ?? [];
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw
			.filter(p => p && typeof p.id === 'string' && p.id)
			.map(p => ({
				id: p.id as string,
				name: (typeof p.name === 'string' && p.name) ? p.name : 'Provider',
				baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
				models: Array.isArray(p.models) ? p.models.filter(m => typeof m === 'string' && m) : [],
				enabled: p.enabled !== false,
			}));
	}

	/** The active provider id, defaulting to the first enabled provider when unset/stale. */
	private _readActiveProviderId(providers: ICodeMindProvider[] = this._readProviders()): string | undefined {
		const configured = (this.configurationService.getValue<string>('codemind.activeProviderId') ?? '').trim();
		if (configured && providers.some(p => p.id === configured && p.enabled)) {
			return configured;
		}
		const firstEnabled = providers.find(p => p.enabled);
		return firstEnabled?.id;
	}

	/** The active provider record, or undefined when none is configured. */
	private _activeProvider(): ICodeMindProvider | undefined {
		const providers = this._readProviders();
		const id = this._readActiveProviderId(providers);
		return providers.find(p => p.id === id);
	}

	/**
	 * The composer picker's curated models, read from `codemind.pickerModels` and
	 * pruned to entries that can still be served: the provider must exist, be enabled,
	 * and actually list the model. A stale entry — provider removed, disabled, or the
	 * model no longer imported — would otherwise offer a choice that resolves to a
	 * missing endpoint, so it is dropped here rather than surfaced and left to fail.
	 */
	private _readPickerModels(providers: ICodeMindProvider[] = this._readProviders()): Array<{ providerId: string; model: string }> {
		const raw = this.configurationService.getValue<Array<{ providerId?: unknown; model?: unknown }>>('codemind.pickerModels') ?? [];
		if (!Array.isArray(raw)) {
			return [];
		}
		const byId = new Map(providers.filter(p => p.enabled).map(p => [p.id, p]));
		const seen = new Set<string>();
		const out: Array<{ providerId: string; model: string }> = [];
		for (const entry of raw) {
			const providerId = typeof entry?.providerId === 'string' ? entry.providerId : '';
			const model = typeof entry?.model === 'string' ? entry.model : '';
			if (!providerId || !model) {
				continue;
			}
			const provider = byId.get(providerId);
			if (!provider || !provider.models.includes(model)) {
				continue;
			}
			// One provider can legitimately be picked for several models, so the key is
			// the pair, not the id — de-duped so a doubled entry shows once.
			const key = `${providerId} ${model}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			out.push({ providerId, model });
		}
		return out;
	}

	/**
	 * One-time migration from the pre-provider single-endpoint config. If no providers
	 * exist yet, synthesize a default "Anthropic" provider from `codemind.baseUrl` +
	 * `codemind.model`, copy the legacy secret key into its slot, and mark it active.
	 * Runs before the first settings read so nothing regresses for existing users.
	 */
	private async _migrateProvidersIfNeeded(): Promise<void> {
		if (this._readProviders().length > 0) {
			return;
		}
		const baseUrl = (this.configurationService.getValue<string>('codemind.baseUrl') ?? '').trim();
		const model = (this.configurationService.getValue<string>('codemind.model') ?? '').trim();
		const id = generateUuid();
		const provider: ICodeMindProvider = {
			id,
			name: 'Anthropic',
			baseUrl,
			models: model ? [model] : [],
			enabled: true,
		};
		await this.configurationService.updateValue('codemind.providers', [provider]);
		await this.configurationService.updateValue('codemind.activeProviderId', id);
		await this._engineService.migrateLegacyKey(id);
		this._engineService.setActiveProviderId(id);
	}

	/**
	 * Whether the panel may compact the conversation on its own. The engine's own
	 * opt-outs (`DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` in its environment) win,
	 * so a user who has already turned auto-compaction off for the CLI does not get
	 * it back from the panel; the setting covers everyone else.
	 */
	private _isAutoCompactEnabled(): boolean {
		return this._engineAutoCompactAllowed && this.configurationService.getValue<boolean>('codemind.autoCompact') !== false;
	}

	/** Sandbox settings, normalised so a partial object from settings.json is safe. */
	private _readSandboxSettings(): ICodeMindSandboxSettings {
		const raw = this.configurationService.getValue<ICodeMindSandboxSettings>('codemind.sandbox') ?? {};
		return {
			enabled: raw.enabled === true,
			autoAllowBashIfSandboxed: raw.autoAllowBashIfSandboxed === true,
			allowUnsandboxedCommands: raw.allowUnsandboxedCommands === true,
			excludedCommands: Array.isArray(raw.excludedCommands) ? raw.excludedCommands.filter(c => typeof c === 'string') : [],
		};
	}

	/**
	 * Which settings files the engine loads. Anything unrecognised is dropped so a
	 * typo in settings.json cannot make the engine reject the whole option.
	 */
	private _readSettingSources(): ('user' | 'project' | 'local')[] {
		const known = ['user', 'project', 'local'] as const;
		const raw = this.configurationService.getValue<string[]>('codemind.settingSources');
		if (!Array.isArray(raw)) {
			return [...known];
		}
		return known.filter(source => raw.includes(source));
	}

	/** Whether the chat input starts in vim normal mode. */
	private _isVimMode(): boolean {
		return this.configurationService.getValue<boolean>('codemind.vimMode') === true;
	}

	/**
	 * Hand the engine-relevant half of the settings to the worker. The worker
	 * starts with no settings at all, so this also runs once at view creation —
	 * otherwise a persisted model or sandbox would be ignored until the user
	 * happened to open the settings panel and save.
	 *
	 * An empty model would be taken literally by the worker (it only falls back on
	 * nullish), so send undefined instead and let its default stand.
	 */
	private _pushEngineSettings(settings: ICodeMindPanelSettings = this._readSettings()): void {
		// The active provider owns the endpoint and the key. Its baseUrl drives the engine;
		// telling the engine the active id makes getApiKey() resolve that provider's key for
		// the query. Fall back to the flat baseUrl for pre-migration / legacy installs.
		const active = this._activeProvider();
		this._engineService.setActiveProviderId(active?.id);
		const baseUrl = active ? active.baseUrl : settings.baseUrl;
		this._engineService.updateSettings({
			// '' is meaningful: it takes the custom endpoint back off, so unlike the
			// other fields it is forwarded as-is rather than turned into undefined.
			baseUrl,
			model: settings.model || undefined,
			// '' means "no fallback" — same treatment as the advisor.
			fallbackModel: settings.fallbackModel || undefined,
			maxTurns: settings.maxTurns,
			maxThinkingTokens: settings.maxThinkingTokens,
			systemPrompt: settings.systemPrompt,
			permissionMode: settings.permissionMode,
			effort: settings.effort,
			fastMode: settings.fastMode,
			// '' means "no advisor" — the worker only forwards a non-empty id.
			advisorModel: settings.advisorModel || undefined,
			sandbox: settings.sandbox,
			settingSources: settings.settingSources,
		}).catch(() => { });
	}

	/** Apply settings-panel changes to the engine + configuration service. */
	private _applySettings(settings: ICodeMindPanelSettings): void {
		this._pushEngineSettings(settings);
		// The settings form can set the permission mode too, and plan is one of its four
		// choices. The pane's plan flag has to follow it from here as well, or the form and
		// the composer's mode pill end up disagreeing about whether the next turn may write.
		if (typeof settings.permissionMode === 'string' && PERMISSION_MODES.includes(settings.permissionMode)) {
			const plan = settings.permissionMode === 'plan';
			if (plan !== this._planMode) {
				this._setPlanMode(plan);
				this._postMessage({ type: 'planMode', payload: plan });
			}
		}
		// Mirror everything into user configuration so it survives a restart. Only
		// keys declared in the `codemind` configuration node are accepted here.
		// An empty string is a real value for systemPrompt — that is how the user
		// clears it — so only `undefined` is skipped, plus an empty model.
		const writes: Promise<void>[] = [];
		for (const [key, value] of Object.entries(settings)) {
			// `outputStyleOptions` is derived from disk, not a setting: there is no
			// `codemind.outputStyleOptions` key to write it to.
			if (value === undefined || key === 'outputStyleOptions' || (key === 'model' && value === '')) {
				continue;
			}
			writes.push(this.configurationService.updateValue(`codemind.${key}`, value).catch(() => { }));
		}
		if (settings.model) {
			this._engineService.setModel(settings.model).catch(() => { });
		}
		this._pushFeatureFlags();
		// Echo the stored state back once the writes land, so the panel and the chat
		// surface (vim, mic) reflect what was persisted rather than what was typed.
		// Reading before the writes settle would hand back the previous values.
		Promise.all(writes).then(() => {
			this._postMessage({ type: 'settingsData', payload: this._readSettings() });
			// Turning auto-compaction off moves the ceiling the indicator measures
			// against, so the headroom it shows has to be recomputed.
			this._sendContextStatus();
		});
	}

	/**
	 * Tell the webview which optional surfaces to show. Voice needs both the
	 * engine capability and the user setting; plan/MCP are always available.
	 */
	private _pushFeatureFlags(): void {
		const userEnabled = this._isVoiceModeEnabled();
		this._engineService.getFeatureFlags().then(flags => {
			// The engine's environment can forbid auto-compaction outright; remember
			// that, because the settings panel has to show it as unavailable.
			this._engineAutoCompactAllowed = flags.autoCompact !== false;
			this._postMessage({ type: 'featureFlags', payload: { voiceMode: userEnabled && flags.voiceMode === true } });
			this._postMessage({ type: 'settingsData', payload: this._readSettings() });
		}).catch(() => {
			this._postMessage({ type: 'featureFlags', payload: { voiceMode: false } });
		});
	}

	/** The MCP servers declared in user configuration. */
	private _readMcpServers(): ICodeMindMcpServer[] {
		const configured = this.configurationService.getValue<ICodeMindMcpServer[]>('codemind.mcpServers');
		return Array.isArray(configured) ? configured.filter(s => !!s?.name) : [];
	}

	/** Persist the server list to configuration, then hand it to the engine. */
	private _persistMcpServers(servers: readonly ICodeMindMcpServer[]): void {
		// Strip the live-status fields — they are engine state, not settings.
		const persistable = servers.map(({ name, type, command, args, url, env, enabled }) => ({ name, type, command, args, url, env, enabled }));
		this.configurationService.updateValue('codemind.mcpServers', persistable).catch(() => { });
		this._syncMcpServers(persistable, true);
	}

	/**
	 * Give the engine the configured server set and repaint the panel with whatever
	 * status comes back. `force` re-dials even when the set has not changed, which is
	 * what the Reconnect button asks for; otherwise an unchanged set only repaints, so
	 * that following configuration does not tear working connections down.
	 */
	private _syncMcpServers(servers: readonly ICodeMindMcpServer[] = this._readMcpServers(), force = false): void {
		const persistable = servers.map(({ name, type, command, args, url, env, enabled }) => ({ name, type, command, args, url, env, enabled }));
		const key = JSON.stringify(persistable);
		if (!force && key === this._lastMcpPush) {
			this._sendMcpServers();
			return;
		}
		this._lastMcpPush = key;
		this._engineService.setMcpServers(persistable)
			.then(() => this._sendMcpServers())
			.catch(err => this._appendSystemMessage(`MCP update failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	/** Push the configured servers decorated with the engine's live status. */
	private _sendMcpServers(): void {
		const configured = this._readMcpServers();
		this._engineService.getMcpServers().then(live => {
			// Configuration decides which servers exist; the engine only decorates them
			// with status and tools. A worker that has not dialled yet must not make a
			// configured server vanish from the list.
			const byName = new Map(live.map(s => [s.name, s]));
			const merged: ICodeMindMcpServer[] = configured.map(s => ({ ...s, ...(byName.get(s.name) ?? {}) }));
			const extra = live.filter(s => !configured.some(c => c.name === s.name));
			this._postMessage({ type: 'mcpData', payload: [...merged, ...extra] });
		}).catch(() => {
			this._postMessage({ type: 'mcpData', payload: configured });
		});
	}

	/** Create an empty memory file in the user or project `.claude/memory` dir. */
	private async _createMemoryFile(scope: MemoryScope, name: string): Promise<void> {
		const safeName = name.replace(/[\\/:*?"<>|]/g, '-').trim();
		if (!safeName) {
			this._appendSystemMessage('A memory file needs a name.');
			return;
		}
		const fileName = safeName.endsWith('.md') ? safeName : `${safeName}.md`;
		const root = await this._scopeRoot(scope);
		if (!root) {
			this._appendSystemMessage('Open a folder before creating a project memory file.');
			return;
		}
		const target = URI.joinPath(root, '.claude', 'memory', fileName);
		try {
			if (await this._fileService.exists(target)) {
				this._appendSystemMessage(`${fileName} already exists.`);
			} else {
				await this._fileService.createFile(target, VSBuffer.fromString(`# ${safeName.replace(/\.md$/, '')}\n\n`));
			}
			this._sendPanelData('memory');
			this.openerService.open(target).catch(() => { });
		} catch (err) {
			this._appendSystemMessage(`Could not create ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Delete a file a panel row points at, then refresh that panel. */
	private async _deleteFile(path: string, panelId: PanelId): Promise<void> {
		try {
			await this._fileService.del(URI.file(path), { useTrash: true });
		} catch (err) {
			this._appendSystemMessage(`Could not delete ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		this._sendPanelData(panelId);
	}

	/**
	 * Enable or disable a skill by name. Persisted in `codemind.disabledSkills`
	 * and enforced softly: disabled skills are named in the system prompt suffix
	 * of every subsequent request so the agent leaves them alone.
	 */
	private async _setSkillEnabled(name: string, enabled: boolean): Promise<void> {
		const current = new Set(this.configurationService.getValue<string[]>('codemind.disabledSkills') ?? []);
		if (enabled) {
			current.delete(name);
		} else {
			current.add(name);
		}
		try {
			await this.configurationService.updateValue('codemind.disabledSkills', [...current]);
		} catch {
			// Configuration write failed (read-only settings file); keep the panel honest.
		}
		this._sendPanelData('skills');
	}

	/** Scaffold a new skill directory with a minimal SKILL.md manifest. */
	private async _createSkill(scope: MemoryScope, name: string): Promise<void> {
		const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
		if (!safeName) {
			this._appendSystemMessage('A skill needs a name.');
			return;
		}
		const root = await this._scopeRoot(scope);
		if (!root) {
			this._appendSystemMessage('Open a folder before creating a project skill.');
			return;
		}
		const manifest = URI.joinPath(root, '.claude', 'skills', safeName, 'SKILL.md');
		try {
			if (await this._fileService.exists(manifest)) {
				this._appendSystemMessage(`Skill "${safeName}" already exists.`);
			} else {
				const body = [
					'---',
					`name: ${safeName}`,
					'description: Describe when the agent should use this skill.',
					'---',
					'',
					`# ${safeName}`,
					'',
					'Write the instructions the agent should follow here.',
					'',
				].join('\n');
				await this._fileService.createFile(manifest, VSBuffer.fromString(body));
			}
			this._sendPanelData('skills');
			this.openerService.open(manifest).catch(() => { });
		} catch (err) {
			this._appendSystemMessage(`Could not create the skill: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Resolve the root directory for a `user` / `project` scoped write. */
	private async _scopeRoot(scope: MemoryScope): Promise<URI | undefined> {
		if (scope === 'user') {
			return this._pathService.userHome();
		}
		return this._workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	/** Native file/image picker; selected paths go back to the input as chips. */
	private async _pickFiles(): Promise<void> {
		const picked = await this._fileDialogService.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			title: localize('codeMindAttachTitle', 'Attach files to the CodeMind Agent'),
			defaultUri: this._workspaceContextService.getWorkspace().folders[0]?.uri,
		});
		if (picked?.length) {
			this._postMessage({ type: 'attachPaths', payload: picked.map(uri => uri.fsPath) });
		}
		this._postMessage({ type: 'focusInput' });
	}

	/**
	 * Answer the `@` mention picker with workspace files matching `query`. The query
	 * travels back with the results: one keystroke per request means replies can land
	 * out of order, and a late reply for a shorter prefix must not replace the list the
	 * composer is already showing. Now with requestId-based cancellation and an empty-query
	 * fast path that seeds from open editors instead of walking the full tree.
	 */
	private async _sendMentionItems(query: string, requestId: string): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (!folders.length) {
			this._postMessage({ type: 'mentionItems', payload: { query, requestId, items: [] } });
			return;
		}

		// Cancel any prior request under this same requestId (client debounces, but still cancels stale)
		const cancel = new CancellationTokenSource();
		const prior = this._mentionCancellation.get(requestId);
		if (prior) { prior.cancel(); prior.dispose(); }
		this._mentionCancellation.set(requestId, cancel);

		try {
			let items: Array<{ label: string; path: string; detail?: string }> = [];

			if (!query.trim()) {
				// Fast path: seed from open editors instead of fileSearch (which walks the full tree)
				const editors = this._editorService.editors.slice(0, 30);
				items = editors.map(editor => {
					const uri = editor.resource;
					if (!uri) { return null; }
					const fsPath = uri.fsPath;
					const label = uri.path.split('/').pop() ?? fsPath;
					const folder = this._workspaceContextService.getWorkspaceFolder(uri);
					const detail = folder ? fsPath.slice(folder.uri.fsPath.length + 1) : fsPath;
					return { label, path: fsPath, detail };
				}).filter((item): item is { label: string; path: string; detail: string } => item !== null);
			} else {
				// Real search with cancellation token and cacheKey for incremental prefix search
				const result = await this._searchService.fileSearch({
					type: QueryType.File,
					folderQueries: folders.map(folder => ({ folder: folder.uri })),
					filePattern: query,
					sortByScore: true,
					maxResults: 30,
					cacheKey: 'codemindMention',
					_reason: 'codemindAgentMention',
				}, cancel.token);
				if (cancel.token.isCancellationRequested) { return; }
				items = result.results.map(match => {
					const fsPath = match.resource.fsPath;
					const label = match.resource.path.split('/').pop() ?? fsPath;
					const folder = this._workspaceContextService.getWorkspaceFolder(match.resource);
					const detail = folder ? fsPath.slice(folder.uri.fsPath.length + 1) : fsPath;
					return { label, path: fsPath, detail };
				});
			}
			this._postMessage({ type: 'mentionItems', payload: { query, requestId, items } });
		} catch (err) {
			// Only surface non-cancellation failures; tolerate either signature of isCancellationError
			const name = (err as any)?.name;
			if (name !== 'CancellationError' && name !== 'Canceled') {
				this._postMessage({ type: 'mentionItems', payload: { query, requestId, items: [] } });
			}
		} finally {
			this._mentionCancellation.delete(requestId);
			cancel.dispose();
		}
	}

	private _cancelMentionRequest(requestId: string): void {
		const cancel = this._mentionCancellation.get(requestId);
		if (cancel) {
			cancel.cancel();
			cancel.dispose();
			this._mentionCancellation.delete(requestId);
		}
	}

	private async _resolveImagePreview(path: string): Promise<void> {
		try {
			const uri = URI.file(path);
			const content = await this._fileService.readFile(uri);
			const ext = path.split('.').pop()?.toLowerCase() || 'png';
			const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
			const mime = mimeMap[ext] || 'image/png';
			const b64 = encodeBase64(content.value);
			const dataUrl = `data:${mime};base64,${b64}`;
			this._postMessage({ type: 'imagePreview', payload: { path, dataUrl } });
		} catch {
			// silently fail — hover just won't show
		}
	}

	/**
	 * Test the supplied key with one minimal request to the endpoint. The panel may
	 * send a base URL along with it — the one typed into the form but not saved yet —
	 * so a new endpoint can be checked before it is committed.
	 */
	private _validateApiKey(payload: string | { key?: string; baseUrl?: string }): void {
		const key = typeof payload === 'string' ? payload : payload.key;
		const baseUrl = typeof payload === 'string' ? undefined : payload.baseUrl;
		// An empty field is not an error: the service checks the stored key instead.
		this._engineService.validateApiKey(key, baseUrl).then(result => {
			this._appendSystemMessage(`${result.ok ? 'OK' : 'Failed'} · ${result.endpoint} — ${result.detail}`);
		}).catch(err => {
			this._appendSystemMessage(`Could not validate the key: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	/**
	 * Ask the endpoint which models it serves and hand the list to the settings
	 * panel. Failures come back as a message rather than an empty list: "this URL
	 * has no model list" and "this URL is wrong" need different fixes.
	 */
	private _fetchEndpointModels(key?: string, baseUrl?: string): void {
		const endpoint = (baseUrl ?? this.configurationService.getValue<string>('codemind.baseUrl') ?? '').trim() || 'https://api.anthropic.com';
		this._engineService.listEndpointModels(key, baseUrl).then(models => {
			this._postMessage({ type: 'endpointModels', payload: { endpoint, models: [...models] } });
			this._appendSystemMessage(models.length
				? `${endpoint} serves ${models.length} Anthropic model${models.length === 1 ? '' : 's'}.`
				: `${endpoint} listed no Anthropic-compatible models.`);
		}).catch(err => {
			const error = err instanceof Error ? err.message : String(err);
			this._postMessage({ type: 'endpointModels', payload: { endpoint, error } });
			this._appendSystemMessage(`Could not list models: ${error}`);
		});
	}

	/** Persist the providers array and re-seed the engine (endpoint may have changed). */
	private _applyProviders(providers: ICodeMindProvider[]): void {
		const clean = Array.isArray(providers) ? providers : [];
		this.configurationService.updateValue('codemind.providers', clean).then(() => {
			// If the active provider was removed or disabled, fall back to the first enabled one.
			const active = this._readActiveProviderId(this._readProviders());
			if (active !== (this.configurationService.getValue<string>('codemind.activeProviderId') ?? '')) {
				return this.configurationService.updateValue('codemind.activeProviderId', active ?? '');
			}
			return undefined;
		}).then(() => {
			this._pushEngineSettings();
			this._postMessage({ type: 'settingsData', payload: this._readSettings() });
		}).catch(() => { });
	}

	/** Validate a provider's key against its endpoint, without storing it. */
	private _validateProviderKey(payload: { providerId?: string; key?: string; baseUrl?: string }): void {
		this._engineService.validateApiKey(payload.key, payload.baseUrl).then(result => {
			this._appendSystemMessage(`${result.ok ? 'OK' : 'Failed'} · ${result.endpoint} — ${result.detail}`);
		}).catch(err => {
			this._appendSystemMessage(`Could not validate the key: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	private _fetchProviderModels(payload: { providerId: string; key?: string; baseUrl?: string }): void {
		const endpoint = (payload.baseUrl ?? '').trim() || 'https://api.anthropic.com';
		this._engineService.listEndpointModels(payload.key, payload.baseUrl).then(models => {
			this._postMessage({ type: 'providerModels', payload: { providerId: payload.providerId, endpoint, models: [...models] } });
		}).catch(err => {
			const error = err instanceof Error ? err.message : String(err);
			this._postMessage({ type: 'providerModels', payload: { providerId: payload.providerId, endpoint, error } });
		});
	}

	/**
	 * Make a provider active: persist the id, point the engine at its endpoint + key,
	 * and settle on a model to run.
	 *
	 * The model is chosen so a plain provider switch does not silently move the user
	 * off the model they were on: an explicit `model` (a composer pick) wins when the
	 * provider serves it; otherwise the current `codemind.model` is kept if this
	 * provider also lists it; only then does it fall back to the provider's first
	 * model. Picking a composer model that belongs to another provider therefore
	 * swaps endpoint + key + model together, which is what makes a cross-provider pick
	 * hit the right endpoint on the next turn.
	 */
	private _setActiveProvider(providerId: string, model?: string): void {
		const provider = this._readProviders().find(p => p.id === providerId && p.enabled);
		if (!provider) {
			return;
		}
		const current = (this.configurationService.getValue<string>('codemind.model') ?? '').trim();
		const nextModel = (model && provider.models.includes(model)) ? model
			: (current && provider.models.includes(current)) ? current
				: (provider.models[0] ?? '');
		this.configurationService.updateValue('codemind.activeProviderId', providerId)
			.then(() => this.configurationService.updateValue('codemind.baseUrl', provider.baseUrl))
			.then(() => nextModel ? this.configurationService.updateValue('codemind.model', nextModel) : undefined)
			.then(() => {
				this._engineService.setActiveProviderId(providerId);
				if (nextModel) {
					this._engineService.setModel(nextModel).catch(() => { });
				}
				this._pushEngineSettings();
				this._postMessage({ type: 'settingsData', payload: this._readSettings() });
			}).catch(() => { });
	}

	private _isVoiceModeEnabled(): boolean {
		return this.configurationService.getValue<boolean>('codemind.voiceMode') === true;
	}

	/**
	 * The host the turn is talking to, for the "still connecting" subtitle. A host is
	 * enough to tell a custom gateway apart from the real API, which is the whole
	 * point of naming it — and it keeps any path, query or credential in a
	 * hand-typed URL out of the panel. Falls back to the raw string when it will not
	 * parse, since something the user can recognise beats nothing.
	 */
	private _endpointLabel(): string {
		const configured = (this.configurationService.getValue<string>('codemind.baseUrl') ?? '').trim();
		if (!configured) { return 'api.anthropic.com'; }
		try {
			return new URL(configured).host || configured;
		} catch {
			return configured;
		}
	}

	/** Push a system note into the history and the webview. */
	private _appendSystemMessage(text: string): void {
		const systemMessage: AgentMessage = { id: this._generateId(), type: 'system', content: text, timestamp: Date.now() };
		this._history.push(systemMessage);
		this._postMessage({ type: 'newMessage', payload: systemMessage });
	}

	/**
	 * Composer shell mode (`!`): run the line the user typed, show what it printed,
	 * and keep the output for the next prompt so the agent sees it too — the CLI
	 * puts bash-mode output straight into the conversation.
	 */
	private async _runShellInput(command: string): Promise<void> {
		const line = command.trim();
		if (!line) {
			return;
		}

		// No echo bubble: the `$ <command>` line of the output block below is the
		// record of what ran, so a separate user turn would just repeat it.
		this._postMessage({ type: 'status', payload: 'busy' });

		let result: ICodeMindExecResult;
		try {
			result = await this._engineService.execShell({ command: line, cwd: this._workspaceRoot()?.fsPath });
		} catch (err) {
			result = { exitCode: -1, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
		}

		const output = [result.stdout, result.stderr, result.error].map(part => (part ?? '').trim()).filter(Boolean).join('\n');
		const body = output || '(no output)';
		const failed = result.exitCode !== 0;
		const shown: AgentMessage = {
			id: this._generateId(),
			type: 'shell',
			content: `$ ${line}\n${body}${failed ? `\n[exit ${result.exitCode}]` : ''}`,
			timestamp: Date.now(),
		};
		this._history.push(shown);
		this._postMessage({ type: 'newMessage', payload: shown });
		this._postMessage({ type: 'status', payload: 'ready' });
		this._postMessage({ type: 'focusInput' });

		// Cap what rides along: a `!` on a chatty build should not swallow the turn.
		const forContext = body.length > 8000 ? `${body.slice(0, 8000)}\n… output truncated.` : body;
		this._pendingContext.push(`<local-command-stdout command="${line}" exit-code="${result.exitCode}">\n${forContext}\n</local-command-stdout>`);
	}

	/**
	 * Composer memory mode (`#`): append the note to a CLAUDE.md the engine loads on
	 * every request. The user picks which one, as in the CLI — project memory is
	 * shared with the repo, user memory follows them everywhere.
	 */
	private async _appendToMemory(text: string): Promise<void> {
		const note = text.trim();
		if (!note) {
			return;
		}

		const home = await this._pathService.userHome();
		const root = this._workspaceRoot();
		const targets: Array<{ id: string; label: string; description?: string; detail?: string; uri: URI }> = [];
		if (root) {
			targets.push({ id: 'project', label: 'Project memory', description: 'CLAUDE.md', detail: URI.joinPath(root, 'CLAUDE.md').fsPath, uri: URI.joinPath(root, 'CLAUDE.md') });
			targets.push({ id: 'local', label: 'Project memory (not shared)', description: 'CLAUDE.local.md', detail: URI.joinPath(root, 'CLAUDE.local.md').fsPath, uri: URI.joinPath(root, 'CLAUDE.local.md') });
		}
		targets.push({ id: 'user', label: 'User memory', description: '~/.claude/CLAUDE.md', detail: URI.joinPath(home, '.claude', 'CLAUDE.md').fsPath, uri: URI.joinPath(home, '.claude', 'CLAUDE.md') });

		const chosenId = targets.length === 1 ? targets[0].id : await this._pick('Add this note to which memory file?', targets);
		if (!chosenId) {
			this._appendSystemMessage('Memory note discarded.');
			return;
		}
		const target = targets.find(t => t.id === chosenId);
		if (!target) {
			return;
		}

		try {
			let existing = '';
			if (await this._fileService.exists(target.uri)) {
				existing = (await this._fileService.readFile(target.uri)).value.toString();
			}
			// One bullet per note, appended under whatever structure the file has.
			const separator = !existing ? '' : existing.endsWith('\n') ? '' : '\n';
			const contents = `${existing}${separator}- ${note.replace(/\n+/g, ' ')}\n`;
			await this._fileService.writeFile(target.uri, VSBuffer.fromString(contents));
			this._appendSystemMessage(`Added to ${target.label} (${target.uri.fsPath}).`);
			this._sendPanelData('memory');
		} catch (err) {
			this._appendSystemMessage(`Could not write ${target.uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Take the queued shell-mode output, if any, to prefix the next prompt with. */
	private _takePendingContext(): string {
		if (!this._pendingContext.length) {
			return '';
		}
		const blocks = this._pendingContext.join('\n');
		this._pendingContext.length = 0;
		return `The user ran these commands in the panel just before this message:\n${blocks}\n\n`;
	}

	/**
	 * Take the partial answer of a stopped turn, to prefix the next prompt with, so the
	 * engine's transcript has a record of it. Capped: the point is continuity, and a very
	 * long partial answer would cost more of the window than the record is worth.
	 */
	private _takeInterruptedTurn(): string {
		const partial = (this._interruptedTurn ?? '').trim();
		this._interruptedTurn = undefined;
		if (!partial) {
			return '';
		}
		const limit = CodeMindAgentViewPane.INTERRUPTED_TURN_MAX_CHARS;
		const body = partial.length > limit
			? `${partial.slice(0, limit)}\n… cut off here when the panel saved it.`
			: partial;
		return `<interrupted-turn>\nThe user stopped your previous reply part-way through, so it is not in the transcript above. This is what you had said when it was stopped:\n${body}\n</interrupted-turn>\n\n`;
	}

	/**
	 * Remember the todo list from a TodoWrite call so the Tasks panel shows the
	 * agent's real plan rather than a placeholder.
	 */
	private _captureTodos(toolName: string, input: unknown): void {
		if (toolName !== 'TodoWrite' && toolName !== 'TodoWriteTool') {
			return;
		}
		const todos = (input as { todos?: unknown })?.todos;
		if (!Array.isArray(todos)) {
			return;
		}
		this._todos = todos
			.filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
			.map(t => ({
				content: String(t.content ?? ''),
				status: String(t.status ?? 'pending'),
				activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
			}))
			.filter(t => t.content);
		// Refresh the panel if it happens to be open.
		this._postMessage({ type: 'panelData', payload: { panelId: 'tasks', items: this._collectTasks() } });
	}

	/** Resolve the rows a panel should show, then push them to the webview. */
	private _sendPanelData(panelId: PanelId): void {
		const resolve = panelId === 'memory'
			? this._collectMemoryFiles()
			: panelId === 'skills'
				? this._collectSkills()
				: Promise.resolve(this._collectTasks());
		resolve.then(items => {
			this._postMessage({ type: 'panelData', payload: { panelId, items } });
		}).catch(() => {
			this._postMessage({ type: 'panelData', payload: { panelId, items: [] } });
		});
	}

	/**
	 * Enumerate the CLAUDE.md memory files the agent can draw on: the user-level
	 * file, the workspace-level file, and every `.md` under the workspace's
	 * `.claude/memory/` directory. Auto-loaded files are flagged so the panel can
	 * highlight what is already in the agent's context.
	 */
	private async _collectMemoryFiles(): Promise<IPanelDataItem[]> {
		const items: IPanelDataItem[] = [];
		const home = await this._pathService.userHome();
		const workspaceRoot = this._workspaceContextService.getWorkspace().folders[0]?.uri;

		const candidates: Array<{ uri: URI; detail: string }> = [
			{ uri: URI.joinPath(home, '.claude', 'CLAUDE.md'), detail: 'User memory' },
		];
		if (workspaceRoot) {
			candidates.push(
				{ uri: URI.joinPath(workspaceRoot, 'CLAUDE.md'), detail: 'Project memory' },
				{ uri: URI.joinPath(workspaceRoot, '.claude', 'CLAUDE.md'), detail: 'Project memory (.claude)' },
			);
		}
		for (const candidate of candidates) {
			const stat = await this._statOrUndefined(candidate.uri);
			if (stat) {
				items.push({
					label: candidate.uri.path.split('/').pop() ?? 'CLAUDE.md',
					detail: candidate.detail,
					path: candidate.uri.fsPath,
					size: stat.size,
					mtime: stat.mtime,
					// CLAUDE.md files are read on every request by the engine itself.
					loaded: true,
				});
			}
		}

		// Directory-based memories (one fact per file).
		const memoryDirs: Array<{ uri: URI; detail: string }> = [{ uri: URI.joinPath(home, '.claude', 'memory'), detail: 'User memory file' }];
		if (workspaceRoot) {
			memoryDirs.push({ uri: URI.joinPath(workspaceRoot, '.claude', 'memory'), detail: 'Project memory file' });
		}
		for (const dir of memoryDirs) {
			const files = await this._listFiles(dir.uri, name => name.endsWith('.md'), dir.detail);
			for (const file of files) {
				// MEMORY.md is the index the engine loads with every session.
				items.push({ ...file, loaded: file.label.toUpperCase() === 'MEMORY.MD', deletable: true });
			}
		}

		// The engine's own memory directory for this workspace, which is where it
		// actually writes: `~/.claude/projects/<project>/memory/`, with dated notes
		// filed under `logs/<year>/<month>/`.
		const project = this._projectDirName();
		if (project) {
			const engineMemory = URI.joinPath(home, '.claude', 'projects', project, 'memory');
			for (const file of await this._listFiles(engineMemory, name => name.endsWith('.md'), 'Engine memory')) {
				items.push({ ...file, loaded: file.label.toUpperCase() === 'MEMORY.MD', deletable: true });
			}
			for (const log of await this._listMemoryLogs(URI.joinPath(engineMemory, 'logs'))) {
				items.push(log);
			}
		}
		return items;
	}

	/**
	 * The dated memory notes under `memory/logs/<year>/<month>/`. Two levels of
	 * directories, so walk them rather than listing one flat folder, and label each
	 * file with the month it belongs to.
	 */
	private async _listMemoryLogs(root: URI): Promise<IPanelDataItem[]> {
		const items: IPanelDataItem[] = [];
		let years;
		try {
			years = (await this._fileService.resolve(root)).children ?? [];
		} catch {
			return items;
		}
		for (const year of years.filter(child => child.isDirectory)) {
			let months;
			try {
				months = (await this._fileService.resolve(year.resource)).children ?? [];
			} catch {
				continue;
			}
			for (const month of months.filter(child => child.isDirectory)) {
				const files = await this._listFiles(month.resource, name => name.endsWith('.md'), `Memory log ${year.name}-${month.name}`);
				items.push(...files.map(file => ({ ...file, deletable: true })));
			}
		}
		return items;
	}

	/**
	 * Enumerate skills: every `<skill>/SKILL.md` under the user-level and
	 * workspace-level `.claude/skills/` directories, plus the built-in tools the
	 * engine always exposes. Skill rows carry their enabled state and the tools
	 * their manifest declares.
	 */
	private async _collectSkills(): Promise<IPanelDataItem[]> {
		const items: IPanelDataItem[] = [];
		const home = await this._pathService.userHome();
		const workspaceRoot = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		const disabled = new Set(this.configurationService.getValue<string[]>('codemind.disabledSkills') ?? []);

		const skillRoots: Array<{ uri: URI; detail: string }> = [
			{ uri: URI.joinPath(home, '.claude', 'skills'), detail: 'User skill' },
		];
		if (workspaceRoot) {
			skillRoots.push({ uri: URI.joinPath(workspaceRoot, '.claude', 'skills'), detail: 'Project skill' });
		}
		for (const root of skillRoots) {
			let entries;
			try {
				entries = await this._fileService.resolve(root.uri);
			} catch {
				continue;
			}
			for (const child of entries.children ?? []) {
				if (!child.isDirectory) {
					continue;
				}
				const manifest = URI.joinPath(child.resource, 'SKILL.md');
				const stat = await this._statOrUndefined(manifest);
				if (!stat) {
					continue;
				}
				const meta = await this._readSkillManifest(manifest);
				items.push({
					label: child.name,
					detail: meta.description ? `${root.detail} — ${meta.description}` : root.detail,
					path: manifest.fsPath,
					size: stat.size,
					mtime: stat.mtime,
					enabled: !disabled.has(child.name),
					tools: meta.tools,
					deletable: false,
				});
			}
		}

		for (const tool of this._engineTools ?? CodeMindAgentViewPane.BUILTIN_TOOLS) {
			// Built-in tools go through the same disabled set as skills, so unticking
			// one here reaches the agent via the system-prompt suffix.
			items.push({ label: tool, detail: 'Built-in tool', enabled: !disabled.has(tool) });
		}
		return items;
	}

	/**
	 * Pull `description` and `allowed-tools` out of a SKILL.md YAML front matter
	 * block. Front matter is a flat `key: value` list, so a line scan is enough.
	 */
	private async _readSkillManifest(manifest: URI): Promise<{ description?: string; tools?: string[] }> {
		let text: string;
		try {
			text = (await this._fileService.readFile(manifest)).value.toString();
		} catch {
			return {};
		}
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		if (!match) {
			return {};
		}
		const result: { description?: string; tools?: string[] } = {};
		for (const line of match[1].split(/\r?\n/)) {
			const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
			if (!kv) {
				continue;
			}
			const key = kv[1].toLowerCase();
			const value = kv[2].trim().replace(/^["']|["']$/g, '');
			if (key === 'description') {
				result.description = value;
			} else if (key === 'allowed-tools' || key === 'tools') {
				result.tools = value.replace(/^\[|\]$/g, '').split(',').map(t => t.trim()).filter(Boolean);
			}
		}
		return result;
	}

	/** The agent's current todo list, captured from TodoWrite tool calls. */
	private _collectTasks(): IPanelDataItem[] {
		return this._todos.map((todo, index) => ({ label: todo.content, detail: todo.activeForm, status: todo.status, index }));
	}

	/**
	 * Re-read `.claude/output-styles/` and republish the settings payload so the
	 * settings panel's style dropdown lists what is actually on disk. Returns the
	 * styles it found, which is what `/output-style` renders.
	 */
	private async _refreshOutputStyles(): Promise<readonly ICodeMindOutputStyle[]> {
		const styles = await this._collectOutputStyles();
		this._customOutputStyles.clear();
		for (const style of styles) {
			this._customOutputStyles.set(style.name, style);
		}
		this._postMessage({ type: 'settingsData', payload: this._readSettings() });
		return styles;
	}

	/**
	 * Load every `<name>.md` under the user-level and workspace-level
	 * `.claude/output-styles/` directories. The file body is the prompt; the front
	 * matter may rename and describe it. A project style shadows a user style of the
	 * same name, which is the order the CLI loads them in.
	 */
	private async _collectOutputStyles(): Promise<ICodeMindOutputStyle[]> {
		const home = await this._pathService.userHome();
		const workspaceRoot = this._workspaceRoot();
		const roots: Array<{ uri: URI; source: string }> = [
			{ uri: URI.joinPath(home, '.claude', 'output-styles'), source: 'User style' },
		];
		if (workspaceRoot) {
			roots.push({ uri: URI.joinPath(workspaceRoot, '.claude', 'output-styles'), source: 'Project style' });
		}
		const byName = new Map<string, ICodeMindOutputStyle>();
		for (const root of roots) {
			let entries;
			try {
				entries = await this._fileService.resolve(root.uri);
			} catch {
				continue;
			}
			for (const child of entries.children ?? []) {
				if (child.isDirectory || !/\.md$/i.test(child.name)) {
					continue;
				}
				const style = await this._readOutputStyle(child.resource, child.name.replace(/\.md$/i, ''), root.source);
				if (style) {
					// A built-in name would be unreachable through `/output-style`, whose
					// lookup hits the built-in first, so drop it rather than list a row
					// that cannot be selected.
					if (OUTPUT_STYLES.some(builtin => builtin.toLowerCase() === style.name.toLowerCase())) {
						continue;
					}
					byName.set(style.name.toLowerCase(), style);
				}
			}
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Parse one output-style file: optional YAML front matter, then the prompt. Same
	 * flat `key: value` scan as {@link _readSkillManifest} — the CLI's own loader
	 * reads only `name`, `description` and `keep-coding-instructions`.
	 */
	private async _readOutputStyle(resource: URI, fallbackName: string, source: string): Promise<ICodeMindOutputStyle | undefined> {
		let text: string;
		try {
			text = (await this._fileService.readFile(resource)).value.toString();
		} catch {
			return undefined;
		}
		let name = fallbackName;
		let description = '';
		let keepCodingInstructions: boolean | undefined;
		let body = text;
		const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
		if (match) {
			body = text.slice(match[0].length);
			for (const line of match[1].split(/\r?\n/)) {
				const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
				if (!kv) {
					continue;
				}
				const key = kv[1].toLowerCase();
				const value = kv[2].trim().replace(/^["']|["']$/g, '');
				if (key === 'name' && value) {
					name = value;
				} else if (key === 'description') {
					description = value;
				} else if (key === 'keep-coding-instructions') {
					// YAML booleans, plus the strings a hand-written file is likely to use.
					keepCodingInstructions = /^(true|yes|on)$/i.test(value);
				}
			}
		}
		const prompt = body.trim();
		if (!prompt) {
			// An empty body would silently do nothing, so treat it as not a style.
			return undefined;
		}
		return { name, description, prompt, source, path: resource.fsPath, keepCodingInstructions };
	}

	/** Stat a file, treating any failure (missing, unreadable) as "not there". */
	private async _statOrUndefined(uri: URI): Promise<{ size?: number; mtime?: number } | undefined> {
		try {
			const stat = await this._fileService.stat(uri);
			return stat.isFile ? { size: stat.size, mtime: stat.mtime } : undefined;
		} catch {
			return undefined;
		}
	}

	/** List files in a directory, ignoring a missing directory. */
	private async _listFiles(dir: URI, filter: (name: string) => boolean, detail: string): Promise<IPanelDataItem[]> {
		try {
			const stat = await this._fileService.resolve(dir, { resolveMetadata: true });
			return (stat.children ?? [])
				.filter(child => !child.isDirectory && filter(child.name))
				.map(child => ({ label: child.name, detail, path: child.resource.fsPath, size: child.size, mtime: child.mtime }));
		} catch {
			return [];
		}
	}

	/** Build the context object every slash command receives. */
	private _commandContext(): ICodeMindCommandContext {
		return {
			engineService: this._engineService,
			workspaceRoot: this._workspaceRoot()?.fsPath ?? '',
			appendSystemMessage: (msg) => this._appendSystemMessage(msg),
			openPanel: (panelId) => this._postMessage({ type: 'openPanel', payload: { panelId } }),
			refreshView: () => {
				this._history.length = 0;
				this._lastSessionId = undefined;
				this._pendingResumeSessionId = undefined;
				this._interruptedTurn = undefined;
				this._engineService.clearSession().catch(() => { });
				this._postMessage({ type: 'history', payload: [] });
				this._persistState();
			},

			// --- agent turns
			sendToAgent: (prompt) => this._sendMessage(prompt),
			silentQuery: (prompt) => this._silentQuery(prompt),
			// One round trip, every tool refused, no session resume or adoption: the
			// answer comes from the conversation the engine already has.
			sideQuery: (question) => this._silentQuery(question, { maxTurns: 1, blockAllTools: true, isolated: true }),

			// --- panel modes
			// Configuration is the single mover for vim: `_updateConfig` pushes
			// `settingsData`, which the chat surface applies. Flipping the webview
			// directly would leave the settings checkbox showing the opposite.
			toggleVim: () => this._updateConfig('codemind.vimMode', !this._isVimMode()),
			isVimMode: () => this._isVimMode(),
			setPlanMode: (enabled) => {
				this._setPlanMode(enabled);
				this._postMessage({ type: 'planMode', payload: enabled });
			},
			isPlanMode: () => this._planMode,

			// --- model, permissions and output style
			getModel: () => this.configurationService.getValue<string>('codemind.model') ?? '',
			setModel: async (model) => {
				await this._updateConfig('codemind.model', model);
				await this._engineService.setModel(model);
			},
			getPermissionMode: () => this.configurationService.getValue<string>('codemind.permissionMode') ?? 'default',
			setPermissionMode: async (mode) => {
				await this._updateConfig('codemind.permissionMode', mode);
				await this._engineService.updateSettings({ permissionMode: mode });
			},
			getOutputStyle: () => this.configurationService.getValue<string>('codemind.outputStyle') ?? 'default',
			// The style shapes the per-turn system prompt suffix, so nothing needs to
			// be pushed to the engine here — the next request picks it up. The panel
			// repaint happens in `_updateConfig`.
			setOutputStyle: async (style) => {
				await this._updateConfig('codemind.outputStyle', style);
			},
			// Re-walked on demand: a style file written a moment ago must show up in
			// `/output-style` without reloading the window.
			listOutputStyles: () => this._refreshOutputStyles(),
			isCoordinatorMode: () => this.configurationService.getValue<boolean>('codemind.coordinatorMode') === true,
			setCoordinatorMode: async (enabled) => { await this._updateConfig('codemind.coordinatorMode', enabled); },
			isAutoCompactEnabled: () => this._isAutoCompactEnabled(),

			// --- transcript
			transcript: () => this._history
				.filter(m => m.type === 'user' || m.type === 'assistant')
				.map(m => ({ role: m.type, content: m.content, timestamp: m.timestamp })),
			replaceTranscript: (summary) => this._replaceTranscript(summary),
			rewind: (turns) => this._rewind(turns),

			// --- editors and files
			openDiff: (relativePath) => this._openDiff(relativePath),
			openCommitReview: (message, files) => {
				this._pendingCommitFiles = [...files];
				this._postMessage({ type: 'commitReview', payload: { message, files: [...files] } });
			},
			saveTextFile: (defaultName, contents) => this._saveTextFile(defaultName, contents),
			readTextFile: (relativePath) => this._readTextFile(relativePath),
			writeTextFile: (relativePath, contents, overwrite) => this._writeTextFile(relativePath, contents, overwrite),
			fileExists: (relativePath) => this._fileExists(relativePath),
			listDirectory: (relativePath) => this._listDirectoryNames(relativePath),
			addDirectory: (path) => this._addDirectory(path),

			storedSessionId: () => this._lastSessionId,
			listSessions: (allProjects) => this._listSessions(allProjects),
			projectInsights: () => this._collectProjectInsights(),

			// --- workbench interaction
			copyToClipboard: (text) => this._clipboardService.writeText(text),
			pick: (placeHolder, items) => this._pick(placeHolder, items),
			promptText: (prompt, value) => this._quickInputService.input({ prompt, value, ignoreFocusLost: true }),
			openExternal: async (url) => { await this.openerService.open(URI.parse(url), { openExternal: true }); },
			runWorkbenchCommand: async (id, ...args) => { await this._commandService.executeCommand(id, ...args); },
			listColorThemes: async () => (await this._workbenchThemeService.getColorThemes()).map(t => describeColorTheme(t)),
			getColorTheme: () => describeColorTheme(this._workbenchThemeService.getColorTheme()),
			// The picker writes the user setting; so does this, or the theme would be back
			// to the configured one the next time the window opens.
			setColorTheme: async (id) => { await this._workbenchThemeService.setColorTheme(id, ConfigurationTarget.USER); },
			hidePanel: () => this._layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART),

			// --- configuration passthrough
			getConfig: <T>(key: string) => this.configurationService.getValue<T>(key),
			setConfig: async (key, value) => {
				await this._updateConfig(key, value);
				// `codemind.*` keys the engine cares about (effort, fastMode, advisor,
				// sandbox) only take effect once the worker is told.
				this._pushEngineSettings();
			},

			// --- session decorations (in memory: the CLI scopes these to one session)
			setSessionName: (name) => this._setSessionName(name),
			getSessionName: () => this._sessionName,
			setPromptColor: (color) => this._setPromptColor(color),
			getPromptColor: () => this._promptColor,
			toggleTag: (tag) => this._toggleTag(tag),
			getTags: () => this._sessionTags,

			// --- engine home directory (~/.claude): plugins, skills, agents, hooks
			readHomeFile: (relativePath) => this._readHomeFile(relativePath),
			writeHomeFile: (relativePath, contents) => this._writeHomeFile(relativePath, contents),
			listHomeEntries: (relativePath) => this._listHomeEntries(relativePath),

			// --- companion
			getCompanion: () => this._companion(),
			hatchCompanion: () => this._hatchCompanion(),
			forgetCompanion: () => this._forgetCompanion(),
			petCompanion: () => this._postMessage({ type: 'companionPet' }),
			sayCompanion: (text) => this._postMessage({ type: 'companionReaction', payload: { text } }),
		};
	}

	/** Show a quick pick and resolve with the chosen item's id. */
	private async _pick(placeHolder: string, items: readonly { id: string; label: string; description?: string; detail?: string }[]): Promise<string | undefined> {
		type Item = IQuickPickItem & { id: string };
		const picks: Item[] = items.map(i => ({ id: i.id, label: i.label, description: i.description, detail: i.detail }));
		const chosen = await this._quickInputService.pick<Item>(picks, { placeHolder, ignoreFocusLost: true });
		return chosen?.id;
	}

	/** Set the session display name and repaint the header. */
	private async _setSessionName(name: string): Promise<void> {
		this._sessionName = name;
		this._postMessage({ type: 'sessionName', payload: { name, tags: this._sessionTags } });
	}

	/** Set the prompt-bar accent. An empty string restores the theme default. */
	private async _setPromptColor(color: string): Promise<void> {
		this._promptColor = color;
		this._postMessage({ type: 'promptColor', payload: { color } });
	}

	/** Add or remove a session tag, returning the resulting set. */
	private async _toggleTag(tag: string): Promise<readonly string[]> {
		const index = this._sessionTags.indexOf(tag);
		if (index >= 0) {
			this._sessionTags.splice(index, 1);
		} else {
			this._sessionTags.push(tag);
		}
		this._postMessage({ type: 'sessionName', payload: { name: this._sessionName, tags: this._sessionTags } });
		return this._sessionTags;
	}

	/** Read a file under the user's `~/.claude` engine home. */
	private async _readHomeFile(relativePath: string): Promise<string | undefined> {
		const target = await this._resolveHomePath(relativePath);
		if (!target) {
			return undefined;
		}
		try {
			const content = await this._fileService.readFile(target);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	/**
	 * Write a file under `~/.claude`, creating the directory when it is missing.
	 * The engine reads user-scope settings from here, so the commands that edit
	 * permission rules, hooks or agents need to be able to write it.
	 */
	private async _writeHomeFile(relativePath: string, contents: string): Promise<string | undefined> {
		const target = await this._resolveHomePath(relativePath);
		if (!target) {
			return undefined;
		}
		try {
			await this._fileService.writeFile(target, VSBuffer.fromString(contents));
			return target.fsPath;
		} catch {
			return undefined;
		}
	}

	/** List the entry names directly under a `~/.claude` subdirectory. */
	private async _listHomeEntries(relativePath: string): Promise<string[]> {
		const target = await this._resolveHomePath(relativePath);
		if (!target) {
			return [];
		}
		try {
			const stat = await this._fileService.resolve(target);
			return (stat.children ?? []).map(c => c.name).sort((a, b) => a.localeCompare(b));
		} catch {
			return [];
		}
	}

	/**
	 * Resolve a path under `~/.claude`, refusing anything that escapes it — the
	 * relative path comes from a slash-command argument.
	 */
	private async _resolveHomePath(relativePath: string): Promise<URI | undefined> {
		const segments = relativePath.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
		if (segments.some(s => s === '..')) {
			return undefined;
		}
		const home = await this._pathService.userHome();
		return URI.joinPath(home, '.claude', ...segments);
	}

	/**
	 * The engine's per-project directory name: the absolute workspace path with
	 * every character that is not a letter or digit replaced by a dash. Session
	 * transcripts and the project memory directory both live under it.
	 */
	private _projectDirName(): string | undefined {
		const root = this._workspaceRoot();
		return root ? root.fsPath.replace(/[^a-zA-Z0-9]/g, '-') : undefined;
	}

	/**
	 * Sessions the engine recorded, newest first.
	 *
	 * Each session is one `.jsonl` transcript under
	 * `~/.claude/projects/<project>/`, so this sees sessions started from the CLI
	 * as well as from the panel. Only the newest few are summarized — a transcript
	 * can be megabytes and the picker only needs a recognisable label.
	 *
	 * With `allProjects`, every project directory is walked and each session that
	 * came from somewhere else carries its project name, which is the only way to
	 * reach a conversation started in another workspace.
	 */
	private async _listSessions(allProjects?: boolean): Promise<ICodeMindSessionSummary[]> {
		const thisProject = this._projectDirName();
		if (!allProjects) {
			return thisProject ? this._listProjectSessions(thisProject, undefined, 25) : [];
		}
		const root = await this._resolveHomePath('projects');
		if (!root) {
			return [];
		}
		let children;
		try {
			children = (await this._fileService.resolve(root, { resolveMetadata: true })).children ?? [];
		} catch {
			return [];
		}
		// Recently touched projects first, and only a handful of them: every project
		// costs a directory read plus one transcript read per session summarized.
		const projects = children
			.filter(child => child.isDirectory)
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, 20);
		const sessions: ICodeMindSessionSummary[] = [];
		for (const project of projects) {
			sessions.push(...await this._listProjectSessions(project.name, project.name === thisProject ? undefined : project.name, 8));
		}
		return sessions.sort((a, b) => b.at - a.at).slice(0, 40);
	}

	/**
	 * Summarize the newest `limit` transcripts in one project directory. `project`
	 * is the engine's dashed directory name; passing it as `label` marks the rows as
	 * belonging to a workspace other than this one.
	 */
	private async _listProjectSessions(project: string, label: string | undefined, limit: number): Promise<ICodeMindSessionSummary[]> {
		const dir = await this._resolveHomePath(`projects/${project}`);
		if (!dir) {
			return [];
		}
		let children;
		try {
			children = (await this._fileService.resolve(dir, { resolveMetadata: true })).children ?? [];
		} catch {
			return [];
		}
		const logs = children
			.filter(child => !child.isDirectory && child.name.endsWith('.jsonl'))
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, limit);
		const sessions: ICodeMindSessionSummary[] = [];
		for (const log of logs) {
			let text: string;
			try {
				text = (await this._fileService.readFile(log.resource)).value.toString();
			} catch {
				continue;
			}
			const lines = text.split('\n').filter(line => line.trim());
			sessions.push({
				id: log.name.replace(/\.jsonl$/, ''),
				summary: this._firstPromptOf(lines),
				at: log.mtime,
				messages: lines.length,
				project: label,
			});
		}
		return sessions;
	}

	/**
	 * The first thing the user typed in a transcript, clipped to one line. The log
	 * holds one JSON object per line; the opening entries are metadata, so scan a
	 * few before giving up rather than parsing the whole file.
	 */
	private _firstPromptOf(lines: readonly string[]): string {
		for (const line of lines.slice(0, 40)) {
			let entry: { type?: string; message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== 'user' && entry.message?.role !== 'user') {
				continue;
			}
			const content = entry.message?.content;
			const text = typeof content === 'string'
				? content
				: Array.isArray(content)
					? content.map(block => (block as { text?: string })?.text ?? '').join(' ')
					: '';
			const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
			if (clean && !clean.startsWith('/')) {
				return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
			}
		}
		return '';
	}

	/**
	 * The real workspace path a transcript was recorded in, read from the top-level
	 * `cwd` every user/assistant line carries. The dashed directory name is a lossy
	 * on-disk key, so this is the only faithful source for the folder a session
	 * belonged to; scan a few lines, since the opening entry can be metadata.
	 */
	private _cwdOf(lines: readonly string[]): string | undefined {
		for (const line of lines.slice(0, 40)) {
			let entry: { cwd?: unknown };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof entry.cwd === 'string' && entry.cwd) {
				return entry.cwd;
			}
		}
		return undefined;
	}

	/**
	 * Build the Chat History rows and post them to the webview. Defaults to the
	 * current workspace — one directory read — and only walks every project when the
	 * panel's "All projects" toggle asks for it, since that is up to twenty directory
	 * reads plus a transcript read each.
	 *
	 * The heavy lifting (which logs, newest first, capped) is shared with the
	 * `/resume` picker via the per-project walk; here each row also carries the real
	 * `cwd` and the dashed dir name, which are what the panel needs to display a true
	 * path and to locate the `.jsonl` again for open and delete.
	 */
	private async _sendHistory(allProjects: boolean): Promise<void> {
		this._lastHistoryAllProjects = allProjects;
		const thisProject = this._projectDirName();
		const entries: ICodeMindHistoryEntry[] = [];
		const projects: string[] = [];
		if (allProjects) {
			const root = await this._resolveHomePath('projects');
			if (root) {
				try {
					const children = (await this._fileService.resolve(root, { resolveMetadata: true })).children ?? [];
					projects.push(...children
						.filter(child => child.isDirectory)
						.sort((a, b) => b.mtime - a.mtime)
						.slice(0, 20)
						.map(child => child.name));
				} catch {
					// No projects directory yet; the list is simply empty.
				}
			}
		} else if (thisProject) {
			projects.push(thisProject);
		}
		// A handful of the newest transcripts per project when walking them all, more
		// for the single current project since it is the one read.
		const perProject = allProjects ? 8 : 40;
		for (const project of projects) {
			entries.push(...await this._collectHistoryEntries(project, project === thisProject, perProject));
		}
		entries.sort((a, b) => b.at - a.at);
		this._postMessage({ type: 'historyData', payload: { entries: entries.slice(0, 100), allProjects } });
	}

	/**
	 * Summarize one project directory's newest `limit` transcripts into history rows,
	 * reading each log once for its first prompt, real `cwd` and line count.
	 */
	private async _collectHistoryEntries(projectDir: string, current: boolean, limit: number): Promise<ICodeMindHistoryEntry[]> {
		const dir = await this._resolveHomePath(`projects/${projectDir}`);
		if (!dir) {
			return [];
		}
		let children;
		try {
			children = (await this._fileService.resolve(dir, { resolveMetadata: true })).children ?? [];
		} catch {
			return [];
		}
		const logs = children
			.filter(child => !child.isDirectory && child.name.endsWith('.jsonl'))
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, limit);
		const entries: ICodeMindHistoryEntry[] = [];
		for (const log of logs) {
			let text: string;
			try {
				text = (await this._fileService.readFile(log.resource)).value.toString();
			} catch {
				continue;
			}
			const lines = text.split('\n').filter(line => line.trim());
			entries.push({
				id: log.name.replace(/\.jsonl$/, ''),
				topic: this._firstPromptOf(lines),
				at: log.mtime,
				messages: lines.length,
				projectDir,
				// The current project's real path is the live workspace root; for other
				// projects it comes from the transcript, the only faithful source.
				cwd: current ? this._workspaceRoot()?.fsPath : this._cwdOf(lines),
				current,
			});
		}
		return entries;
	}

	/**
	 * Open a past session from the history panel: render its transcript back into the
	 * chat and, for a session from this workspace, arm resume so the next turn
	 * continues it. A session recorded in another project can be read but not resumed
	 * — a turn always runs with the current workspace `cwd`, so the engine cannot
	 * attach to a conversation that lived somewhere else.
	 */
	private async _openSession(payload: { id: string; projectDir: string; current: boolean }): Promise<void> {
		const dir = await this._resolveHomePath(`projects/${payload.projectDir}`);
		const target = dir ? URI.joinPath(dir, `${payload.id}.jsonl`) : undefined;
		if (!target) {
			this._appendSystemMessage('Could not locate that session on disk.');
			return;
		}
		let text: string;
		try {
			text = (await this._fileService.readFile(target)).value.toString();
		} catch (err) {
			this._appendSystemMessage(`Could not open that session: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const lines = text.split('\n').filter(line => line.trim());
		const messages = this._transcriptToMessages(lines);
		this._history.length = 0;
		this._history.push(...messages);
		this._lastSessionId = payload.id;
		this._interruptedTurn = undefined;
		if (payload.current) {
			this._pendingResumeSessionId = payload.id;
			await this._engineService.resumeSession(payload.id).catch(() => { });
			if (!messages.length) {
				this._history.push({ id: this._generateId(), type: 'system', content: 'This session had no readable messages, but the next turn will still continue it.', timestamp: Date.now() });
			}
		} else {
			this._pendingResumeSessionId = undefined;
			this._history.push({
				id: this._generateId(),
				type: 'system',
				content: 'Opened read-only — this conversation was recorded in another project, so it cannot be resumed here. Its history refers to files in that project.',
				timestamp: Date.now(),
			});
		}
		this._postMessage({ type: 'history', payload: this._history });
		this._persistState();
	}

	/**
	 * Turn a transcript's JSONL lines into the chat's own message shape. Only the two
	 * things a person came back to see survive: what they typed and what the agent
	 * answered. Tool results (user entries whose content is a block array), thinking
	 * blocks and metadata lines are dropped; each `tool_use` an assistant made is
	 * kept as a single `⏺ <tool>` line so the shape of the work still reads. Capped
	 * to the last `MEMENTO_MAX_MESSAGES`, the same bound the live history keeps.
	 */
	private _transcriptToMessages(lines: readonly string[]): AgentMessage[] {
		const messages: AgentMessage[] = [];
		for (const line of lines) {
			let entry: { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const role = entry.message?.role ?? entry.type;
			const content = entry.message?.content;
			const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
			const timestamp = Number.isFinite(at) ? at : Date.now();
			if (role === 'user') {
				// A plain string is something the user typed; a block array is a tool
				// result the engine fed back, which is not part of the conversation.
				if (typeof content === 'string' && content.trim() && !content.startsWith('<')) {
					messages.push({ id: this._generateId(), type: 'user', content, timestamp });
				}
				continue;
			}
			if (role !== 'assistant') {
				continue;
			}
			const parts: string[] = [];
			if (typeof content === 'string') {
				if (content.trim()) {
					parts.push(content);
				}
			} else if (Array.isArray(content)) {
				for (const block of content as Array<{ type?: string; text?: string; name?: string }>) {
					if (block?.type === 'text' && block.text) {
						parts.push(block.text);
					} else if (block?.type === 'tool_use' && block.name) {
						parts.push(`⏺ ${block.name}`);
					}
					// `thinking` and everything else is left out on purpose.
				}
			}
			const joined = parts.join('\n\n').trim();
			if (joined) {
				messages.push({ id: this._generateId(), type: 'assistant', content: joined, timestamp });
			}
		}
		return messages.slice(-CodeMindAgentViewPane.MEMENTO_MAX_MESSAGES);
	}

	/**
	 * Delete a past session's transcript, sending it to the trash the way the panels'
	 * own file deletes do. If the removed session was the one armed for resume, that
	 * arming is cleared so the next turn does not try to attach to a conversation the
	 * engine can no longer load. The history list is then refreshed in whatever scope
	 * it was last shown.
	 */
	private async _deleteSession(payload: { id: string; projectDir: string }): Promise<void> {
		const dir = await this._resolveHomePath(`projects/${payload.projectDir}`);
		const target = dir ? URI.joinPath(dir, `${payload.id}.jsonl`) : undefined;
		if (!target) {
			this._appendSystemMessage('Could not locate that session on disk.');
			return;
		}
		try {
			await this._fileService.del(target, { useTrash: true });
		} catch (err) {
			this._appendSystemMessage(`Could not delete that session: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (this._lastSessionId === payload.id) {
			this._lastSessionId = undefined;
		}
		if (this._pendingResumeSessionId === payload.id) {
			this._pendingResumeSessionId = undefined;
		}
		await this._sendHistory(this._lastHistoryAllProjects);
	}

	/**
	 * how much was asked, which tools ran and which files they touched.
	 *
	 * The logs are the only record that spans sessions, so this is what makes
	 * `/insights` more than a summary of the panel's own transcript. Each log is
	 * scanned line by line with a per-file cap, since a long session can run to
	 * tens of thousands of entries.
	 */
	private async _collectProjectInsights(): Promise<ICodeMindProjectInsights | undefined> {
		const project = this._projectDirName();
		const dir = project ? await this._resolveHomePath(`projects/${project}`) : undefined;
		if (!dir) {
			return undefined;
		}
		let children;
		try {
			children = (await this._fileService.resolve(dir)).children ?? [];
		} catch {
			return undefined;
		}
		const logs = children
			.filter(child => !child.isDirectory && child.name.endsWith('.jsonl'))
			.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
		const scanned = logs.slice(0, 40);
		const tools = new Map<string, number>();
		const files = new Map<string, number>();
		let userPrompts = 0;
		let assistantMessages = 0;
		let firstAt = Number.MAX_SAFE_INTEGER;
		let lastAt = 0;
		for (const log of scanned) {
			firstAt = Math.min(firstAt, log.mtime ?? Number.MAX_SAFE_INTEGER);
			lastAt = Math.max(lastAt, log.mtime ?? 0);
			let text: string;
			try {
				text = (await this._fileService.readFile(log.resource)).value.toString();
			} catch {
				continue;
			}
			for (const line of text.split('\n').slice(0, 20000)) {
				if (!line.trim()) {
					continue;
				}
				let entry: { type?: string; message?: { role?: string; content?: unknown } };
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				const role = entry.message?.role ?? entry.type;
				const content = entry.message?.content;
				if (role === 'user') {
					// Tool results come back as user entries with a block array; only a
					// plain string is something a person typed.
					if (typeof content === 'string' && !content.startsWith('<')) {
						userPrompts++;
					}
					continue;
				}
				if (role !== 'assistant' || !Array.isArray(content)) {
					continue;
				}
				assistantMessages++;
				for (const block of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
					if (block?.type !== 'tool_use' || !block.name) {
						continue;
					}
					tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
					const path = block.input?.['file_path'] ?? block.input?.['notebook_path'];
					if (typeof path === 'string' && path) {
						const relative = this._relativeToWorkspace(path);
						files.set(relative, (files.get(relative) ?? 0) + 1);
					}
				}
			}
		}
		const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
		return {
			sessions: logs.length,
			scanned: scanned.length,
			firstAt: firstAt === Number.MAX_SAFE_INTEGER ? 0 : firstAt,
			lastAt,
			userPrompts,
			assistantMessages,
			toolCalls: [...tools].map(([name, count]) => ({ name, count })).sort(byCount),
			files: [...files].map(([path, count]) => ({ path, count })).sort(byCount),
		};
	}

	/** Shorten an absolute path for display when it sits inside the workspace. */
	private _relativeToWorkspace(path: string): string {
		const root = this._workspaceRoot()?.fsPath;
		if (!root) {
			return path;
		}
		const normalized = path.replace(/\\/g, '/');
		const prefix = `${root.replace(/\\/g, '/').replace(/\/$/, '')}/`;
		return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
	}

	/** The first workspace folder, or undefined when no folder is open. */
	private _workspaceRoot(): URI | undefined {
		return this._workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	/** Resolve a workspace-relative path against the first folder. */
	private _resolveWorkspacePath(relativePath: string): URI | undefined {
		const root = this._workspaceRoot();
		if (!root) {
			return undefined;
		}
		// Absolute paths are honoured as-is so callers can pass either form.
		const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
		if (/^([a-zA-Z]:\/|\/)/.test(normalized)) {
			return URI.file(relativePath);
		}
		return URI.joinPath(root, ...normalized.split('/').filter(Boolean));
	}

	/** Write a `codemind.*` setting, swallowing a read-only settings file. */
	private async _updateConfig(key: string, value: unknown): Promise<void> {
		try {
			await this.configurationService.updateValue(key, value);
		} catch {
			// Settings file is read-only; the in-session value still applies.
		}
		// Slash commands change the same keys the settings panel shows, so repaint
		// it — otherwise `/model sonnet` would leave the panel showing the old one.
		this._postMessage({ type: 'settingsData', payload: this._readSettings() });
	}

	/**
	 * Run a turn the user never sees and resolve with its final text. Used by
	 * `/commit`, `/compact` and `/summary`, which need the model's answer as data
	 * rather than as a chat bubble, so no stream messages reach the webview.
	 *
	 * `turnOverrides` is forwarded verbatim to the engine so `/btw` can cap the
	 * turn, refuse every tool and keep the side question out of the session.
	 */
	private _silentQuery(prompt: string, turnOverrides?: ICodeMindTurnOverrides): Promise<string> {
		const queryId = this._generateId();
		const cts = new CancellationTokenSource();
		let text = '';

		const listener = Event.filter(this._engineService.onEvent, e => e.queryId === queryId)(({ event }) => {
			if (event.kind === 'text') {
				// Text events are cumulative, so the last one is the whole answer.
				text = event.text;
			} else if (event.kind === 'result' && event.text) {
				text = event.text;
			}
			// `error` deliberately does not land in `text`: a failed turn has no answer,
			// and the rejection below is what the caller gets instead.
		});

		const request: ICodeMindEngineRequest = {
			prompt,
			cwd: this._workspaceRoot()?.fsPath,
			// A hidden turn that belongs to the conversation (`/compact`, `/summary`)
			// has to attach to a restored session as well, or it would summarise an
			// empty one. An isolated side question deliberately starts clean.
			sessionId: turnOverrides?.isolated ? undefined : this._takeResumeSessionId(),
			history: [],
			// A hidden turn must not inherit the panel's plan-mode notice or todo
			// list: it is a one-shot question, not part of the conversation.
			planMode: false,
			turnOverrides,
		};

		return this._engineService.queryStream(queryId, request, cts.token)
			.then(response => {
				// A failed turn's text is the API's complaint, not an answer. Callers use
				// what comes back as data — a commit message, a summary, a session name —
				// so hand them a rejection instead: `_runCommand` turns it into a system
				// note, and the companion paths already treat a failure as silence.
				if (response.isError) {
					throw new Error(response.text || 'The engine could not complete the request.');
				}
				return response.text || text;
			})
			.finally(() => {
				listener.dispose();
				cts.dispose();
			});
	}

	/** Replace the whole transcript with a single system summary (`/compact`). */
	private _replaceTranscript(summary: string): void {
		this._history.length = 0;
		this._history.push({
			id: this._generateId(),
			type: 'system',
			content: summary,
			timestamp: Date.now(),
		});
		// Whatever the last turn carried described the conversation this summary
		// replaces, so the context reading is stale until the next turn reports.
		this._resetContextStatus();
		// A summary is what the engine has now: re-injecting a partial reply from before
		// it would put back detail the compaction just removed.
		this._interruptedTurn = undefined;
		this._postMessage({ type: 'history', payload: this._history });
		this._persistState();
	}

	/**
	 * Drop the last `turns` user/assistant exchanges. Returns how many messages
	 * were actually removed so the command can report honestly.
	 */
	private _rewind(turns: number): number {
		let remaining = turns;
		let removed = 0;
		while (remaining > 0) {
			// Walk back to the start of the last exchange: the final user message
			// and everything the agent said after it.
			const lastUser = this._findLastIndex(this._history, m => m.type === 'user');
			if (lastUser < 0) {
				break;
			}
			removed += this._history.length - lastUser;
			this._history.length = lastUser;
			remaining--;
		}
		if (removed) {
			this._postMessage({ type: 'history', payload: this._history });
			this._persistState();
		}
		return removed;
	}

	private _findLastIndex(messages: readonly AgentMessage[], predicate: (m: AgentMessage) => boolean): number {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (predicate(messages[i])) {
				return i;
			}
		}
		return -1;
	}

	/**
	 * Show a file's working-tree changes. Prefers the built-in git diff editor;
	 * falls back to opening the file when the git extension is unavailable.
	 */
	private async _openDiff(relativePath: string): Promise<void> {
		const resource = this._resolveWorkspacePath(relativePath);
		if (!resource) {
			this._appendSystemMessage('Open a folder before diffing a file.');
			return;
		}
		try {
			await this._commandService.executeCommand('git.openChange', resource);
		} catch {
			try {
				await this._editorService.openEditor({ resource, options: { pinned: true } });
				this._appendSystemMessage(`Opened ${relativePath} (the git diff editor was not available).`);
			} catch (err) {
				this._appendSystemMessage(`Could not open ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * Ctrl+G / Ctrl+X Ctrl+E: put the prompt in an untitled markdown buffer, and keep
	 * the composer in step with every edit made to it.
	 *
	 * The CLI writes a temp file, blocks on `$EDITOR`, then reads it back. An editor
	 * is already here, so the buffer streams its changes to the composer instead:
	 * nothing blocks, the prompt never lands on disk, and closing the tab needs no
	 * cleanup. A second Ctrl+G replaces the first round trip rather than adding one.
	 */
	private async _editComposerInEditor(text: string): Promise<void> {
		this._composerEditor.clear();
		try {
			const pane = await this._editorService.openEditor({
				resource: undefined,
				contents: text,
				languageId: 'markdown',
				options: { pinned: true },
			});
			const resource = pane?.input?.resource;
			if (!resource) {
				this._appendSystemMessage('Could not open an editor for the prompt.');
				return;
			}
			const store = new DisposableStore();
			// The reference is what keeps the model alive: an untitled model is disposed
			// with its last editor, and the listener below would go with it.
			const reference = await this._textModelService.createModelReference(resource);
			store.add(reference);
			const model = reference.object.textEditorModel;
			store.add(model.onDidChangeContent(() => {
				this._postMessage({ type: 'composerText', payload: { text: model.getValue() } });
			}));
			store.add(this._editorService.onDidCloseEditor(event => {
				if (!isEqual(event.editor.resource, resource)) {
					return;
				}
				// Releasing the reference from inside the close event would dispose the
				// model while the editor is still finishing with it.
				queueMicrotask(() => this._composerEditor.clear());
			}));
			this._composerEditor.value = store;
			this._appendSystemMessage('Editing the prompt in an editor — every change goes straight back to the composer. Close the tab when you are done; nothing is saved to disk.');
		} catch (err) {
			this._appendSystemMessage(`Could not open an editor for the prompt: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Ask for a location and write `contents` there; resolves to the path used. */
	private async _saveTextFile(defaultName: string, contents: string): Promise<string | undefined> {
		const root = this._workspaceRoot() ?? await this._pathService.userHome();
		const target = await this._fileDialogService.showSaveDialog({
			title: localize('codeMindSaveTitle', 'Save from the CodeMind Agent'),
			defaultUri: URI.joinPath(root, defaultName),
		});
		if (!target) {
			return undefined;
		}
		try {
			await this._fileService.writeFile(target, VSBuffer.fromString(contents));
			return target.fsPath;
		} catch (err) {
			this._appendSystemMessage(`Could not write ${target.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	/** Read a workspace-relative text file, or undefined when it is not there. */
	private async _readTextFile(relativePath: string): Promise<string | undefined> {
		const resource = this._resolveWorkspacePath(relativePath);
		if (!resource) {
			return undefined;
		}
		try {
			return (await this._fileService.readFile(resource)).value.toString();
		} catch {
			return undefined;
		}
	}

	/**
	 * Write a text file, refusing to replace an existing one unless the caller has
	 * already confirmed the overwrite. Returns the path written.
	 */
	private async _writeTextFile(relativePath: string, contents: string, overwrite?: boolean): Promise<string | undefined> {
		const resource = this._resolveWorkspacePath(relativePath);
		if (!resource) {
			return undefined;
		}
		try {
			if (!overwrite && await this._fileService.exists(resource)) {
				return undefined;
			}
			await this._fileService.writeFile(resource, VSBuffer.fromString(contents));
			return resource.fsPath;
		} catch {
			return undefined;
		}
	}

	/** True when a workspace-relative path exists. */
	private async _fileExists(relativePath: string): Promise<boolean> {
		const resource = this._resolveWorkspacePath(relativePath);
		return resource ? this._fileService.exists(resource) : false;
	}

	/** Entry names in a workspace-relative directory; empty when unreadable. */
	private async _listDirectoryNames(relativePath: string): Promise<string[]> {
		const resource = this._resolveWorkspacePath(relativePath);
		if (!resource) {
			return [];
		}
		try {
			const stat = await this._fileService.resolve(resource);
			return (stat.children ?? []).map(child => child.isDirectory ? `${child.name}/` : child.name).sort();
		} catch {
			return [];
		}
	}

	/**
	 * Add another folder to the workspace (`/add-dir`). A path given on the command
	 * line is used directly — the CLI takes one, so opening a picker instead would
	 * throw the argument away; without one, fall back to the native picker.
	 */
	private async _addDirectory(path?: string): Promise<void> {
		if (path) {
			await this._addDirectoryPath(path);
			return;
		}
		const picked = await this._fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: true,
			title: localize('codeMindAddDirTitle', 'Add a folder to the CodeMind workspace'),
			defaultUri: this._workspaceRoot(),
		});
		if (!picked?.length) {
			this._appendSystemMessage('No folder was selected.');
			return;
		}
		try {
			await this._workspaceEditingService.addFolders(picked.map(uri => ({ uri })));
			this._appendSystemMessage(`Added ${picked.map(uri => uri.fsPath).join(', ')} to the workspace.`);
		} catch (err) {
			this._appendSystemMessage(`Could not add the folder: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Resolve and validate a typed `/add-dir <path>` argument, then add it. */
	private async _addDirectoryPath(path: string): Promise<void> {
		const trimmed = path.trim().replace(/^["']|["']$/g, '');
		const normalized = trimmed.replace(/\\/g, '/');
		// An absolute path works with no folder open; a relative one needs a root to
		// resolve against, which `_resolveWorkspacePath` already enforces.
		const resource = /^([a-zA-Z]:\/|\/|\/\/)/.test(normalized)
			? URI.file(trimmed)
			: this._resolveWorkspacePath(trimmed);
		if (!resource) {
			this._appendSystemMessage(`Cannot resolve ${trimmed} — open a folder first, or pass an absolute path.`);
			return;
		}
		try {
			const stat = await this._fileService.resolve(resource);
			if (!stat.isDirectory) {
				this._appendSystemMessage(`${resource.fsPath} is a file, not a folder.`);
				return;
			}
		} catch {
			this._appendSystemMessage(`${resource.fsPath} does not exist.`);
			return;
		}
		if (this._workspaceContextService.getWorkspace().folders.some(folder => folder.uri.toString() === resource.toString())) {
			this._appendSystemMessage(`${resource.fsPath} is already in the workspace.`);
			return;
		}
		try {
			await this._workspaceEditingService.addFolders([{ uri: resource }]);
			this._appendSystemMessage(`Added ${resource.fsPath} to the workspace.`);
		} catch (err) {
			this._appendSystemMessage(`Could not add the folder: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Finish the `/commit` flow: the review sheet came back confirmed, so commit
	 * the already-staged files with the message the user approved (or edited).
	 */
	private async _completeCommit(message: string): Promise<void> {
		const cwd = this._workspaceRoot()?.fsPath;
		if (!cwd) {
			this._appendSystemMessage('Open a folder before committing.');
			return;
		}
		const files = this._pendingCommitFiles;
		this._pendingCommitFiles = [];
		try {
			const result = await this._engineService.exec({ command: 'git', args: ['commit', '-m', message], cwd });
			if (result.exitCode === 0) {
				const count = files.length;
				this._appendSystemMessage(`Committed ${count} file${count === 1 ? '' : 's'}.\n${result.stdout.trim()}`);
			} else {
				this._appendSystemMessage(`Commit failed: ${(result.stderr || result.stdout || result.error || '').trim()}`);
			}
		} catch (err) {
			this._appendSystemMessage(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Dispatch a registered slash command. Returns false when unknown. */
	private _runCommand(name: string, args: string): boolean {
		const command = commandRegistry.get(name.toLowerCase());
		if (!command) {
			return false;
		}
		const context = this._commandContext();
		command.execute(args, context).catch(err => {
			context.appendSystemMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
		});
		return true;
	}

	private _sendMessage(text: string, attachments?: readonly AgentAttachment[]): void {
		if (!text?.trim()) {
			return;
		}

		// Slash command interception: if the message begins with `/`, try to
		// dispatch via the CommandRegistry instead of forwarding to the engine.
		if (text.startsWith('/')) {
			const spaceIdx = text.indexOf(' ');
			const name = (spaceIdx < 0 ? text : text.slice(0, spaceIdx)).slice(1);
			const args = spaceIdx < 0 ? '' : text.slice(spaceIdx + 1);
			if (this._runCommand(name, args)) {
				return;
			}
			// Unknown command — fall through and let the engine handle it.
		}

		// No key, no call. An empty key reaches the API as an opaque 401 halfway through
		// a turn that already looks like it started; the CLI asks you to log in before it
		// does anything, so the panel opens its key dialog and keeps the prompt in hand.
		// `undefined` means secret storage has not been read yet — fail open there rather
		// than block a send on a race with the `ready` prime.
		if (this._engineService.apiKeyState === false) {
			this._postMessage({ type: 'openPanel', payload: { panelId: 'apiKey' } });
			this._postMessage({ type: 'restoreDraft', payload: text });
			this._appendSystemMessage(localize('cmagent.needKey', 'No Anthropic API key is stored yet. Enter one to start — your prompt is still in the composer.'));
			return;
		}

		const intent = { id: 'general', label: 'General Question' };

		const userMessage: AgentMessage = {
			id: this._generateId(),
			type: 'user',
			content: text,
			timestamp: Date.now(),
			intent,
		};
		this._history.push(userMessage);
		this._postMessage({ type: 'newMessage', payload: userMessage });
		this._postMessage({ type: 'status', payload: 'busy' });

		const streamId = this._generateId();
		// The bubble shows the configured model until the engine reports the real
		// one in its `system` event (aliases resolve server-side). The endpoint rides
		// along so the webview can name it if the first token is slow to arrive.
		this._postMessage({
			type: 'streamStart',
			payload: {
				id: streamId,
				intent,
				metadata: { model: this.configurationService.getValue<string>('codemind.model') },
				endpoint: this._endpointLabel(),
			},
		});

		// The engine emits cumulative text/thinking; the webview appends deltas.
		// Track the last-seen length so we forward only the new substring.
		let lastTextLen = 0;
		let lastThinkingLen = 0;
		// Kept so an interrupted turn can be finalized with whatever had arrived.
		let latestText = '';
		// Set when the engine reports this turn as a failure rather than an answer, so
		// the transcript entry is filed as an error and never replayed to the model as
		// something it said.
		let turnFailed = false;
		let model: string | undefined;
		let sessionId: string | undefined;
		this._engineCompactedThisTurn = false;

		const cts = new CancellationTokenSource();
		this._requestCts.value = cts;

		// Subscribe to engine events for this query only.
		const eventListener = Event.filter(this._engineService.onEvent, e => e.queryId === streamId)(({ event }) => {
			switch (event.kind) {
				case 'system':
					model = event.model;
					sessionId = event.sessionId;
					if (event.tools?.length) {
						// The engine's own list beats our static one: which tools exist
						// depends on the engine build and its feature flags.
						this._engineTools = event.tools;
					}
					if (model || sessionId) {
						this._postMessage({ type: 'streamMeta', payload: { id: streamId, model, sessionId } });
					}
					break;
				case 'text': {
					const delta = event.text.slice(lastTextLen);
					lastTextLen = event.text.length;
					latestText = event.text;
					if (delta) {
						this._postMessage({ type: 'streamDelta', payload: { id: streamId, content: delta } });
					}
					break;
				}
				case 'error': {
					// The engine could not reach the model: no answer is coming, so the
					// bubble becomes an error in place. `latestText` follows it so a stop
					// pressed while the message is arriving still keeps what there was, and
					// `lastTextLen` keeps up in case ordinary text somehow follows.
					lastTextLen = event.text.length;
					latestText = event.text;
					turnFailed = true;
					this._postMessage({ type: 'streamError', payload: { id: streamId, content: event.text } });
					break;
				}
				case 'thinking': {
					const delta = event.text.slice(lastThinkingLen);
					lastThinkingLen = event.text.length;
					if (delta) {
						this._postMessage({ type: 'thinkingDelta', payload: { id: streamId, content: delta } });
					}
					break;
				}
				case 'agent_text':
					this._postMessage({ type: 'agentText', payload: { streamId, parentId: event.parentToolUseId, text: event.text } });
					break;
				case 'tool_use_start':
					this._captureTodos(event.toolName, event.input);
					this._postMessage({ type: 'tool', payload: { streamId, id: event.toolUseId, toolName: event.toolName, input: event.input, status: 'running', parentId: event.parentToolUseId } });
					break;
				case 'tool_use_input':
					// Nothing to render — the card was built from the deltas. This is the
					// arguments as an object, which is the only form the todo capture can use.
					this._captureTodos(event.toolName, event.input);
					break;
				case 'tool_use_delta':
					this._postMessage({ type: 'toolDelta', payload: { streamId, id: event.toolUseId, partialJson: event.partialJson } });
					break;
				case 'tool_result':
					this._postMessage({ type: 'tool', payload: { streamId, id: event.toolUseId, toolName: '', result: event.content, isError: event.isError, status: 'done', parentId: event.parentToolUseId } });
					break;
				case 'tool_progress':
					// Progress messages carry a fresh id each time; the tool they
					// belong to is the parent, so pass that through as the target.
					this._postMessage({ type: 'toolProgress', payload: { id: streamId, toolName: event.toolName, elapsedSeconds: event.elapsedSeconds, toolUseId: event.parentToolUseId } });
					break;
				case 'permission_request':
					// Pause the stream until the user answers via the permission dialog.
					// The scope options come from the worker, which owns the rule text —
					// the webview only sends back the id of the one that was picked.
					this._postMessage({
						type: 'permissionRequest',
						payload: {
							toolUseId: event.toolUseId,
							toolName: event.toolName,
							input: event.input,
							scopes: event.scopes,
							blockedPath: event.blockedPath,
							reason: event.reason,
							agentId: event.agentId,
						},
					});
					break;
				case 'compact_boundary':
					// The engine summarised the session part-way through this turn, so
					// its context is small again and the panel must not compact on top.
					this._engineCompactedThisTurn = true;
					this._resetContextStatus();
					this._appendSystemMessage(event.preTokens
						? `The engine compacted the conversation itself (${event.preTokens.toLocaleString()} tokens of context) and carried on from the summary.`
						: 'The engine compacted the conversation itself and carried on from the summary.');
					break;
				case 'result': {
					this._postMessage({
						type: 'streamEnd',
						payload: { id: streamId, metadata: { model, usage: event.usage, costUsd: event.totalCostUsd, durationMs: event.durationMs, sessionId: event.sessionId ?? sessionId } },
					});
					this._postMessage({
						type: 'sessionCost',
						payload: {
							totalCostUsd: event.totalCostUsd,
							inputTokens: event.usage?.inputTokens,
							outputTokens: event.usage?.outputTokens,
							durationMs: event.durationMs,
							model,
						},
					});
					const assistantMessage: AgentMessage = {
						id: streamId,
						// A failed turn is filed as an error: it is what the panel is showing,
						// it survives a reload as an error, and `_buildHistory` leaves it out
						// so the API's complaint is never sent back as the model's own words.
						type: turnFailed ? 'error' : 'assistant',
						content: event.text,
						timestamp: Date.now(),
						intent,
						metadata: { model, usage: event.usage, costUsd: event.totalCostUsd, durationMs: event.durationMs, sessionId: event.sessionId ?? sessionId },
					};
					this._history.push(assistantMessage);
					if (assistantMessage.metadata?.sessionId) {
						this._rememberSession(assistantMessage.metadata.sessionId);
					}
					// A mid-turn compaction leaves this turn's usage describing the
					// conversation as it was before the summary, so it says nothing about
					// how full the window is now — the next turn will.
					if (!this._engineCompactedThisTurn) {
						this._recordContextUsage(event.usage, model, event.contextTokens);
					}
					break;
				}
			}
		});

		const resumedSessionId = this._takeResumeSessionId();
		const request: ICodeMindEngineRequest = {
			// Shell-mode output collected since the last turn rides in front of the
			// prompt; the bubble above still shows only what the user typed. A turn the
			// user stopped rides in front of both, so the engine's own transcript ends up
			// with the reply it never got to finish writing down.
			prompt: `${this._takeInterruptedTurn()}${this._takePendingContext()}${text}`,
			cwd: this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath,
			// Set only on the first turn after a reload, to re-attach the conversation
			// the panel restored; after that the worker remembers it on its own.
			sessionId: resumedSessionId,
			history: this._buildHistory(),
			intent,
			systemPromptSuffix: this._buildSystemPromptSuffix(),
			attachments: attachments?.length ? attachments.map(a => ({
				kind: a.kind,
				name: a.name,
				path: a.path,
				dataUrl: a.dataUrl,
			})) : undefined,
			planMode: this._planMode,
		};

		// A turn the user stopped is not a failure: finalize the bubble with whatever text
		// had arrived, mark it interrupted, and keep it in the transcript so the partial
		// answer survives a reload. The engine resolves or rejects depending on which side
		// noticed the cancel first, so both endings run this.
		const finalizeInterrupted = () => {
			this._postMessage({ type: 'streamEnd', payload: { id: streamId, metadata: { model, interrupted: true } } });
			// An interrupt before the first token leaves nothing worth keeping, and an
			// empty assistant turn would go on to the engine as context.
			if (latestText.trim() && !this._history.some(m => m.id === streamId)) {
				this._history.push({
					id: streamId,
					type: 'assistant',
					content: latestText,
					timestamp: Date.now(),
					intent,
					metadata: { model, sessionId, interrupted: true },
				});
				// The engine writes an assistant turn to its session file when the turn
				// finishes, so this one is about to be missing from the record a resumed
				// session reads. Hand it to the next prompt, which is the only way back in.
				this._interruptedTurn = latestText;
			}
			this._persistState();
		};

		this._engineService.queryStream(streamId, request, cts.token).then(() => {
			if (cts.token.isCancellationRequested) {
				finalizeInterrupted();
				return;
			}
			// If the engine returned without emitting a result event, finalize the bubble.
			if (!this._history.some(m => m.id === streamId)) {
				this._postMessage({ type: 'streamEnd', payload: { id: streamId, metadata: { model } } });
			}
		}).catch(error => {
			const errorName = (error as any)?.name;
			if (cts.token.isCancellationRequested || errorName === 'CancellationError' || errorName === 'Canceled' || /request cancelled/i.test(String(error && (error as Error).message))) {
				finalizeInterrupted();
				return;
			}
			this._postMessage({ type: 'streamEnd', payload: { id: streamId } });
			const errorMessage: AgentMessage = {
				id: this._generateId(),
				type: 'error',
				content: error instanceof Error ? error.message : 'Unknown error',
				timestamp: Date.now(),
			};
			this._history.push(errorMessage);
			this._postMessage({ type: 'newMessage', payload: errorMessage });
			this._postMessage({ type: 'status', payload: 'error' });
			// This turn carried the restored session id and the engine could not find
			// it, so it never ran. Say what happened: the resume has already been
			// consumed, so sending again starts a fresh conversation and works.
			if (resumedSessionId && this._isMissingSessionError(error, resumedSessionId)) {
				this._appendSystemMessage(
					'The conversation shown above could not be re-attached — the engine no longer has that session on disk. '
					+ 'Send the message again to carry on in a new one; the transcript above stays for reference.'
				);
			}
		}).finally(() => {
			eventListener.dispose();
			cts.dispose();
			this._postMessage({ type: 'status', payload: 'ready' });
			this._postMessage({ type: 'focusInput' });
			// Compacting mid-turn is not possible — the engine is busy — so the check
			// happens here, between turns, which is also where the CLI does it.
			void this._maybeAutoCompact();
			// The companion watches the turn that just finished, exactly where the CLI
			// fires its observer.
			void this._maybeCompanionReaction(text);
		});
	}

	// --- companion (CLI: buddy/)

	/**
	 * The soul on disk, whether or not the companion is currently switched on. Kept
	 * separate from {@link _companionSoul} so turning the companion off is sleep
	 * rather than death: the same creature, with the same name, comes back.
	 */
	private _storedCompanionSoul(): ICodeMindCompanionSoul | undefined {
		const raw = this.configurationService.getValue<Partial<ICodeMindCompanionSoul>>('codemind.companionSoul');
		if (!raw || typeof raw.name !== 'string' || !raw.name.trim() || typeof raw.personality !== 'string') {
			return undefined;
		}
		return {
			name: raw.name.trim().slice(0, 16),
			personality: raw.personality,
			hatchedAt: typeof raw.hatchedAt === 'number' ? raw.hatchedAt : Date.now(),
			// A soul hand-written into settings.json has no seed; 'anon' is what the CLI
			// falls back to when it has no account either, so both roll the same creature.
			seed: typeof raw.seed === 'string' && raw.seed ? raw.seed : 'anon',
		};
	}

	private _companionSoul(): ICodeMindCompanionSoul | undefined {
		return this.configurationService.getValue<boolean>('codemind.companion') === true
			? this._storedCompanionSoul()
			: undefined;
	}

	/** Soul plus freshly rolled bones — the CLI's `getCompanion()`. */
	private _companion(): ICodeMindCompanion | undefined {
		const soul = this._companionSoul();
		return soul ? { ...soul, ...rollCompanionBones(soul.seed) } : undefined;
	}

	private _isCompanionMuted(): boolean {
		return this.configurationService.getValue<boolean>('codemind.companionMuted') === true;
	}

	/**
	 * Tell the webview what to draw beside the composer, or that there is nothing.
	 * A muted companion is still sent: the sprite goes away, but `/buddy` can still
	 * show its card, which is the difference between muted and forgotten.
	 */
	private _pushCompanion(): void {
		const companion = this._companion();
		this._postMessage({
			type: 'companion',
			payload: companion
				? { ...companion, muted: this._isCompanionMuted(), stars: RARITY_STARS[companion.rarity] }
				: undefined,
		});
	}

	/**
	 * What the bones are rolled from. The engine's account is preferred so the same
	 * account hatches the same creature on another machine, which is what the CLI's
	 * account uuid gives it; when the engine has no account to report, a per-profile
	 * id stands in. Either way the value is stored in the soul, so signing in later
	 * cannot turn someone's duck into a dragon.
	 */
	private async _companionSeed(): Promise<string> {
		try {
			const account = await this._engineService.getAccountInfo();
			if (account?.email) {
				return account.email;
			}
		} catch {
			// Engine unreachable; fall through to the local id.
		}
		const key = 'codemind.agent.companionSeed';
		const existing = this._storageService.get(key, StorageScope.APPLICATION);
		if (existing) {
			return existing;
		}
		const seed = generateUuid();
		this._storageService.store(key, seed, StorageScope.APPLICATION, StorageTarget.MACHINE);
		return seed;
	}

	/**
	 * Hatch, or wake a companion that was switched off. The bones are rolled from the
	 * seed; the name and personality are one isolated one-shot turn, which is how the
	 * CLI writes them too. A model that cannot be reached does not block the hatch —
	 * the sprite is the point, and a soul is one line of text.
	 */
	private async _hatchCompanion(): Promise<ICodeMindCompanion | undefined> {
		const stored = this._storedCompanionSoul();
		if (stored) {
			await this._updateConfig('codemind.companion', true);
			this._pushCompanion();
			return { ...stored, ...rollCompanionBones(stored.seed) };
		}

		const seed = await this._companionSeed();
		const bones = rollCompanionBones(seed);
		const answer = await this._silentQuery(companionHatchPrompt(bones), { maxTurns: 1, blockAllTools: true, isolated: true })
			.catch(() => '');
		const soul = parseCompanionSoul(answer) ?? {
			name: bones.species.charAt(0).toUpperCase() + bones.species.slice(1),
			personality: `A ${bones.rarity} ${bones.species} that keeps its opinions to itself.`,
		};
		const record: ICodeMindCompanionSoul = { ...soul, hatchedAt: Date.now(), seed };
		await this._updateConfig('codemind.companionSoul', record);
		await this._updateConfig('codemind.companion', true);
		this._pushCompanion();
		return { ...record, ...bones };
	}

	/** `/buddy forget`: the creature goes, the switch goes with it. */
	private async _forgetCompanion(): Promise<void> {
		await this._updateConfig('codemind.companionSoul', undefined);
		await this._updateConfig('codemind.companion', false);
		this._pushCompanion();
	}

	/**
	 * The bubble. The CLI runs an observer over its whole message list after every
	 * turn; the panel sends the last exchange into an isolated one-shot instead, so a
	 * remark costs a few hundred tokens rather than a second copy of the conversation.
	 *
	 * Rate-limited to one remark per {@link COMPANION_REACTION_INTERVAL_MS}: a run of
	 * one-line turns should not become a run of quips, and the bubble only stays up
	 * for ten seconds anyway. Being addressed by name skips the limit — an answer that
	 * arrives a minute later is worse than none.
	 */
	private async _maybeCompanionReaction(userText: string): Promise<void> {
		const companion = this._companion();
		if (!companion || this._isCompanionMuted() || this._compacting) {
			return;
		}
		const lastAgent = [...this._history].reverse().find(m => m.type === 'assistant')?.content ?? '';
		if (!lastAgent.trim()) {
			return;
		}
		const addressed = new RegExp(`\\b${escapeRegExpCharacters(companion.name)}\\b`, 'i').test(userText);
		const now = Date.now();
		if (!addressed && now - this._lastCompanionReactionAt < COMPANION_REACTION_INTERVAL_MS) {
			return;
		}
		this._lastCompanionReactionAt = now;
		const answer = await this._silentQuery(
			companionReactionPrompt(companion, userText, lastAgent, addressed),
			{ maxTurns: 1, blockAllTools: true, isolated: true },
		).catch(() => '');
		const text = answer.trim().split('\n')[0].replace(/^["'`*]+|["'`*]+$/g, '').trim();
		if (!text || text === '(nothing)') {
			return;
		}
		this._postMessage({ type: 'companionReaction', payload: { text: text.slice(0, 200) } });
	}

	// --- context window pressure
	/**
	 * Take the token count a finished turn reported and tell the webview how full
	 * the context window now is. What one request carried — fresh input plus cache
	 * reads and writes — is the measure the engine checks against its own
	 * thresholds, so it is the one shown here.
	 */
	private _recordContextUsage(usage: ICodeMindEngineUsage | undefined, model: string | undefined, contextTokens?: number): void {
		// A zero is not a measurement of an empty context. A gateway that forwards
		// `message_start` with the counts stripped produces one, and taking it at face
		// value parks the meter at 0% and stops auto-compaction from ever firing — the
		// turn after that is the one the API refuses for being too long. So a zero from
		// either source is treated as "not measured" rather than recorded.
		const measured = contextTokens !== undefined && contextTokens > 0 ? contextTokens : undefined;
		// `contextTokens` is one API call's own prompt, measured by the worker from the
		// turn's `message_start` events. The `usage` totals are the sum over every call
		// the turn made, so a turn that ran twenty tools reports far more input than the
		// conversation actually holds; using them here would compact a short session.
		// They stay as the fallback for a gateway that streams no `message_start`.
		const fallback = usage
			? usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
			: 0;
		const next = measured ?? fallback;
		if (next <= 0) {
			return;
		}
		this._contextTokens = next;
		this._contextModel = model ?? this._contextModel;
		this._sendContextStatus();
	}

	/**
	 * Forget the measurement. Used after a compaction and after `/clear`: in both
	 * cases the number describes a conversation that no longer exists, and showing
	 * it would claim the context is full when it has just been emptied.
	 */
	private _resetContextStatus(): void {
		this._contextTokens = undefined;
		this._sendContextStatus();
	}

	private _sendContextStatus(): void {
		this._postMessage({
			type: 'contextStatus',
			payload: this._contextTokens === undefined
				? undefined
				: calculateContextStatus(this._contextTokens, this._contextModel, this._isAutoCompactEnabled()),
		});
	}

	/**
	 * Compact the conversation when the last turn nearly filled the context window.
	 *
	 * The engine compacts its own session when it can, and says so with a compact
	 * boundary; this covers the case where it did not — a turn that ends over the
	 * threshold would otherwise be followed by one the API refuses outright. Three
	 * consecutive failures stop the attempts, as they do in the engine, so a
	 * conversation that cannot be summarised does not spend a model call per turn
	 * finding that out again.
	 */
	private async _maybeAutoCompact(): Promise<void> {
		if (this._compacting || this._contextTokens === undefined || this._autoCompactFailures >= 3) {
			return;
		}
		const status = calculateContextStatus(this._contextTokens, this._contextModel, this._isAutoCompactEnabled());
		if (!status.shouldAutoCompact) {
			return;
		}
		this._compacting = true;
		this._postMessage({ type: 'status', payload: 'busy' });
		try {
			const compacted = await runCompaction(this._commandContext(), '', true);
			this._autoCompactFailures = compacted ? 0 : this._autoCompactFailures + 1;
			if (compacted) {
				this._resetContextStatus();
			} else if (this._autoCompactFailures >= 3) {
				this._appendSystemMessage('Auto-compaction has failed three times, so the panel will stop trying. Use /compact, /clear or /rewind to make room.');
			}
		} catch (err) {
			this._autoCompactFailures++;
			this._appendSystemMessage(`Auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._compacting = false;
			this._postMessage({ type: 'status', payload: 'ready' });
		}
	}

	private _buildHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
		return this._history
			.filter(m => m.type === 'user' || m.type === 'assistant')
			.slice(-10)
			.map(m => ({
				role: m.type === 'user' ? 'user' as const : 'assistant' as const,
				content: m.content,
			}));
	}

	/**
	 * Record the engine session id reported by a finished turn. The worker resumes
	 * its own per-project session automatically, so this is the pane's copy: it is
	 * what a reopened panel and the session UI report as the current conversation.
	 */
	private _rememberSession(sessionId: string): void {
		if (!sessionId || sessionId === this._lastSessionId) {
			return;
		}
		this._lastSessionId = sessionId;
	}

	/**
	 * Single place plan mode changes, so the "just lifted" note is armed no matter which
	 * way it was switched — the header toggle, `/plan`, `/exit-plan` or `/permissions`.
	 */
	private _setPlanMode(enabled: boolean): void {
		if (this._planMode === enabled) {
			return;
		}
		this._planMode = enabled;
		if (!enabled) {
			this._planModeLifted = true;
		}
	}

	/**
	 * Move the permission mode from the composer's mode pill. This is `/permissions <mode>`
	 * minus the confirmation line: the pill already names the mode the next turn will run
	 * in, so a transcript entry saying the same thing is noise. Both halves move together
	 * here, as they do in the command — setting the stored mode without the plan flag would
	 * leave the two disagreeing about whether the next turn may write.
	 */
	private _setPermissionModeFromPanel(mode: string): void {
		if (!PERMISSION_MODES.includes(mode)) {
			return;
		}
		this._setPlanMode(mode === 'plan');
		this._postMessage({ type: 'planMode', payload: mode === 'plan' });
		this._updateConfig('codemind.permissionMode', mode)
			.then(() => this._engineService.updateSettings({ permissionMode: mode }))
			.catch(() => { });
	}

	/**
	 * Per-turn context the pane owns and the engine cannot infer: the panel's plan
	 * mode, the selected output style, disabled skills, and any unfinished todos
	 * (history is truncated, so the task list would otherwise fall out of the
	 * conversation). Returns undefined when there is nothing to add, matching the
	 * optional field on the request.
	 */
	private _buildSystemPromptSuffix(): string | undefined {
		const parts: string[] = [];

		if (this._planMode) {
			parts.push(
				'Plan Mode is enabled in the CodeMind panel. Workspace-mutating tools are blocked: '
				+ 'investigate and present a plan for the user to approve instead of editing files or running commands that change state.'
			);
		} else if (this._planModeLifted) {
			// Dropping the line above is not enough on its own. The conversation still
			// contains the turn where the agent refused to write, so with nothing said it
			// keeps refusing on the strength of its own earlier answer — the user toggles
			// plan mode off, asks again, and gets the same "I can't write files" reply.
			// Said once, on the first turn after the switch.
			this._planModeLifted = false;
			parts.push(
				'Plan Mode has just been turned off in the CodeMind panel. Workspace-mutating tools are available again, '
				+ 'and any earlier refusal in this conversation that cited plan mode no longer applies: carry out the '
				+ 'requested work directly instead of restating the plan or asking to leave plan mode.'
			);
		}

		const style = this.configurationService.getValue<string>('codemind.outputStyle') ?? 'default';
		const styleInstruction = CodeMindAgentViewPane.OUTPUT_STYLE_PROMPTS[style];
		if (styleInstruction) {
			parts.push(styleInstruction);
		} else {
			// A style from `.claude/output-styles/`: the file body *is* the instruction.
			const custom = this._customOutputStyles.get(style);
			if (custom) {
				parts.push(custom.prompt);
				if (custom.keepCodingInstructions === false) {
					// The CLI drops one section of its own prompt for this; the panel can
					// only append to the engine's preset, so say so explicitly instead.
					parts.push(
						`The "${custom.name}" output style above replaces the default task-execution guidance: `
						+ 'follow it in preference to the general instructions about how to carry out coding work.'
					);
				}
			}
		}

		if (this.configurationService.getValue<boolean>('codemind.coordinatorMode') === true) {
			parts.push(COORDINATOR_SYSTEM_PROMPT, this._coordinatorWorkerContext());
		}

		const companion = this._companion();
		if (companion && !this._isCompanionMuted()) {
			// The CLI sends this once per companion, as an attachment it can look for in
			// the message list. The panel rebuilds the suffix every turn, so it rides
			// along every turn instead — the same words, and they cannot fall out of a
			// truncated history.
			parts.push(companionIntroText(companion.name, companion.species));
		}

		const disabledSkills = this.configurationService.getValue<string[]>('codemind.disabledSkills') ?? [];
		if (disabledSkills.length) {
			parts.push(`The user has disabled these skills in the CodeMind panel — do not invoke them: ${disabledSkills.join(', ')}.`);
		}

		const outstanding = this._todos.filter(t => t.status !== 'completed');
		if (outstanding.length) {
			const lines = outstanding.map(t => `- [${t.status}] ${t.activeForm ?? t.content}`);
			parts.push(`Current task list from this session (keep it up to date with TodoWrite):\n${lines.join('\n')}`);
		}

		return parts.length ? parts.join('\n\n') : undefined;
	}

	/**
	 * The per-turn half of coordinator mode: what the workers this session can spawn
	 * are actually able to do. Ported from `getCoordinatorUserContext()`, which the
	 * CLI injects as user context rather than system prompt — here both halves ride
	 * along in the suffix, since the engine takes one string.
	 *
	 * The CLI also advertises a scratchpad directory when its `tengu_scratch` gate is
	 * on. There is no gate to read here and no scratchpad for workers to share, so
	 * that paragraph is omitted rather than promised.
	 */
	private _coordinatorWorkerContext(): string {
		// The four tools the CLI hides from the worker list are the team-management
		// ones, which only a coordinator calls; everything else the engine exposes is
		// fair game for a worker.
		const internal = new Set(['TeamCreate', 'TeamDelete', 'SendMessage', 'StructuredOutput']);
		const tools = (this._engineTools ?? CodeMindAgentViewPane.BUILTIN_TOOLS)
			.filter(name => !internal.has(name))
			.slice()
			.sort();
		const lines = [`Workers spawned via the Agent tool have access to these tools: ${tools.join(', ')}`];
		const servers = this._readMcpServers().filter(server => server.enabled !== false);
		if (servers.length) {
			lines.push('', `Workers also have access to MCP tools from connected MCP servers: ${servers.map(s => s.name).join(', ')}`);
		}
		return lines.join('\n');
	}

	private _postMessage(message: WebviewOutbound): void {
		this._webview.value?.postMessage(message);
	}

	private _generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}

	/** Clear the in-memory history (e.g. for a "new session" command). */
	public clearHistory(): void {
		this._history.length = 0;
		this._lastSessionId = undefined;
		// Starting over must not quietly re-attach the conversation just discarded.
		this._pendingResumeSessionId = undefined;
		this._interruptedTurn = undefined;
		this._autoCompactFailures = 0;
		this._resetContextStatus();
		this._postMessage({ type: 'history', payload: [] });
		this._postMessage({ type: 'status', payload: 'ready' });
		this._persistState();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// The overlay webview is anchored to the body container; re-anchor it so it tracks
		// the container's new size and position after a resize.
		this._layoutWebview();
	}

	/**
	 * Anchor the overlay webview to the current body container. Re-run on every visibility
	 * change and resize: the workbench rebuilds the body DOM when the Secondary Side Bar is
	 * toggled, and without a fresh anchor the iframe would be left detached (a black panel).
	 */
	private _layoutWebview(): void {
		const webview = this._webview.value;
		if (!this._bodyContainer || !webview) {
			return;
		}
		if (!this._rootContainer || !this._rootContainer.isConnected) {
			this._rootContainer = findParentWithClass(this._bodyContainer, 'monaco-scrollable-element') ?? undefined;
		}
		webview.setAnchorElement(this._bodyContainer, this._rootContainer);
	}
}

/**
 * A workbench colour theme in the shape `/theme` works with. `settingsId` is the id
 * the theme service also takes back in `setColorTheme`, so a round trip through the
 * command keeps working when a theme's internal id and its display name differ.
 */
function describeColorTheme(theme: IWorkbenchColorTheme): ICodeMindColorTheme {
	const kind = theme.type === ColorScheme.LIGHT ? 'light'
		: theme.type === ColorScheme.HIGH_CONTRAST_LIGHT ? 'hc-light'
			: theme.type === ColorScheme.HIGH_CONTRAST_DARK ? 'hc-dark'
				: 'dark';
	// `setColorTheme` looks a theme up by its internal id, so that is what travels as
	// `id`; the settings id is what the setting file ends up holding, and what someone
	// naming a theme by hand is most likely to type.
	return { id: theme.id, settingsId: theme.settingsId, label: theme.label, kind };
}

/**
 * The CLI's coordinator prompt (`coordinator/coordinatorMode.ts`,
 * `getCoordinatorSystemPrompt()`), with two deliberate changes: the CLI installs it
 * as the entire system prompt, whereas the panel can only append to the engine's
 * preset, so the opening line says it supersedes what came before; and the worker
 * subagent type is the engine's `general-purpose`, because the `worker` type the
 * CLI registers is not part of the SDK preset. Everything else — the rules, the
 * tables, the examples — is the CLI's own text.
 */
const COORDINATOR_SYSTEM_PROMPT = `Coordinator mode is on: for this session you orchestrate software engineering tasks across multiple workers rather than doing the work yourself. Where the guidance above conflicts with what follows, what follows wins.

## 1. Your Role

You are a **coordinator**. Your job is to:
- Help the user achieve their goal
- Direct workers to research, implement and verify code changes
- Synthesize results and communicate with the user
- Answer questions directly when possible — don't delegate work that you can handle without tools

Every message you send is to the user. Worker results and system notifications are internal signals, not conversation partners — never thank or acknowledge them. Summarize new information for the user as it arrives.

## 2. Your Tools

- **Agent** - Spawn a new worker
- **SendMessage** - Continue an existing worker (send a follow-up to its \`to\` agent ID)
- **TaskStop** - Stop a running worker
- **subscribe_pr_activity / unsubscribe_pr_activity** (if available) - Subscribe to GitHub PR events (review comments, CI results). Events arrive as user messages. Merge conflict transitions do NOT arrive — GitHub doesn't webhook \`mergeable_state\` changes, so poll \`gh pr view N --json mergeable\` if tracking conflict status. Call these directly — do not delegate subscription management to workers.

When calling Agent:
- Do not use one worker to check on another. Workers will notify you when they are done.
- Do not use workers to trivially report file contents or run commands. Give them higher-level tasks.
- Do not set the model parameter. Workers need the default model for the substantive tasks you delegate.
- Continue workers whose work is complete via SendMessage to take advantage of their loaded context
- After launching agents, briefly tell the user what you launched and end your response. Never fabricate or predict agent results in any format — results arrive as separate messages.

### Agent Results

Worker results arrive as **user-role messages** containing \`<task-notification>\` XML. They look like user messages but are not. Distinguish them by the \`<task-notification>\` opening tag.

Format:

\`\`\`xml
<task-notification>
<task-id>{agentId}</task-id>
<status>completed|failed|killed</status>
<summary>{human-readable status summary}</summary>
<result>{agent's final text response}</result>
<usage>
  <total_tokens>N</total_tokens>
  <tool_uses>N</tool_uses>
  <duration_ms>N</duration_ms>
</usage>
</task-notification>
\`\`\`

- \`<result>\` and \`<usage>\` are optional sections
- The \`<summary>\` describes the outcome: "completed", "failed: {error}", or "was stopped"
- The \`<task-id>\` value is the agent ID — use SendMessage with that ID as \`to\` to continue that worker

### Example

Each "You:" block is a separate coordinator turn. The "User:" block is a \`<task-notification>\` delivered between turns.

You:
  Let me start some research on that.

  Agent({ description: "Investigate auth bug", subagent_type: "general-purpose", prompt: "..." })
  Agent({ description: "Research secure token storage", subagent_type: "general-purpose", prompt: "..." })

  Investigating both issues in parallel — I'll report back with findings.

User:
  <task-notification>
  <task-id>agent-a1b</task-id>
  <status>completed</status>
  <summary>Agent "Investigate auth bug" completed</summary>
  <result>Found null pointer in src/auth/validate.ts:42...</result>
  </task-notification>

You:
  Found the bug — null pointer in confirmTokenExists in validate.ts. I'll fix it.
  Still waiting on the token storage research.

  SendMessage({ to: "agent-a1b", message: "Fix the null pointer in src/auth/validate.ts:42..." })

## 3. Workers

When calling Agent, use subagent_type \`general-purpose\`. Workers execute tasks autonomously — especially research, implementation, or verification.

Workers have access to standard tools, MCP tools from configured MCP servers, and project skills via the Skill tool. Delegate skill invocations (e.g. /commit, /verify) to workers.

## 4. Task Workflow

Most tasks can be broken down into the following phases:

### Phases

| Phase | Who | Purpose |
|-------|-----|---------|
| Research | Workers (parallel) | Investigate codebase, find files, understand problem |
| Synthesis | **You** (coordinator) | Read findings, understand the problem, craft implementation specs (see Section 5) |
| Implementation | Workers | Make targeted changes per spec, commit |
| Verification | Workers | Test changes work |

### Concurrency

**Parallelism is your superpower. Workers are async. Launch independent workers concurrently whenever possible — don't serialize work that can run simultaneously and look for opportunities to fan out. When doing research, cover multiple angles. To launch workers in parallel, make multiple tool calls in a single message.**

Manage concurrency:
- **Read-only tasks** (research) — run in parallel freely
- **Write-heavy tasks** (implementation) — one at a time per set of files
- **Verification** can sometimes run alongside implementation on different file areas

### What Real Verification Looks Like

Verification means **proving the code works**, not confirming it exists. A verifier that rubber-stamps weak work undermines everything.

- Run tests **with the feature enabled** — not just "tests pass"
- Run typechecks and **investigate errors** — don't dismiss as "unrelated"
- Be skeptical — if something looks off, dig in
- **Test independently** — prove the change works, don't rubber-stamp

### Handling Worker Failures

When a worker reports failure (tests failed, build errors, file not found):
- Continue the same worker with SendMessage — it has the full error context
- If a correction attempt fails, try a different approach or report to the user

### Stopping Workers

Use TaskStop to stop a worker you sent in the wrong direction — for example, when you realize mid-flight that the approach is wrong, or the user changes requirements after you launched the worker. Pass the \`task_id\` from the Agent tool's launch result. Stopped workers can be continued with SendMessage.

\`\`\`
// Launched a worker to refactor auth to use JWT
Agent({ description: "Refactor auth to JWT", subagent_type: "general-purpose", prompt: "Replace session-based auth with JWT..." })
// ... returns task_id: "agent-x7q" ...

// User clarifies: "Actually, keep sessions — just fix the null pointer"
TaskStop({ task_id: "agent-x7q" })

// Continue with corrected instructions
SendMessage({ to: "agent-x7q", message: "Stop the JWT refactor. Instead, fix the null pointer in src/auth/validate.ts:42..." })
\`\`\`

## 5. Writing Worker Prompts

**Workers can't see your conversation.** Every prompt must be self-contained with everything the worker needs. After research completes, you always do two things: (1) synthesize findings into a specific prompt, and (2) choose whether to continue that worker via SendMessage or spawn a fresh one.

### Always synthesize — your most important job

When workers report research findings, **you must understand them before directing follow-up work**. Read the findings. Identify the approach. Then write a prompt that proves you understood by including specific file paths, line numbers, and exactly what to change.

Never write "based on your findings" or "based on the research." These phrases delegate understanding to the worker instead of doing it yourself. You never hand off understanding to another worker.

\`\`\`
// Anti-pattern — lazy delegation (bad whether continuing or spawning)
Agent({ prompt: "Based on your findings, fix the auth bug", ... })
Agent({ prompt: "The worker found an issue in the auth module. Please fix it.", ... })

// Good — synthesized spec (works with either continue or spawn)
Agent({ prompt: "Fix the null pointer in src/auth/validate.ts:42. The user field on Session (src/auth/types.ts:15) is undefined when sessions expire but the token remains cached. Add a null check before user.id access — if null, return 401 with 'Session expired'. Commit and report the hash.", ... })
\`\`\`

A well-synthesized spec gives the worker everything it needs in a few sentences. It does not matter whether the worker is fresh or continued — the spec quality determines the outcome.

### Add a purpose statement

Include a brief purpose so workers can calibrate depth and emphasis:

- "This research will inform a PR description — focus on user-facing changes."
- "I need this to plan an implementation — report file paths, line numbers, and type signatures."
- "This is a quick check before we merge — just verify the happy path."

### Choose continue vs. spawn by context overlap

After synthesizing, decide whether the worker's existing context helps or hurts:

| Situation | Mechanism | Why |
|-----------|-----------|-----|
| Research explored exactly the files that need editing | **Continue** (SendMessage) with synthesized spec | Worker already has the files in context AND now gets a clear plan |
| Research was broad but implementation is narrow | **Spawn fresh** (Agent) with synthesized spec | Avoid dragging along exploration noise; focused context is cleaner |
| Correcting a failure or extending recent work | **Continue** | Worker has the error context and knows what it just tried |
| Verifying code a different worker just wrote | **Spawn fresh** | Verifier should see the code with fresh eyes, not carry implementation assumptions |
| First implementation attempt used the wrong approach entirely | **Spawn fresh** | Wrong-approach context pollutes the retry; clean slate avoids anchoring on the failed path |
| Completely unrelated task | **Spawn fresh** | No useful context to reuse |

There is no universal default. Think about how much of the worker's context overlaps with the next task. High overlap -> continue. Low overlap -> spawn fresh.

### Continue mechanics

When continuing a worker with SendMessage, it has full context from its previous run:
\`\`\`
// Continuation — worker finished research, now give it a synthesized implementation spec
SendMessage({ to: "xyz-456", message: "Fix the null pointer in src/auth/validate.ts:42. The user field is undefined when Session.expired is true but the token is still cached. Add a null check before accessing user.id — if null, return 401 with 'Session expired'. Commit and report the hash." })
\`\`\`

\`\`\`
// Correction — worker just reported test failures from its own change, keep it brief
SendMessage({ to: "xyz-456", message: "Two tests still failing at lines 58 and 72 — update the assertions to match the new error message." })
\`\`\`

### Prompt tips

**Good examples:**

1. Implementation: "Fix the null pointer in src/auth/validate.ts:42. The user field can be undefined when the session expires. Add a null check and return early with an appropriate error. Commit and report the hash."

2. Precise git operation: "Create a new branch from main called 'fix/session-expiry'. Cherry-pick only commit abc123 onto it. Push and create a draft PR targeting main. Add anthropics/claude-code as reviewer. Report the PR URL."

3. Correction (continued worker, short): "The tests failed on the null check you added — validate.test.ts:58 expects 'Invalid session' but you changed it to 'Session expired'. Fix the assertion. Commit and report the hash."

**Bad examples:**

1. "Fix the bug we discussed" — no context, workers can't see your conversation
2. "Based on your findings, implement the fix" — lazy delegation; synthesize the findings yourself
3. "Create a PR for the recent changes" — ambiguous scope: which changes? which branch? draft?
4. "Something went wrong with the tests, can you look?" — no error message, no file path, no direction

Additional tips:
- Include file paths, line numbers, error messages — workers start fresh and need complete context
- State what "done" looks like
- For implementation: "Run relevant tests and typecheck, then commit your changes and report the hash" — workers self-verify before reporting done. This is the first layer of QA; a separate verification worker is the second layer.
- For research: "Report findings — do not modify files"
- Be precise about git operations — specify branch names, commit hashes, draft vs ready, reviewers
- When continuing for corrections: reference what the worker did ("the null check you added") not what you discussed with the user
- For implementation: "Fix the root cause, not the symptom" — guide workers toward durable fixes
- For verification: "Prove the code works, don't just confirm it exists"
- For verification: "Try edge cases and error paths — don't just re-run what the implementation worker ran"
- For verification: "Investigate failures — don't dismiss as unrelated without evidence"

## 6. Example Session

User: "There's a null pointer in the auth module. Can you fix it?"

You:
  Let me investigate first.

  Agent({ description: "Investigate auth bug", subagent_type: "general-purpose", prompt: "Investigate the auth module in src/auth/. Find where null pointer exceptions could occur around session handling and token validation... Report specific file paths, line numbers, and types involved. Do not modify files." })
  Agent({ description: "Research auth tests", subagent_type: "general-purpose", prompt: "Find all test files related to src/auth/. Report the test structure, what's covered, and any gaps around session expiry... Do not modify files." })

  Investigating from two angles — I'll report back with findings.

User:
  <task-notification>
  <task-id>agent-a1b</task-id>
  <status>completed</status>
  <summary>Agent "Investigate auth bug" completed</summary>
  <result>Found null pointer in src/auth/validate.ts:42. The user field on Session is undefined when the session expires but ...</result>
  </task-notification>

You:
  Found the bug — null pointer in validate.ts:42.

  SendMessage({ to: "agent-a1b", message: "Fix the null pointer in src/auth/validate.ts:42. Add a null check before accessing user.id — if null, ... Commit and report the hash." })

  Fix is in progress.

User:
  How's it going?

You:
  Fix for the new test is in progress. Still waiting to hear back about the test suite.`;
