/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { calculateContextStatus, ICodeMindAgentEngineService, ICodeMindExecResult, ICodeMindMcpServer, ICodeMindModelInfo, ICodeMindSandboxSettings } from '../common/codeMindAgentEngineService.js';

/** One past session, as summarized from the engine's transcript log. */
export interface ICodeMindSessionSummary {
	readonly id: string;
	/** The first thing the user asked in that session, clipped for a picker row. */
	readonly summary: string;
	/** Last modified time of the log, ms since epoch. */
	readonly at: number;
	/** How many entries the log holds — a rough length for the session. */
	readonly messages: number;
	/**
	 * Workspace the session belongs to, when it is not this one. Only set while
	 * listing across projects, which is what makes a cross-project resume visible
	 * before it happens.
	 */
	readonly project?: string;
}

/**
 * An output style loaded from `.claude/output-styles/<name>.md`. The file body is
 * the prompt; the front matter names and describes it. `keepCodingInstructions:
 * false` is the CLI's way of saying the style replaces the engine's own
 * task-execution guidance rather than adding to it.
 */
export interface ICodeMindOutputStyle {
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
	/** 'User style' or 'Project style' — where the file was found. */
	readonly source: string;
	readonly path: string;
	readonly keepCodingInstructions?: boolean;
}

/** One installed colour theme, as `/theme` needs to see it. */
export interface ICodeMindColorTheme {
	/**
	 * What `setColorTheme` takes: the theme's internal id (`vscode-theme-defaults-…`),
	 * which is what the theme registry looks itself up by. Not the settings id.
	 */
	readonly id: string;
	/** The value `workbench.colorTheme` holds for this theme, e.g. `Default Dark Modern`. */
	readonly settingsId: string;
	readonly label: string;
	/** The theme's own kind, not a guess from its name. */
	readonly kind: 'light' | 'dark' | 'hc-light' | 'hc-dark';
}


/**
 * What the engine's transcript logs say about how this project has been worked
 * on. Counted from the logs rather than from the panel's own transcript, so it
 * covers every past session including the ones run from the CLI.
 */
export interface ICodeMindProjectInsights {
	/** Session logs found, and how many of them were actually read. */
	readonly sessions: number;
	readonly scanned: number;
	readonly firstAt: number;
	readonly lastAt: number;
	readonly userPrompts: number;
	readonly assistantMessages: number;
	/** Tool names by how often they were called, most used first. */
	readonly toolCalls: readonly { readonly name: string; readonly count: number }[];
	/** Files the agent read or wrote, most touched first. */
	readonly files: readonly { readonly path: string; readonly count: number }[];
}

/**
 * Everything a slash command is allowed to do to the panel and its environment.
 * The view pane builds one of these per dispatch, so commands never need to
 * reach for workbench services themselves.
 */
export interface ICodeMindCommandContext {
	readonly engineService: ICodeMindAgentEngineService;
	/** Absolute path of the first workspace folder, or '' when none is open. */
	readonly workspaceRoot: string;
	readonly appendSystemMessage: (text: string) => void;
	readonly openPanel: (panelId: string) => void;
	readonly refreshView: () => void;
	/** Run a visible agent turn (renders as a normal exchange in the chat). */
	readonly sendToAgent: (prompt: string) => void;
	/** Run a hidden agent turn and resolve with its final text. */
	readonly silentQuery: (prompt: string) => Promise<string>;
	/**
	 * Run a one-shot side question (`/btw`): hidden, isolated from the session,
	 * with every tool refused so it answers from the conversation alone.
	 */
	readonly sideQuery: (question: string) => Promise<string>;
	/** Flip vim keybindings; resolves once the new state has been stored. */
	readonly toggleVim: () => Promise<void>;
	readonly isVimMode: () => boolean;
	readonly setPlanMode: (enabled: boolean) => void;
	readonly isPlanMode: () => boolean;
	readonly setModel: (model: string) => Promise<void>;
	readonly getModel: () => string;
	readonly getPermissionMode: () => string;
	readonly setPermissionMode: (mode: string) => Promise<void>;
	readonly getOutputStyle: () => string;
	readonly setOutputStyle: (style: string) => Promise<void>;
	/**
	 * Styles found under `.claude/output-styles/`, re-read from disk on every call
	 * so a file added since the panel opened shows up without a reload.
	 */
	readonly listOutputStyles: () => Promise<readonly ICodeMindOutputStyle[]>;
	/** Whether the agent is orchestrating workers rather than doing the work itself. */
	readonly isCoordinatorMode: () => boolean;
	readonly setCoordinatorMode: (enabled: boolean) => Promise<void>;

	/**
	 * Whether the panel compacts on its own once the context window fills. Affects
	 * how much headroom `/context` reports: with auto-compaction on, the ceiling is
	 * the compaction threshold rather than the window itself.
	 */
	readonly isAutoCompactEnabled: () => boolean;
	/** The chat transcript, oldest first. */
	readonly transcript: () => ReadonlyArray<{ role: string; content: string; timestamp: number }>;
	/** Replace the transcript with a single summary message. */
	readonly replaceTranscript: (summary: string) => void;
	/** Drop the last `turns` exchanges; resolves to how many were removed. */
	readonly rewind: (turns: number) => number;
	/** Open a diff editor for a workspace-relative path against HEAD. */
	readonly openDiff: (relativePath: string) => Promise<void>;
	/** Show the commit review sheet with a proposed message. */
	readonly openCommitReview: (message: string, files: readonly string[]) => void;
	/** Ask for a save location and write `contents`; resolves to the path used. */
	readonly saveTextFile: (defaultName: string, contents: string) => Promise<string | undefined>;
	/** Read a workspace-relative text file, or undefined when missing. */
	readonly readTextFile: (relativePath: string) => Promise<string | undefined>;
	/**
	 * Write a workspace-relative (or absolute) text file, refusing to clobber an
	 * existing one unless `overwrite` is set. Resolves to the path written, or
	 * undefined when it could not be written.
	 */
	readonly writeTextFile: (relativePath: string, contents: string, overwrite?: boolean) => Promise<string | undefined>;
	/** True when a workspace-relative (or absolute) path already exists. */
	readonly fileExists: (relativePath: string) => Promise<boolean>;
	/** Names of the entries in a workspace-relative directory. */
	readonly listDirectory: (relativePath: string) => Promise<string[]>;
	/** Add another folder to the workspace via the native picker. */
	readonly addDirectory: (path?: string) => Promise<void>;
	/** The session id remembered for this workspace, if any. */
	readonly storedSessionId: () => string | undefined;
	/**
	 * Sessions the engine has recorded for this workspace, newest first, read from
	 * its own transcript log so sessions started outside the panel are listed too.
	 * With `allProjects`, every project the engine has a log directory for is
	 * scanned and each row carries the project it came from.
	 */
	readonly listSessions: (allProjects?: boolean) => Promise<readonly ICodeMindSessionSummary[]>;
	/** Aggregate what the engine's transcript logs say about this project. */
	readonly projectInsights: () => Promise<ICodeMindProjectInsights | undefined>;
	/** Put text on the system clipboard. */
	readonly copyToClipboard: (text: string) => Promise<void>;
	/** Show a quick pick; resolves to the chosen id, or undefined when dismissed. */
	readonly pick: (placeHolder: string, items: readonly { id: string; label: string; description?: string; detail?: string }[]) => Promise<string | undefined>;
	/** Ask for a line of text; resolves to undefined when dismissed. */
	readonly promptText: (prompt: string, value?: string) => Promise<string | undefined>;
	/** Open a URL in the user's browser. */
	readonly openExternal: (url: string) => Promise<void>;
	/** Execute a workbench command by id (used where the GUI already has real UI). */
	readonly runWorkbenchCommand: (id: string, ...args: unknown[]) => Promise<void>;
	/**
	 * The colour themes installed, and the one in use. `kind` is the theme's own
	 * classification, which is what `/theme dark` matches on — a name is no guide
	 * ("Solarized Light" and "Quiet Light" are both light, "Abyss" is neither).
	 */
	readonly listColorThemes: () => Promise<readonly ICodeMindColorTheme[]>;
	readonly getColorTheme: () => ICodeMindColorTheme;
	/** Apply a colour theme by id, writing the same user setting the picker writes. */
	readonly setColorTheme: (id: string) => Promise<void>;
	/** Hide the agent panel — the GUI equivalent of leaving the REPL. */
	readonly hidePanel: () => void;
	/** Read any registered `codemind.*` configuration value. */
	readonly getConfig: <T>(key: string) => T | undefined;
	/** Write a registered `codemind.*` configuration value. */
	readonly setConfig: (key: string, value: unknown) => Promise<void>;
	/** Set the session's display name (shown in the header). */
	readonly setSessionName: (name: string) => Promise<void>;
	readonly getSessionName: () => string;
	/** Set the prompt-bar accent colour, or '' to clear it. */
	readonly setPromptColor: (color: string) => Promise<void>;
	readonly getPromptColor: () => string;
	/** Toggle a searchable tag on this session; resolves to the tag list after the change. */
	readonly toggleTag: (tag: string) => Promise<readonly string[]>;
	readonly getTags: () => readonly string[];
	/** Read a file under the user's home directory, or undefined when missing. */
	readonly readHomeFile: (relativePath: string) => Promise<string | undefined>;
	/**
	 * Write a file under the user's `~/.claude` directory, creating parents as
	 * needed. Resolves to the absolute path written, or undefined when it could
	 * not be written. Used by the commands that edit user-scope engine settings.
	 */
	readonly writeHomeFile: (relativePath: string, contents: string) => Promise<string | undefined>;
	/** Names of the entries of a directory under the user's home directory. */
	readonly listHomeEntries: (relativePath: string) => Promise<string[]>;

}

export interface ICodeMindCommand {
	readonly name: string;
	readonly description: string;
	readonly args?: string;
	/**
	 * Kept out of `/help` and out of the autocomplete menu, exactly like the
	 * CLI's `isHidden` commands — still dispatchable when typed in full.
	 */
	readonly hidden?: boolean;
	/** Alternate names that dispatch to this command (CLI `aliases`). */
	readonly aliases?: readonly string[];
	readonly execute: (args: string, context: ICodeMindCommandContext) => Promise<void>;
}

export class CodeMindCommandRegistry {

	private readonly _commands = new Map<string, ICodeMindCommand>();
	private readonly _aliases = new Map<string, string>();

	register(command: ICodeMindCommand): void {
		this._commands.set(command.name, command);
		for (const alias of command.aliases ?? []) {
			this._aliases.set(alias, command.name);
		}
	}

	get(name: string): ICodeMindCommand | undefined {
		const direct = this._commands.get(name);
		if (direct) {
			return direct;
		}
		const aliased = this._aliases.get(name);
		return aliased ? this._commands.get(aliased) : undefined;
	}

	list(): ICodeMindCommand[] {
		return Array.from(this._commands.values());
	}

	/** Everything `/help` and the autocomplete menu are allowed to show. */
	listVisible(): ICodeMindCommand[] {
		return this.list().filter(c => !c.hidden);
	}

	/** Names that match a prefix, used for autocomplete. */
	filter(prefix: string): ICodeMindCommand[] {
		const p = prefix.toLowerCase();
		return this.listVisible().filter(c => c.name.toLowerCase().startsWith(p));
	}
}

/** Shared singleton — populated by {@link registerBuiltinCommands}. */
export const commandRegistry = new CodeMindCommandRegistry();

// --- helpers shared by the git / diagnostics commands

/** Run a git subcommand in the workspace root. */
function git(ctx: ICodeMindCommandContext, ...args: string[]): Promise<ICodeMindExecResult> {
	return ctx.engineService.exec({ command: 'git', args, cwd: ctx.workspaceRoot });
}

/** True when a process both started and exited cleanly. */
function succeeded(result: ICodeMindExecResult): boolean {
	return !result.error && result.exitCode === 0;
}

/** The most useful failure text a process gave us. */
function failureText(result: ICodeMindExecResult): string {
	return (result.error || result.stderr || result.stdout || `exit code ${result.exitCode}`).trim();
}

/** Clip long process output so a chat bubble stays readable. */
function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/** Rough token estimate — the same 4-chars-per-token rule the input counter uses. */
function estimateTokens(text: string): number {
	return estimateTokensForChars(text.length);
}

/** The same estimate for a character count that was summed rather than concatenated. */
function estimateTokensForChars(chars: number): number {
	return Math.ceil(chars / 4);
}

function requireWorkspace(ctx: ICodeMindCommandContext): boolean {
	if (!ctx.workspaceRoot) {
		ctx.appendSystemMessage('Open a folder first — this command needs a workspace.');
		return false;
	}
	return true;
}

/**
 * The branch this work forked from, for commands that must review a whole branch
 * rather than the uncommitted diff. Tries the remote's default first so a stale
 * local `main` does not win, and returns undefined when nothing resolves.
 */
async function detectBaseBranch(ctx: ICodeMindCommandContext, requested?: string): Promise<string | undefined> {
	if (requested) {
		return requested;
	}
	for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
		const exists = await git(ctx, 'rev-parse', '--verify', '--quiet', candidate);
		if (succeeded(exists) && exists.stdout.trim()) {
			return candidate;
		}
	}
	return undefined;
}

/** Run a `gh` subcommand in the workspace root. */
function gh(ctx: ICodeMindCommandContext, ...args: string[]): Promise<ICodeMindExecResult> {
	return ctx.engineService.exec({ command: 'gh', args, cwd: ctx.workspaceRoot, timeoutMs: 20000 });
}

/** True when `gh` could not even be started, which needs its own message. */
function ghMissing(result: ICodeMindExecResult): boolean {
	return !!result.error && !result.stderr;
}

/**
 * Concrete model ids the panel offers. Never date-suffixed: the engine resolves a
 * family id to the current snapshot itself.
 */
const MODEL_IDS = [
	'claude-opus-5',
	'claude-opus-4-8',
	'claude-sonnet-5',
	'claude-sonnet-4-6',
	'claude-haiku-4-5',
	'claude-fable-5',
];

/**
 * The CLI's model aliases, listed with what each one means. They are forwarded to
 * the engine verbatim rather than resolved here — that is what lets `opusplan`
 * keep its "Opus while planning, Sonnet while working" behaviour and lets the
 * `[1m]` suffix turn on the 1M-context beta for the models that support it.
 */
const MODEL_ALIASES: readonly { readonly name: string; readonly detail: string }[] = [
	{ name: 'default', detail: 'whatever the account defaults to' },
	{ name: 'opus', detail: 'latest Opus' },
	{ name: 'sonnet', detail: 'latest Sonnet' },
	{ name: 'haiku', detail: 'latest Haiku' },
	{ name: 'best', detail: 'the most capable model available' },
	{ name: 'opusplan', detail: 'Opus while planning, Sonnet while working' },
	{ name: 'opus[1m]', detail: 'Opus with the 1M-token context beta' },
	{ name: 'sonnet[1m]', detail: 'Sonnet with the 1M-token context beta' },
];

/** Everything `/model` accepts, aliases first. */
const MODEL_CHOICES = [...MODEL_ALIASES.map(a => a.name), ...MODEL_IDS];

/**
 * Models worth consulting as an advisor. Haiku and the plan-mode/1M aliases are
 * left out: an advisor is asked the hard questions, and the engine only honours a
 * concrete Opus- or Sonnet-class model here.
 */
const ADVISOR_CHOICES = ['opus', 'sonnet', ...MODEL_IDS.filter(m => m.startsWith('claude-opus-') || m.startsWith('claude-sonnet-'))];

/** Words that turn a model-shaped setting back to its default. */
const MODEL_RESET_WORDS = ['off', 'none', 'disable', 'default', 'reset'];

/**
 * Permission modes the engine understands, shown by `/permissions`. Exported because the
 * panel's mode pill offers the same four and must not drift from this list.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

/**
 * The order Shift+Tab walks, copied from the CLI's `getNextPermissionMode`: plan
 * sits between acceptEdits and bypassPermissions, so the two safe modes come first
 * and the one that stops asking is the furthest away.
 */
const PERMISSION_MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** What each mode means, said the way the CLI's mode line says it. */
const PERMISSION_MODE_LABELS: Record<string, string> = {
	default: 'Permission mode: default — asks before edits and commands.',
	acceptEdits: 'Permission mode: acceptEdits — file edits are auto-approved, commands still ask.',
	plan: 'Permission mode: plan — read-only. The agent researches and plans, and changes nothing.',
	bypassPermissions: 'Permission mode: bypassPermissions — nothing is asked. Only use this in a workspace you can throw away.',
};

/**
 * The mode a typed word names, whatever case it was typed in. `acceptEdits` and
 * `bypassPermissions` are the two the user cannot be expected to camel-case by hand,
 * and the CLI accepts them either way.
 */
function resolvePermissionMode(word: string): string | undefined {
	const needle = word.trim().toLowerCase();
	return PERMISSION_MODES.find(m => m.toLowerCase() === needle);
}

/** Output styles `/output-style` can switch between, before any on-disk ones. */
export const OUTPUT_STYLES = ['default', 'explanatory', 'concise', 'learning'];

/** Reasoning budgets `/effort` can switch between. `auto` unsets the override. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

/** Prompt-bar colours `/color` accepts, matching the CLI's agent colours. */
const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];

/** Words that clear the prompt-bar colour again. */
const COLOR_RESET_WORDS = ['default', 'reset', 'none', 'gray', 'grey'];

/**
 * Every external page a command can open. Collected here so the set of hosts the
 * panel can reach is auditable in one place — commands never build URLs inline.
 */
const LINKS = {
	changelog: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
	stickers: 'https://www.stickermule.com/claudecode',
	slackApp: 'https://slack.com/marketplace/A08SF47R6P4-claude',
	githubApp: 'https://github.com/apps/claude',
	githubAction: 'https://github.com/anthropics/claude-code-action',
	githubActionExample: 'https://github.com/anthropics/claude-code-action/blob/main/examples/claude.yml',
	ghCliInstall: 'https://github.com/cli/cli#installation',
	upgradeMax: 'https://claude.ai/upgrade/max',
	extraUsage: 'https://claude.ai/settings/usage',
	privacy: 'https://claude.ai/settings/data-privacy-controls',
	chrome: 'https://claude.ai/chrome',
	chromeDocs: 'https://code.claude.com/docs/en/chrome',
} as const;

/**
 * Register every GUI command that mirrors a Claude Code CLI command. Where the
 * CLI opens a TUI panel, the GUI opens a webview panel instead.
 */
export function registerBuiltinCommands(registry: CodeMindCommandRegistry = commandRegistry): void {
	registerGitCommands(registry);
	registerSessionCommands(registry);
	registerConfigCommands(registry);
	registerPanelCommands(registry);
	registerModelCommands(registry);
	registerConversationCommands(registry);
	registerSetupCommands(registry);
	registerAccountCommands(registry);
	registerDiagnosticCommands(registry);
}

// --- git + code review

function registerGitCommands(registry: CodeMindCommandRegistry): void {

	registry.register({
		name: 'commit',
		description: localize('cmcmd.commit', 'Stage all changes, draft a commit message, and review it before committing.'),
		args: '[message]',
		execute: async (args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			const status = await git(ctx, 'status', '--porcelain');
			if (!succeeded(status)) {
				ctx.appendSystemMessage(`git status failed: ${failureText(status)}`);
				return;
			}
			if (!status.stdout.trim()) {
				ctx.appendSystemMessage('Nothing to commit — the working tree is clean.');
				return;
			}
			const files = status.stdout.split(/\r?\n/).filter(Boolean).map(line => line.slice(3).trim());
			const staged = await git(ctx, 'add', '-A');
			if (!succeeded(staged)) {
				ctx.appendSystemMessage(`git add failed: ${failureText(staged)}`);
				return;
			}
			let message = args.trim();
			if (!message) {
				const diff = await git(ctx, 'diff', '--cached', '--no-color');
				ctx.appendSystemMessage(`Staged ${files.length} file${files.length === 1 ? '' : 's'}. Drafting a commit message…`);
				const answer = await ctx.silentQuery([
					'Write a commit message for the staged diff below.',
					'Use the Conventional Commits style: a short subject line under 72 characters,',
					'then a blank line and up to four bullet points if the change needs them.',
					'Reply with the commit message only — no code fences, no commentary.',
					'',
					clip(diff.stdout, 24000),
				].join('\n'));
				message = answer.replace(/^```[a-z]*\r?\n?|```$/g, '').trim();
			}
			if (!message) {
				ctx.appendSystemMessage('Could not draft a commit message. Pass one directly: /commit <message>');
				return;
			}
			ctx.openCommitReview(message, files);
		},
	});

	registry.register({
		name: 'review',
		description: localize('cmcmd.review', 'Review a pull request, a branch, a path, or the uncommitted diff.'),
		args: '[pr-number|url|path]',
		execute: async (args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			const target = args.trim();
			// The CLI's /review reviews a pull request when given one, so a bare number or
			// a GitHub PR URL goes to `gh`; anything else is treated as a path.
			const prMatch = /^#?(\d+)$/.exec(target) ?? /\/pull\/(\d+)/.exec(target);
			if (prMatch) {
				await reviewPullRequest(ctx, prMatch[1]);
				return;
			}
			const diff = target
				? await git(ctx, 'diff', 'HEAD', '--no-color', '--', target)
				: await git(ctx, 'diff', 'HEAD', '--no-color');
			if (!succeeded(diff)) {
				ctx.appendSystemMessage(`git diff failed: ${failureText(diff)}`);
				return;
			}
			if (!diff.stdout.trim()) {
				ctx.appendSystemMessage(target ? `No uncommitted changes in ${target}.` : 'No uncommitted changes to review.');
				return;
			}
			ctx.sendToAgent([
				'Review this diff as a careful senior engineer.',
				'Report correctness bugs first, then missing tests, then style. For each finding give',
				'the file, the line, what breaks, and the concrete fix. Say so plainly if it looks fine.',
				'',
				'```diff',
				clip(diff.stdout, 60000),
				'```',
			].join('\n'));
		},
	});

	registry.register({
		name: 'security-review',
		description: localize('cmcmd.securityReview', 'Audit this branch (or the uncommitted diff) for security problems.'),
		args: '[base-branch]',
		execute: async (args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			const requested = args.trim();
			// A branch is the right unit of review: the working-tree diff misses anything
			// already committed on the feature branch, which is most of what a review is
			// meant to catch. Fall back to `HEAD` only when there is no base to compare to.
			const base = await detectBaseBranch(ctx, requested || undefined);
			let scope: string | undefined;
			let patch = '';
			if (base) {
				const range = `${base}...HEAD`;
				const branchDiff = await git(ctx, 'diff', range, '--no-color');
				if (succeeded(branchDiff) && branchDiff.stdout.trim()) {
					scope = `git diff ${range}`;
					patch = branchDiff.stdout;
				} else if (!succeeded(branchDiff) && requested) {
					ctx.appendSystemMessage(`Could not diff against ${base}: ${failureText(branchDiff)}`);
					return;
				}
			}
			if (!scope) {
				const treeDiff = await git(ctx, 'diff', 'HEAD', '--no-color');
				if (!succeeded(treeDiff)) {
					ctx.appendSystemMessage(`git diff failed: ${failureText(treeDiff)}`);
					return;
				}
				if (!treeDiff.stdout.trim()) {
					ctx.appendSystemMessage(base
						? `No changes against ${base} and nothing uncommitted — nothing to audit.`
						: 'No uncommitted changes to audit.');
					return;
				}
				scope = 'git diff HEAD';
				patch = treeDiff.stdout;
			}

			ctx.appendSystemMessage(`Auditing \`${scope}\` for security problems…`);
			ctx.sendToAgent([
				`You are a security engineer reviewing \`${scope}\` in this repository. Report only vulnerabilities`,
				'this change actually introduces or leaves exploitable. Read the surrounding code and the callers',
				'before reporting anything — a finding you cannot trace from an attacker-controlled input to the',
				'damage is a false positive, and false positives are worse than silence here. Do not change any files.',
				'',
				'Look for:',
				'  · injection — SQL, command, LDAP, XPath, template, header, log',
				'  · cross-site scripting and unsafe HTML or DOM sinks',
				'  · missing or bypassable authentication and authorization, including IDOR and confused-deputy paths',
				'  · insecure deserialization and unsafe reflection or dynamic import',
				'  · path traversal, unrestricted file write, zip-slip, symlink following',
				'  · server-side request forgery and unvalidated redirects',
				'  · secrets, tokens or keys committed to source, logged, or sent to third parties',
				'  · weak or misused cryptography, predictable randomness for security decisions, bad TLS settings',
				'  · unsafe defaults: permissive CORS, disabled certificate checks, debug endpoints, wide permissions',
				'  · race conditions with a security consequence (TOCTOU on files, permissions, or balances)',
				'  · dependency changes that pull in unvetted or typosquatted packages',
				'',
				'Do not report: denial of service or resource exhaustion, missing rate limits, memory safety in',
				'garbage-collected languages, generic "add more validation" advice, style, or anything in test',
				'fixtures and sample data that never runs in production.',
				'',
				'For each surviving finding give, in this order: severity (critical/high/medium/low), file:line,',
				'the attack path from untrusted input to impact, and the concrete fix. Rank by exploitability.',
				'If nothing survives verification, say exactly that and list what you checked.',
				'',
				'```diff',
				clip(patch, 60000),
				'```',
			].join('\n'));
		},
	});

	registry.register({
		name: 'diff',
		description: localize('cmcmd.diff', 'Open a diff editor for a changed file against HEAD.'),
		args: '[path]',
		execute: async (args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			let target = args.trim();
			if (!target) {
				const changed = await git(ctx, 'diff', '--name-only', 'HEAD');
				const names = changed.stdout.split(/\r?\n/).map(n => n.trim()).filter(Boolean);
				if (names.length > 1) {
					ctx.appendSystemMessage(`Changed files:\n${names.map(n => `  ${n}`).join('\n')}\n\nPass one: /diff <path>`);
					return;
				}
				target = names[0] ?? '';
			}
			if (!target) {
				ctx.appendSystemMessage('No changed files to diff.');
				return;
			}
			await ctx.openDiff(target);
		},
	});

	registry.register({
		name: 'files',
		description: localize('cmcmd.files', 'List the files changed in the working tree.'),
		execute: async (_args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			const status = await git(ctx, 'status', '--short', '--branch');
			if (!succeeded(status)) {
				ctx.appendSystemMessage(`git status failed: ${failureText(status)}`);
				return;
			}
			ctx.appendSystemMessage(status.stdout.trim() || 'Working tree is clean.');
		},
	});

	registry.register({
		name: 'branch',
		// The CLI gives /branch the `fork` alias whenever the fork-subagent feature
		// is off, which is the case here.
		aliases: ['fork'],
		description: localize('cmcmd.branch', 'Fork this conversation: keep the history, continue under a new session.'),
		args: '[title]',
		execute: async (args, ctx) => {
			// This forks the *conversation*, not git — the same as the CLI. Git branch
			// switching lives in /git-branch.
			const source = await ctx.engineService.forkSession();
			if (!source) {
				ctx.appendSystemMessage('There is no conversation to fork yet — send a message first.');
				return;
			}
			const title = args.trim();
			if (title) {
				await ctx.setSessionName(title);
			}
			ctx.appendSystemMessage([
				`Forked from session ${source}.`,
				'The next message continues here with everything said so far, under a new session id.',
				`The original conversation is untouched — /resume ${source} goes back to it.`,
				...(title ? [`This fork is named "${title}".`] : []),
			].join('\n'));
		},
	});

	registry.register({
		name: 'git-branch',
		// CodeMind-only: the CLI has no git-branch command, and /branch is the
		// conversation fork there, so the git behaviour needs its own name.
		hidden: true,
		description: localize('cmcmd.gitBranch', 'Show the current git branch, or switch to (and create) one.'),
		args: '[name]',
		execute: async (args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			const name = args.trim();
			if (!name) {
				const current = await git(ctx, 'rev-parse', '--abbrev-ref', 'HEAD');
				const all = await git(ctx, 'branch', '--list', '--sort=-committerdate');
				ctx.appendSystemMessage([
					`Current branch: ${current.stdout.trim() || 'unknown'}`,
					'',
					clip(all.stdout.trimEnd(), 2000) || '(no branches)',
				].join('\n'));
				return;
			}
			const exists = await git(ctx, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`);
			const switched = succeeded(exists)
				? await git(ctx, 'switch', name)
				: await git(ctx, 'switch', '--create', name);
			ctx.appendSystemMessage(succeeded(switched)
				? `${succeeded(exists) ? 'Switched to' : 'Created and switched to'} branch ${name}.`
				: `git switch failed: ${failureText(switched)}`);
		},
	});

	registry.register({
		name: 'pr_comments',
		description: localize('cmcmd.prComments', 'Show pull request comments, reviews and inline review notes.'),
		args: '[pr-number]',
		execute: async (args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			const wanted = args.trim().replace(/^#/, '');
			const view = await gh(ctx, 'pr', 'view', ...(wanted ? [wanted] : []), '--json', 'number,title,url,body,comments,reviews');
			if (ghMissing(view)) {
				ctx.appendSystemMessage(`GitHub CLI (gh) is not on PATH. Install it from ${LINKS.ghCliInstall} to use /pr_comments.`);
				return;
			}
			if (!succeeded(view)) {
				ctx.appendSystemMessage(`gh pr view failed: ${failureText(view)}`);
				return;
			}
			// `gh pr view` returns conversation comments and review summaries but not the
			// line-anchored review comments, which are the ones that ask for a change.
			// Those only come from the pulls API.
			let number: number | undefined;
			try {
				number = (JSON.parse(view.stdout) as { number?: number }).number;
			} catch {
				// The formatter reports the parse failure; skip the inline fetch.
			}
			const inline = number === undefined
				? undefined
				: await gh(ctx, 'api', `repos/{owner}/{repo}/pulls/${number}/comments`, '--paginate');
			ctx.appendSystemMessage(formatPullRequestComments(
				view.stdout,
				inline && succeeded(inline) ? inline.stdout : undefined,
			));
		},
	});

	registry.register({
		name: 'init',
		description: localize('cmcmd.init', 'Create or refresh CLAUDE.md for this project.'),
		execute: async (_args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			const existing = await ctx.readTextFile('CLAUDE.md');
			ctx.sendToAgent([
				existing
					? 'Update the existing CLAUDE.md for this repository.'
					: 'Create a CLAUDE.md at the repository root.',
				'Document the build, test, and lint commands, the directory layout, the conventions a',
				'newcomer would otherwise get wrong, and anything load-bearing that is not obvious from',
				'the code. Read the repository first; keep it short and accurate. Write the file when done.',
			].join('\n'));
		},
	});
}

/**
 * Render a pull request's conversation as readable text: description, review
 * summaries, conversation comments, then the line-anchored review comments.
 * `inlineJson` is the raw `pulls/{n}/comments` array when it could be fetched.
 */
function formatPullRequestComments(json: string, inlineJson?: string): string {
	interface GhComment { author?: { login?: string }; body?: string; createdAt?: string }
	interface GhReview extends GhComment { state?: string }
	interface GhPullRequest { number?: number; title?: string; url?: string; body?: string; comments?: GhComment[]; reviews?: GhReview[] }
	let pr: GhPullRequest;
	try {
		pr = JSON.parse(json) as GhPullRequest;
	} catch {
		return 'Could not parse the response from gh.';
	}
	const when = (iso?: string): string => iso ? ` (${new Date(iso).toLocaleString()})` : '';
	const sections: string[] = [`PR #${pr.number ?? '?'} — ${pr.title ?? 'untitled'}${pr.url ? `\n${pr.url}` : ''}`];

	const description = (pr.body ?? '').trim();
	if (description) {
		sections.push(`Description:\n${clip(description, 2000)}`);
	}

	const reviews = (pr.reviews ?? []).filter(r => (r.body ?? '').trim() || (r.state ?? '').toUpperCase() !== 'COMMENTED');
	if (reviews.length) {
		sections.push(`Reviews:\n${reviews.map(r => {
			const state = (r.state ?? '').replace(/_/g, ' ').toLowerCase();
			const body = (r.body ?? '').trim();
			return `— ${r.author?.login ?? 'unknown'}${state ? ` ${state}` : ''}${when(r.createdAt)}${body ? `\n${body}` : ''}`;
		}).join('\n\n')}`);
	}

	const comments = pr.comments ?? [];
	if (comments.length) {
		sections.push(`Comments:\n${comments.map(c =>
			`— ${c.author?.login ?? 'unknown'}${when(c.createdAt)}\n${(c.body ?? '').trim()}`).join('\n\n')}`);
	}

	const inlineText = formatInlineReviewComments(inlineJson);
	if (inlineText) {
		sections.push(inlineText);
	}
	if (sections.length === 1) {
		return `${sections[0]}\n\nNo comments yet.`;
	}
	return clip(sections.join('\n\n'), 12000);
}

/**
 * Render the line-anchored review comments. Each one carries the hunk it was
 * left on, so the last line of that hunk is shown as the code being discussed.
 */
function formatInlineReviewComments(inlineJson: string | undefined): string {
	if (!inlineJson?.trim()) {
		return '';
	}
	interface GhInlineComment {
		user?: { login?: string };
		path?: string;
		line?: number | null;
		original_line?: number | null;
		body?: string;
		created_at?: string;
		diff_hunk?: string;
		in_reply_to_id?: number;
	}
	let parsed: GhInlineComment[];
	try {
		const raw = JSON.parse(inlineJson) as unknown;
		parsed = Array.isArray(raw) ? raw as GhInlineComment[] : [];
	} catch {
		return '';
	}
	if (!parsed.length) {
		return '';
	}
	const rendered = parsed.map(c => {
		const where = `${c.path ?? '?'}${c.line ?? c.original_line ? `:${c.line ?? c.original_line}` : ''}`;
		const stamp = c.created_at ? ` (${new Date(c.created_at).toLocaleString()})` : '';
		const hunkLine = (c.diff_hunk ?? '').split('\n').filter(Boolean).pop();
		return [
			`— ${c.user?.login ?? 'unknown'} on ${where}${stamp}${c.in_reply_to_id ? ' (reply)' : ''}`,
			...(hunkLine ? [`    ${clip(hunkLine.trimEnd(), 160)}`] : []),
			(c.body ?? '').trim(),
		].filter(Boolean).join('\n');
	});
	return `Inline review comments (${parsed.length}):\n${rendered.join('\n\n')}`;
}

// --- session, history and transcript

/**
 * Hand a pull request to the agent for review: metadata and body from `gh pr
 * view`, the change itself from `gh pr diff`. Nothing is posted back to GitHub —
 * the findings land in the panel and the user decides what to do with them.
 */
async function reviewPullRequest(ctx: ICodeMindCommandContext, number: string): Promise<void> {
	const view = await gh(ctx, 'pr', 'view', number, '--json', 'number,title,url,author,baseRefName,headRefName,body,additions,deletions,changedFiles');
	if (ghMissing(view)) {
		ctx.appendSystemMessage(`GitHub CLI (gh) is not on PATH. Install it from ${LINKS.ghCliInstall} to review pull requests.`);
		return;
	}
	if (!succeeded(view)) {
		ctx.appendSystemMessage(`Could not read PR #${number}: ${failureText(view)}`);
		return;
	}
	const diff = await gh(ctx, 'pr', 'diff', number, '--patch');
	if (!succeeded(diff) || !diff.stdout.trim()) {
		ctx.appendSystemMessage(`Could not read the diff for PR #${number}: ${succeeded(diff) ? 'it is empty.' : failureText(diff)}`);
		return;
	}

	let header = `Pull request #${number}`;
	let body = '';
	try {
		const pr = JSON.parse(view.stdout) as {
			title?: string; url?: string; body?: string;
			author?: { login?: string };
			baseRefName?: string; headRefName?: string;
			additions?: number; deletions?: number; changedFiles?: number;
		};
		header = [
			`Pull request #${number}: ${pr.title ?? '(no title)'}`,
			`Author: ${pr.author?.login ?? 'unknown'} · ${pr.headRefName ?? '?'} → ${pr.baseRefName ?? '?'}`,
			`${pr.changedFiles ?? 0} file(s), +${pr.additions ?? 0} −${pr.deletions ?? 0}`,
			pr.url ?? '',
		].filter(Boolean).join('\n');
		body = (pr.body ?? '').trim();
	} catch {
		// A gh version that changed its JSON shape should still get the diff reviewed.
	}

	ctx.appendSystemMessage(`Reviewing pull request #${number}…`);
	ctx.sendToAgent([
		'Review this pull request as a careful senior engineer.',
		'Report correctness bugs first, then missing tests, then style. For each finding give the file,',
		'the line, what breaks, and the concrete fix. Check the description against what the diff',
		'actually does and say so if they disagree. Say plainly if it looks fine. Do not change any files.',
		'',
		header,
		...(body ? ['', 'Description:', clip(body, 4000)] : []),
		'',
		'```diff',
		clip(diff.stdout, 60000),
		'```',
	].join('\n'));
}

function registerSessionCommands(registry: CodeMindCommandRegistry): void {

	registry.register({
		name: 'clear',
		aliases: ['reset', 'new'],
		description: localize('cmcmd.clear', 'Clear the chat view and start a fresh session.'),
		execute: async (_args, ctx) => { ctx.refreshView(); },
	});

	registry.register({
		name: 'resume',
		aliases: ['continue'],
		description: localize('cmcmd.resume', 'Pick a past session for this workspace and continue it. `all` lists every project.'),
		args: '[sessionId | all]',
		execute: async (args, ctx) => { await resumeSession(ctx, args.trim()); },
	});

	registry.register({
		name: 'session',
		aliases: ['remote'],
		description: localize('cmcmd.session', 'Show the current and remembered session ids.'),
		execute: async (_args, ctx) => {
			const current = await ctx.engineService.getSessionId();
			ctx.appendSystemMessage([
				`Current session: ${current ?? 'none yet (send a message to start one)'}`,
				`Remembered for this workspace: ${ctx.storedSessionId() ?? 'none'}`,
			].join('\n'));
		},
	});

	registry.register({
		name: 'compact',
		description: localize('cmcmd.compact', 'Compact the conversation: keep a summary, drop the rest.'),
		args: '[instructions]',
		execute: async (args, ctx) => { await runCompaction(ctx, args.trim()); },
	});

	registry.register({
		name: 'summary',
		description: localize('cmcmd.summary', 'Summarize the conversation without discarding it.'),
		execute: async (_args, ctx) => {
			const transcript = ctx.transcript();
			if (!transcript.length) {
				ctx.appendSystemMessage('Nothing to summarize yet.');
				return;
			}
			const summary = await ctx.silentQuery([
				'Summarize this conversation in under 200 words: what was asked, what was done,',
				'and what is still open.',
				'',
				clip(transcript.map(m => `${m.role}: ${m.content}`).join('\n\n'), 40000),
			].join('\n'));
			ctx.appendSystemMessage(summary.trim() || 'The summary came back empty.');
		},
	});

	registry.register({
		name: 'rewind',
		aliases: ['checkpoint'],
		description: localize('cmcmd.rewind', 'Undo a turn: the conversation, the files the agent changed, or both.'),
		args: '[turns]',
		execute: async (args, ctx) => { await rewindTurns(ctx, args.trim()); },
	});

	registry.register({
		name: 'export',
		description: localize('cmcmd.export', 'Save the conversation as a markdown file.'),
		args: '[filename]',
		execute: async (args, ctx) => { await exportTranscript(ctx, args.trim() || undefined); },
	});

	registry.register({
		name: 'share',
		description: localize('cmcmd.share', 'Save the conversation as markdown so it can be shared.'),
		args: '[filename]',
		execute: async (args, ctx) => { await exportTranscript(ctx, args.trim() || undefined); },
	});

	registry.register({
		name: 'context',
		description: localize('cmcmd.context', 'Show what is currently in the agent context window.'),
		execute: async (_args, ctx) => { await showContextUsage(ctx); },
	});

	registry.register({
		name: 'stats',
		description: localize('cmcmd.stats', 'Show message, token and cost totals for this session.'),
		execute: async (_args, ctx) => {
			const transcript = ctx.transcript();
			const user = transcript.filter(m => m.role === 'user').length;
			const assistant = transcript.filter(m => m.role === 'assistant').length;
			const usage = await ctx.engineService.getSessionUsage();
			ctx.appendSystemMessage([
				`Messages: ${transcript.length} (${user} from you, ${assistant} from the agent)`,
				...(usage
					? [
						`Engine turns: ${usage.turns}`,
						`Tokens: ${formatTokens(usage.inputTokens)} in, ${formatTokens(usage.outputTokens)} out, ${formatTokens(usage.cacheReadInputTokens)} read from cache, ${formatTokens(usage.cacheCreationInputTokens)} written to cache`,
						`Time spent in the engine: ${formatDuration(usage.totalDurationMs)}`,
						`Session cost: ${usage.totalCostUsd != null ? `$${usage.totalCostUsd.toFixed(4)}` : 'not reported'}`,
					]
					: ['No engine turns yet, so there are no token or cost figures to report.']),
			].join('\n'));
		},
	});

	registry.register({
		name: 'cost',
		description: localize('cmcmd.cost', 'Display cumulative token cost and duration for this session.'),
		execute: async (_args, ctx) => {
			const usage = await ctx.engineService.getSessionUsage();
			if (!usage) {
				ctx.appendSystemMessage('No cost accumulated yet for this session.');
				return;
			}
			ctx.appendSystemMessage([
				`Total cost: ${usage.totalCostUsd != null ? `$${usage.totalCostUsd.toFixed(4)}` : 'not reported by the engine (a subscription covers it)'}`,
				`Total duration (engine): ${formatDuration(usage.totalDurationMs)}`,
				`Turns: ${usage.turns}`,
				`Tokens: ${formatTokens(usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens)} in, ${formatTokens(usage.outputTokens)} out`,
			].join('\n'));
		},
	});

	registry.register({
		name: 'usage',
		description: localize('cmcmd.usage', 'Show token usage and spend for this session.'),
		execute: async (_args, ctx) => {
			const usage = await ctx.engineService.getSessionUsage();
			if (!usage) {
				ctx.appendSystemMessage('Nothing has been sent to the engine yet, so there is no usage to report.');
				return;
			}
			const cacheHitRate = usage.cacheReadInputTokens + usage.inputTokens > 0
				? Math.round((usage.cacheReadInputTokens / (usage.cacheReadInputTokens + usage.inputTokens)) * 100)
				: 0;
			ctx.appendSystemMessage([
				`Spend this session: ${usage.totalCostUsd != null ? `$${usage.totalCostUsd.toFixed(4)}` : 'not reported by the engine'}`,
				`Turns: ${usage.turns} over ${formatDuration(usage.totalDurationMs)}`,
				`Input: ${formatTokens(usage.inputTokens)} fresh, ${formatTokens(usage.cacheReadInputTokens)} from cache (${cacheHitRate}% of input served from cache)`,
				`Cache writes: ${formatTokens(usage.cacheCreationInputTokens)}`,
				`Output: ${formatTokens(usage.outputTokens)}`,
				...(usage.lastRequestTokens
					? [`Last request carried ${formatTokens(usage.lastRequestTokens)} tokens of context${usage.lastModel ? ` to ${usage.lastModel}` : ''}.`]
					: []),
				'Run /context for the engine\'s own breakdown of what fills the window.',
			].join('\n'));
		},
	});

	registry.register({
		name: 'brain',
		description: localize('cmcmd.brain', 'Show or change the Project Brain — persistent project memory. Usage: /brain [on|off].'),
		args: '[on|off]',
		execute: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === 'on' || action === 'off') {
				await ctx.engineService.setGlobalDeveloperPrefs({ ppbEnabled: action === 'on' });
			}
			const prefs = await ctx.engineService.getGlobalDeveloperPrefs() as { ppbEnabled?: boolean; maxInjectionTokens?: number } | undefined;
			const stats = await ctx.engineService.getSegmentQueueStats() as { queued?: number; drained?: number; dropped?: number } | undefined;
			const enabled = prefs?.ppbEnabled === true;
			ctx.appendSystemMessage([
				`Project Brain: ${enabled ? 'ON' : 'OFF'}`,
				...(enabled
					? ['The agent can use the project_brain tool (recall / store / list / reason), and relevant memories are injected into each turn automatically.']
					: ['Turn it on with /brain on. It also requires the PPB environment (CODEMIND_PPB_ENABLED=1) and the local databases to be running.']),
				`Injection budget: ${prefs?.maxInjectionTokens ?? 2000} tokens`,
				...(stats ? [`Memory queue: ${stats.queued ?? 0} queued, ${stats.drained ?? 0} processed, ${stats.dropped ?? 0} skipped`] : []),
			].join('\n'));
		},
	});
}

/** Token counts read better rounded once they are into the thousands. */
function formatTokens(tokens: number): string {
	if (tokens < 1000) { return `${tokens}`; }
	if (tokens < 1000000) { return `${(tokens / 1000).toFixed(tokens < 10000 ? 1 : 0)}k`; }
	return `${(tokens / 1000000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) { return `${ms}ms`; }
	const seconds = ms / 1000;
	if (seconds < 60) { return `${seconds.toFixed(1)}s`; }
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/**
 * Show what fills the context window. The engine measures this itself — system
 * prompt, tool schemas, memory files, MCP tools, skills and the message history
 * as the model will actually see them — and none of that is visible from the
 * panel, so ask it and print what it says. The panel's own figures are the
 * fallback for when the engine cannot be reached.
 */
async function showContextUsage(ctx: ICodeMindCommandContext): Promise<void> {
	const [engine, sessionId, usage] = await Promise.all([
		ctx.engineService.runEngineCommand('/context', 60000),
		ctx.engineService.getSessionId(),
		ctx.engineService.getSessionUsage(),
	]);
	const local = [
		`Model: ${ctx.getModel()}`,
		`Permission mode: ${ctx.isPlanMode() ? 'plan (read-only)' : ctx.getPermissionMode()}`,
		`Output style: ${ctx.getOutputStyle()}`,
		`Working directory: ${ctx.workspaceRoot || '(no folder open)'}`,
		`Session: ${sessionId ?? 'not started'}`,
		...describeContextHeadroom(usage?.lastRequestTokens, usage?.lastModel ?? ctx.getModel(), ctx.isAutoCompactEnabled()),
	];
	if (engine.text && !engine.isError) {
		const breakdown = engineBreakdownOrUndefined(engine.text);
		ctx.appendSystemMessage([
			...(breakdown
				? [breakdown, '']
				: ['The engine could not measure what fills the window this time — its token-counting endpoint did not answer, and it has no local estimate to fall back on, so every figure it offered read 0. What follows is the panel\'s own view.', '']),
			...local,
		].join('\n'));
		return;
	}
	// No engine answer: say so, then report what the panel can measure by itself.
	const transcript = ctx.transcript();
	ctx.appendSystemMessage([
		`The engine did not report its context usage${engine.error ? ` (${engine.error})` : ''}, so this is the panel's own view.`,
		'',
		`Messages held in the panel: ${transcript.length} (the last 10 exchanges are sent with each turn)`,
		`Estimated transcript size: ~${estimateTokens(transcript.map(m => m.content).join('\n'))} tokens`,
		...(usage?.lastRequestTokens ? [`Last request carried ${formatTokens(usage.lastRequestTokens)} tokens.`] : []),
		...local,
	].join('\n'));
}

/**
 * Which installed theme `/theme <word>` means.
 *
 * A kind — "dark", "light", "high contrast" — picks a theme of that kind, and the
 * one already in use is skipped so that asking for the kind you are already on
 * still moves (the picker's own behaviour would be to do nothing, which reads as
 * a broken command). Anything else is matched against theme names: the whole name
 * first, then a name that contains what was typed.
 */
function resolveColorTheme(
	themes: readonly ICodeMindColorTheme[],
	wanted: string,
	current: ICodeMindColorTheme | undefined,
): ICodeMindColorTheme | undefined {
	const needle = wanted.toLowerCase().trim();
	const kind = ((): ICodeMindColorTheme['kind'] | undefined => {
		if (needle === 'dark') { return 'dark'; }
		if (needle === 'light') { return 'light'; }
		if (/^(hc|high[ -]?contrast)( dark)?$/.test(needle)) { return 'hc-dark'; }
		if (/^(hc|high[ -]?contrast) light$/.test(needle)) { return 'hc-light'; }
		return undefined;
	})();
	if (kind) {
		const ofKind = themes.filter(t => t.kind === kind);
		return ofKind.find(t => t.id !== current?.id) ?? ofKind[0];
	}
	return themes.find(t => t.label.toLowerCase() === needle)
		?? themes.find(t => t.settingsId.toLowerCase() === needle)
		?? themes.find(t => t.id.toLowerCase() === needle)
		?? themes.find(t => t.label.toLowerCase().includes(needle))
		?? themes.find(t => t.settingsId.toLowerCase().includes(needle));
}

/**
 * The engine's `/context` breakdown, or `undefined` when it came back uncounted.
 *
 * Every figure in that breakdown is counted through the API's token-counting
 * endpoint, and the engine keeps no local estimate to fall back on: an endpoint
 * that does not answer — a gateway that does not implement it, say — leaves the
 * whole table at zero and the header reading `**Tokens:** 0`. Printed verbatim
 * that contradicts the panel's own figures two lines below, which come from what
 * the last request actually carried, so a breakdown of nothing is worth less
 * than saying there is none.
 */
function engineBreakdownOrUndefined(text: string): string | undefined {
	// The line the engine leads with, e.g. `**Tokens:** 103.4k / 200.0k (52%)`.
	// A bare `0` is the only total with no magnitude suffix worth acting on.
	const total = /^\*\*Tokens:\*\*\s*([\d.]+)([kM]?)\s*\//m.exec(text);
	if (total && !total[2] && Number(total[1]) === 0) {
		return undefined;
	}
	return text;
}

/**
 * The headroom line the panel adds to `/context`: the engine's own breakdown says
 * what fills the window, this says how close that is to the point where the
 * conversation gets summarised, which is the panel's decision to make.
 */
function describeContextHeadroom(usedTokens: number | undefined, model: string | undefined, autoCompactEnabled: boolean): string[] {
	if (!usedTokens) {
		return [];
	}
	const status = calculateContextStatus(usedTokens, model, autoCompactEnabled);
	return [
		`Context: ${formatTokens(status.usedTokens)} of ${formatTokens(status.contextWindow)} used (${status.percentUsed}%), `
		+ `${status.percentLeft}% left before ${autoCompactEnabled ? 'auto-compaction' : 'the window is full'}.`,
	];
}

/**
 * Compact the conversation. The engine owns the history it resumes, so real
 * compaction has to happen there: `/compact` makes it summarize, write a compact
 * boundary into the session and continue from the summary. The panel transcript
 * is then replaced to match, so what the user sees and what the engine will send
 * stay the same conversation.
 *
 * Exported because the panel also compacts on its own once the context window is
 * nearly full, and that has to be the same operation the user gets from
 * `/compact` — including the transcript replacement. Resolves true when the
 * conversation was actually compacted.
 */
export async function runCompaction(ctx: ICodeMindCommandContext, instructions: string, automatic = false): Promise<boolean> {
	const transcript = ctx.transcript();
	const sessionId = await ctx.engineService.getSessionId();
	if (!sessionId) {
		ctx.appendSystemMessage('Nothing to compact yet — send a message first.');
		return false;
	}
	ctx.appendSystemMessage(automatic
		? 'Context is nearly full — compacting the conversation so it can continue…'
		: 'Compacting the conversation…');
	// Compaction summarizes with a model call, so it gets a longer leash than the
	// other engine commands.
	const result = await ctx.engineService.runEngineCommand(instructions ? `/compact ${instructions}` : '/compact', 300000);
	if (result.isError || (!result.compacted && !result.text)) {
		ctx.appendSystemMessage(`The engine could not compact the conversation${result.error ? `: ${result.error}` : '.'}`);
		return false;
	}

	// Mirror the engine's summary into the panel so the visible transcript is the
	// one the next turn will actually continue from.
	const summary = result.text.trim();
	if (summary) {
		ctx.replaceTranscript(summary);
	}
	const after = estimateTokens(summary);
	ctx.appendSystemMessage([
		result.compacted
			? `Compacted ${transcript.length} messages in the engine: ${formatTokens(result.compacted.preTokens)} tokens of context → ~${formatTokens(after)}.`
			: `Compacted ${transcript.length} messages in the engine.`,
		'The conversation continues from the summary; earlier turns are still in the session log.',
	].join('\n'));
	return true;
}

/** "3m ago" / "yesterday" — enough to recognise a session in a picker row. */
function formatRelativeTime(at: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 60) { return 'just now'; }
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) { return `${minutes}m ago`; }
	const hours = Math.round(minutes / 60);
	if (hours < 24) { return `${hours}h ago`; }
	const days = Math.round(hours / 24);
	return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * `/resume` — continue an earlier conversation.
 *
 * The engine keeps a transcript log per session, so the panel can offer every
 * session recorded for this workspace rather than only the last one it happened
 * to remember itself. A session id given on the command line is used as-is,
 * which is how the CLI takes one too.
 */
async function resumeSession(ctx: ICodeMindCommandContext, requested: string): Promise<void> {
	// `all` widens the picker to every project the engine has logs for, which is the
	// only way to reach a session started in another workspace.
	const allProjects = /^(all|--all|all-projects)$/i.test(requested);
	let sessionId = allProjects ? '' : requested;
	let fromProject: string | undefined;
	if (!sessionId) {
		const sessions = await ctx.listSessions(allProjects);
		const remembered = ctx.storedSessionId();
		if (!sessions.length) {
			// No readable log: the remembered id is still worth resuming.
			if (!remembered) {
				ctx.appendSystemMessage('No previous session recorded for this workspace yet.');
				return;
			}
			await ctx.engineService.resumeSession(remembered);
			ctx.appendSystemMessage(`Resuming session ${remembered}. The next message continues that conversation.`);
			return;
		}
		const picked = await ctx.pick(allProjects ? 'Resume which session, from any project?' : 'Resume which session?', sessions.map((session, i) => ({
			id: String(i),
			label: session.summary || '(no prompt recorded)',
			description: [
				formatRelativeTime(session.at),
				`${session.messages} entr${session.messages === 1 ? 'y' : 'ies'}`,
				...(session.project ? [session.project] : []),
				...(session.id === remembered ? ['last used here'] : []),
			].join(' · '),
			detail: session.id,
		})));
		if (picked === undefined) {
			return;
		}
		const chosen = sessions[Number.parseInt(picked, 10)];
		sessionId = chosen.id;
		fromProject = chosen.project;
	}
	await ctx.engineService.resumeSession(sessionId);
	ctx.appendSystemMessage([
		`Resuming session ${sessionId}. The next message continues that conversation.`,
		// A session from elsewhere carries that project's files in its history, which
		// is worth knowing before the agent acts on paths that are not here.
		...(fromProject ? [`That session was recorded in ${fromProject}, not this workspace — its history refers to files there.`] : []),
		'The panel starts empty — the engine still has the history, so ask it what you were doing if you need reminding.',
	].join('\n'));
}

/**
 * Undo a turn. The engine checkpoints every file it touches, keyed by the id of
 * the user message that started the turn, so the files can be restored
 * independently of the transcript — the CLI offers the same three choices.
 */
async function rewindTurns(ctx: ICodeMindCommandContext, arg: string): Promise<void> {
	const checkpoints = await ctx.engineService.getCheckpoints();
	const requested = Number.parseInt(arg, 10);
	const turns = Number.isFinite(requested) && requested > 0 ? requested : undefined;

	// Without checkpoints the files cannot be restored, so this is the transcript
	// rewind only — say so instead of pretending the code went back too.
	if (checkpoints.length === 0) {
		const removed = ctx.rewind(turns ?? 1);
		ctx.appendSystemMessage(removed
			? `Rewound ${removed} message${removed === 1 ? '' : 's'}. The engine has no file checkpoints for this session, so nothing on disk was changed.`
			: 'Nothing left to rewind.');
		return;
	}

	// Newest first, which is how they are counted: 1 is the last turn.
	const newestFirst = [...checkpoints].reverse();
	let index = turns !== undefined ? turns - 1 : -1;
	if (index >= newestFirst.length) {
		ctx.appendSystemMessage(`Only ${newestFirst.length} turn${newestFirst.length === 1 ? '' : 's'} can be rewound.`);
		return;
	}
	if (index < 0) {
		const picked = await ctx.pick('Rewind to before which turn?', newestFirst.map((entry, i) => ({
			id: String(i),
			label: `${i + 1}. ${entry.label}`,
			description: new Date(entry.at).toLocaleTimeString(),
		})));
		if (picked === undefined) {
			return;
		}
		index = Number.parseInt(picked, 10);
	}
	const target = newestFirst[index];

	const scope = await ctx.pick(`Rewind ${index + 1} turn${index === 0 ? '' : 's'} — what should go back?`, [
		{ id: 'both', label: 'Conversation and code', description: 'Drop the messages and restore the files' },
		{ id: 'conversation', label: 'Conversation only', description: 'Leave the files as they are' },
		{ id: 'code', label: 'Code only', description: 'Restore the files, keep the messages' },
	]);
	if (!scope) {
		return;
	}

	const lines: string[] = [];
	if (scope === 'code' || scope === 'both') {
		// Preview first: this overwrites the user's files, so the count of what would
		// change is worth seeing before it happens.
		const preview = await ctx.engineService.rewindFiles(target.uuid, true);
		if (!preview.canRewind) {
			ctx.appendSystemMessage(`The files cannot be restored: ${preview.error ?? 'the engine has no checkpoint for that turn.'}`);
			return;
		}
		const changed = preview.filesChanged ?? [];
		const confirmed = await ctx.pick(
			changed.length ? `Restore ${changed.length} file${changed.length === 1 ? '' : 's'}?` : 'Restore files?',
			[
				{ id: 'yes', label: 'Restore files', detail: changed.slice(0, 10).join(', ') || undefined },
				{ id: 'no', label: 'Cancel' },
			]);
		if (confirmed !== 'yes') {
			ctx.appendSystemMessage('Rewind cancelled.');
			return;
		}
		const result = await ctx.engineService.rewindFiles(target.uuid, false);
		if (!result.canRewind) {
			ctx.appendSystemMessage(`The files could not be restored: ${result.error ?? 'unknown error.'}`);
			return;
		}
		const files = result.filesChanged ?? changed;
		lines.push(files.length
			? `Restored ${files.length} file${files.length === 1 ? '' : 's'} to their state before "${target.label}".`
			: 'The files were already at that state.');
		for (const file of files.slice(0, 20)) {
			lines.push(`  ${file}`);
		}
		if (files.length > 20) {
			lines.push(`  … and ${files.length - 20} more`);
		}
	}
	if (scope === 'conversation' || scope === 'both') {
		const removed = ctx.rewind(index + 1);
		lines.push(removed
			? `Dropped ${removed} message${removed === 1 ? '' : 's'} from the conversation.`
			: 'Nothing left to drop from the conversation.');
	}
	ctx.appendSystemMessage(lines.join('\n'));
}

/** Build the markdown transcript, then either write it or ask where to save it. */
async function exportTranscript(ctx: ICodeMindCommandContext, filename?: string): Promise<void> {
	const transcript = ctx.transcript();
	if (!transcript.length) {
		ctx.appendSystemMessage('Nothing to export yet.');
		return;
	}
	const lines = ['# CodeMind Agent conversation', '', `Exported ${new Date().toLocaleString()}`, ''];
	for (const message of transcript) {
		const who = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'CodeMind' : message.role;
		lines.push(`## ${who}`, '', message.content, '');
	}
	const contents = lines.join('\n');

	// A filename was given, so write it rather than opening a dialog — that is what
	// the CLI does, and the argument is otherwise silently thrown away.
	if (filename) {
		const target = /\.[a-z0-9]+$/i.test(filename) ? filename : `${filename}.md`;
		if (!ctx.workspaceRoot && !/^([a-zA-Z]:[\\/]|\/)/.test(target)) {
			ctx.appendSystemMessage('No folder is open, so a relative path has nowhere to go. Pass an absolute path, or use /export with no argument.');
			return;
		}
		if (await ctx.fileExists(target)) {
			const choice = await ctx.pick(`${target} already exists`, [
				{ id: 'overwrite', label: 'Overwrite', description: target },
				{ id: 'cancel', label: 'Cancel' },
			]);
			if (choice !== 'overwrite') {
				ctx.appendSystemMessage('Export cancelled.');
				return;
			}
			const replaced = await ctx.writeTextFile(target, contents, true);
			ctx.appendSystemMessage(replaced ? `Conversation written to ${replaced}.` : `Could not write ${target}.`);
			return;
		}
		const written = await ctx.writeTextFile(target, contents);
		ctx.appendSystemMessage(written ? `Conversation written to ${written}.` : `Could not write ${target}.`);
		return;
	}

	const saved = await ctx.saveTextFile('codemind-conversation.md', contents);
	ctx.appendSystemMessage(saved ? `Conversation saved to ${saved}.` : 'Export cancelled.');
}

// --- configuration, models and modes

function registerConfigCommands(registry: CodeMindCommandRegistry): void {

	registry.register({
		name: 'model',
		description: localize('cmcmd.model', 'Show or switch the model used for new turns.'),
		args: '[name]',
		execute: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				// Ask the engine what it actually offers; the built-in list is only the
				// fallback for when it cannot be reached.
				const offered = await ctx.engineService.getSupportedModels();
				ctx.appendSystemMessage([
					`Current model: ${ctx.getModel() || 'default'}`,
					'',
					'Aliases:',
					...MODEL_ALIASES.map(a => `  ${a.name.padEnd(12)} ${a.detail}`),
					'',
					...(offered.length
						? ['Models the engine reports:', ...offered.map(m => `  ${m.value.padEnd(28)} ${m.displayName}${m.description ? ` — ${m.description}` : ''}`)]
						: ['Models (the engine did not answer, so this is this build\'s list):', ...MODEL_IDS.map(m => `  ${m}`)]),
					'',
					'Switch with /model <name>.',
				].join('\n'));
				return;
			}
			// `default` is the CLI's way of dropping the override rather than a model
			// name, and the engine reads an empty setting the same way.
			if (requested.toLowerCase() === 'default') {
				await ctx.setModel('');
				ctx.appendSystemMessage('Model override cleared — using the account default.');
				return;
			}
			// Anything unrecognised is still forwarded: the engine knows about models
			// released after this build. Say so rather than refusing.
			const known = MODEL_CHOICES.some(m => m.toLowerCase() === requested.toLowerCase());
			await ctx.setModel(requested);
			ctx.appendSystemMessage(known
				? `Model set to ${requested}.`
				: `Model set to ${requested}. That is not one of the names this build knows about — if the engine rejects it, run /model with no argument to see the list.`);
		},
	});

	registry.register({
		name: 'models',
		description: localize('cmcmd.models', 'List the models the configured endpoint serves.'),
		execute: async (_args, ctx) => {
			const endpoint = (ctx.getConfig<string>('codemind.baseUrl') || '').trim() || 'the configured endpoint';
			let offered: readonly ICodeMindModelInfo[] = [];
			let failure: string | undefined;
			try {
				offered = await ctx.engineService.listEndpointModels();
			} catch (err) {
				failure = err instanceof Error ? err.message : String(err);
				// The endpoint has no `/v1/models` (or refused it). The engine's own list
				// is the next best answer — with the official API it is the better one.
				try {
					offered = await ctx.engineService.getSupportedModels();
				} catch {
					offered = [];
				}
			}
			if (!offered.length) {
				ctx.appendSystemMessage([
					`Could not list models from ${endpoint}.`,
					...(failure ? [`  ${failure}`] : []),
					'',
					'Models this build knows about:',
					...MODEL_IDS.map(m => `  ${m}`),
				].join('\n'));
				return;
			}
			ctx.appendSystemMessage([
				`${offered.length} model${offered.length === 1 ? '' : 's'} available:`,
				...offered.map(m => `  ${m.value.padEnd(32)} ${m.displayName}${m.description ? ` — ${m.description}` : ''}`),
				...(failure ? ['', `(${endpoint} has no model list: ${failure})`] : []),
				'',
				`Current model: ${ctx.getModel() || 'default'} — switch with /model <name>.`,
			].join('\n'));
		},
	});

	registry.register({
		name: 'endpoint',
		description: localize('cmcmd.endpoint', 'Show or set the Anthropic-compatible endpoint turns are sent to.'),
		args: '[url | clear]',
		execute: async (args, ctx) => {
			const requested = args.trim();
			const current = (ctx.getConfig<string>('codemind.baseUrl') || '').trim();
			if (!requested) {
				ctx.appendSystemMessage([
					current
						? `Endpoint: ${current}`
						: 'Endpoint: not set — using ANTHROPIC_BASE_URL if the app was launched with one, else https://api.anthropic.com.',
					'',
					'Set one with /endpoint <url> (no /v1 suffix), or /endpoint clear to go back to the default.',
					'The API key belongs to the endpoint: set it in Settings after changing this.',
				].join('\n'));
				return;
			}
			if (requested.toLowerCase() === 'clear' || requested.toLowerCase() === 'default') {
				await ctx.setConfig('codemind.baseUrl', '');
				ctx.appendSystemMessage('Endpoint cleared — using the default.');
				return;
			}
			let url: URL;
			try {
				url = new URL(requested);
			} catch {
				ctx.appendSystemMessage(`Not a URL: ${requested}. Give a full origin, e.g. https://my-gateway.example.com.`);
				return;
			}
			if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
				ctx.appendSystemMessage('Refusing a plaintext endpoint: the API key travels on every request. Use https, or localhost for a local proxy.');
				return;
			}
			const normalised = requested.replace(/\/+$/, '');
			await ctx.setConfig('codemind.baseUrl', normalised);
			ctx.appendSystemMessage(`Endpoint set to ${normalised}. Run /models to see what it serves.`);
		},
	});

	registry.register({
		name: 'permissions',
		aliases: ['allowed-tools'],
		description: localize('cmcmd.permissions', 'Show or change the permission mode and the tool allow/ask/deny rules.'),
		args: '[mode | cycle | list | allow|ask|deny <rule> | remove [rule]]',
		execute: async (args, ctx) => { await managePermissions(ctx, args.trim()); },
	});

	registry.register({
		name: 'plan',
		description: localize('cmcmd.plan', 'Turn on plan mode: the agent researches but changes nothing.'),
		args: '[what to plan]',
		execute: async (args, ctx) => {
			// Through `applyPermissionMode` so the saved mode agrees with the badge —
			// otherwise /permissions would report the old mode while planning.
			await applyPermissionMode(ctx, 'plan');
			ctx.appendSystemMessage('Plan mode on — no edits, no commands. Use /exit-plan to leave it.');
			const task = args.trim();
			if (task) {
				// The CLI treats the argument as the thing to plan, so start on it rather
				// than making the user retype it after the mode switch.
				ctx.sendToAgent(task);
			}
		},
	});

	registry.register({
		name: 'exit-plan',
		description: localize('cmcmd.exitPlan', 'Leave plan mode and allow edits again.'),
		execute: async (_args, ctx) => {
			// Leaving plan mode must also move the saved mode off `plan`, or the next
			// turn would read a mode the panel is no longer in.
			if (ctx.getPermissionMode() === 'plan') {
				await applyPermissionMode(ctx, 'default');
			} else {
				ctx.setPlanMode(false);
			}
			ctx.appendSystemMessage('Plan mode off — the agent can edit files and run commands again.');
		},
	});

	registry.register({
		name: 'vim',
		description: localize('cmcmd.vim', 'Toggle vim keybindings in the chat input.'),
		execute: async (_args, ctx) => {
			await ctx.toggleVim();
			ctx.appendSystemMessage(ctx.isVimMode()
				? 'Vim mode on — the input starts in normal mode. Press i to insert, Esc to leave it.'
				: 'Vim mode off.');
		},
	});

	registry.register({
		name: 'output-style',
		description: localize('cmcmd.outputStyle', 'Show or change how the agent writes its answers.'),
		args: '[style]',
		execute: async (args, ctx) => {
			const requested = args.trim();
			// Styles on disk are listed alongside the built-ins and accepted by name,
			// which is what makes `.claude/output-styles/<name>.md` worth writing.
			const custom = await ctx.listOutputStyles();
			if (!requested) {
				const lines = [
					`Current style: ${ctx.getOutputStyle()}`,
					'',
					'  default      concise engineering answers',
					'  explanatory  adds the reasoning behind each step',
					'  concise      shortest correct answer, minimal prose',
					'  learning     teaches as it works, with small exercises',
				];
				if (custom.length) {
					lines.push('');
					for (const style of custom) {
						lines.push(`  ${style.name.padEnd(12)} ${style.description} (${style.source.toLowerCase()})`);
					}
				}
				lines.push('', 'Change with /output-style <style>.');
				if (!custom.length) {
					lines.push('Add your own by writing .claude/output-styles/<name>.md — the file body is the prompt.');
				}
				ctx.appendSystemMessage(lines.join('\n'));
				return;
			}
			const known = [...OUTPUT_STYLES, ...custom.map(style => style.name)];
			// Case-insensitive so a style file named `Explanatory.md` answers to either.
			const match = known.find(name => name.toLowerCase() === requested.toLowerCase());
			if (!match) {
				ctx.appendSystemMessage(`Unknown style "${requested}". Choose one of: ${known.join(', ')}.`);
				return;
			}
			await ctx.setOutputStyle(match);
			ctx.appendSystemMessage(`Output style set to ${match}.`);
		},
	});

	registry.register({
		name: 'coordinator',
		description: localize('cmcmd.coordinator', 'Orchestrate workers instead of doing the work directly.'),
		args: '[on|off]',
		execute: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const enabled = arg === 'on' || arg === 'enable' ? true
				: arg === 'off' || arg === 'disable' ? false
					: !ctx.isCoordinatorMode();
			await ctx.setCoordinatorMode(enabled);
			ctx.appendSystemMessage(enabled
				? [
					'Coordinator mode on. The agent now delegates: it spawns workers with the Agent tool,',
					'continues them with SendMessage, stops them with TaskStop, and synthesizes what they',
					'report rather than editing files itself. Turn it off with /coordinator off.',
				].join('\n')
				: 'Coordinator mode off. The agent does the work itself again.');
		},
	});

	registry.register({
		name: 'login',
		description: localize('cmcmd.login', 'Open the API key entry dialog.'),
		execute: async (_args, ctx) => { ctx.openPanel('apiKey'); },
	});

	registry.register({
		name: 'logout',
		description: localize('cmcmd.logout', 'Clear the stored Anthropic API key.'),
		execute: async (_args, ctx) => {
			await ctx.engineService.deleteApiKey();
			ctx.appendSystemMessage('API key cleared.');
		},
	});

	registry.register({
		name: 'status',
		description: localize('cmcmd.status', 'Show account, engine, key, model and MCP status.'),
		execute: async (_args, ctx) => {
			const [apiKey, sessionId, servers, account] = await Promise.all([
				ctx.engineService.getApiKey(),
				ctx.engineService.getSessionId(),
				ctx.engineService.getMcpServers(),
				// Answered from the engine's init handshake, so it costs no tokens.
				ctx.engineService.getAccountInfo(),
			]);
			const connected = servers.filter(s => s.status === 'connected').length;
			const accountLines = account
				? [
					`Account: ${account.email ?? 'unknown'}`,
					...(account.organization ? [`Organization: ${account.organization}`] : []),
					...(account.subscriptionType ? [`Plan: ${account.subscriptionType}`] : []),
					...(account.apiKeySource || account.tokenSource ? [`Credential: ${account.apiKeySource ?? account.tokenSource}`] : []),
				]
				: ['Account: the engine did not report one (offline, or authenticated by key only)'];
			ctx.appendSystemMessage([
				...accountLines,
				`API key: ${apiKey ? 'set' : 'not set — run /login'}`,
				`Model: ${ctx.getModel()}`,
				`Permission mode: ${ctx.isPlanMode() ? 'plan (read-only)' : ctx.getPermissionMode()}`,
				`Output style: ${ctx.getOutputStyle()}`,
				`Session: ${sessionId ?? 'not started'}`,
				`MCP servers: ${servers.length} configured, ${connected} connected`,
				`Workspace: ${ctx.workspaceRoot || '(no folder open)'}`,
			].join('\n'));
		},
	});

	registry.register({
		name: 'doctor',
		description: localize('cmcmd.doctor', 'Run environment diagnostics.'),
		execute: async (_args, ctx) => {
			const checks = await ctx.engineService.doctor();
			const lines = checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
			const failing = checks.filter(c => !c.ok).length;
			lines.push('', failing ? `${failing} check${failing === 1 ? '' : 's'} need attention.` : 'Everything checks out.');
			ctx.appendSystemMessage(lines.join('\n'));
		},
	});

	registry.register({
		name: 'hooks',
		description: localize('cmcmd.hooks', 'Show, add or remove the shell hooks the engine runs around tool use.'),
		args: '[list|add|remove]',
		execute: async (args, ctx) => { await manageHooks(ctx, args.trim()); },
	});

	registry.register({
		name: 'agents',
		description: localize('cmcmd.agents', 'List, show or create the subagents the agent can delegate to.'),
		args: '[list|show <name>|create]',
		execute: async (args, ctx) => { await manageAgents(ctx, args.trim()); },
	});

	registry.register({
		name: 'add-dir',
		description: localize('cmcmd.addDir', 'Add another folder to the workspace the agent can reach.'),
		args: '[path]',
		// A typed path is added straight away; with no argument the native folder
		// picker opens, which is the only way to browse from the panel.
		execute: async (args, ctx) => { await ctx.addDirectory(args.trim() || undefined); },
	});

}

// --- engine settings files (~/.claude/settings.json and .claude/settings*.json)

/** The three settings files the engine merges, least specific first. */
const SETTINGS_SCOPES = ['user', 'project', 'local'] as const;
type SettingsScope = typeof SETTINGS_SCOPES[number];

/** Where each scope lives — `user` is relative to `~/.claude`, the rest to the workspace. */
const SETTINGS_PATHS: Record<SettingsScope, string> = {
	user: 'settings.json',
	project: '.claude/settings.json',
	local: '.claude/settings.local.json',
};

const SETTINGS_LABELS: Record<SettingsScope, string> = {
	user: '~/.claude/settings.json (all projects)',
	project: '.claude/settings.json (this project, shared)',
	local: '.claude/settings.local.json (this project, not committed)',
};

/** A settings file, parsed. `invalid` distinguishes broken JSON from a missing file. */
interface ISettingsFile {
	readonly scope: SettingsScope;
	readonly value: Record<string, unknown>;
	readonly exists: boolean;
	readonly invalid: boolean;
}

async function readSettingsFile(ctx: ICodeMindCommandContext, scope: SettingsScope): Promise<ISettingsFile> {
	const raw = scope === 'user'
		? await ctx.readHomeFile(SETTINGS_PATHS.user)
		: await ctx.readTextFile(SETTINGS_PATHS[scope]);
	if (raw === undefined) {
		return { scope, value: {}, exists: false, invalid: false };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { scope, value: {}, exists: true, invalid: true };
		}
		return { scope, value: parsed as Record<string, unknown>, exists: true, invalid: false };
	} catch {
		return { scope, value: {}, exists: true, invalid: true };
	}
}

/** Write a settings file back, formatted the way the engine writes it. */
async function writeSettingsFile(ctx: ICodeMindCommandContext, scope: SettingsScope, value: Record<string, unknown>): Promise<string | undefined> {
	const contents = `${JSON.stringify(value, undefined, 2)}\n`;
	return scope === 'user'
		? ctx.writeHomeFile(SETTINGS_PATHS.user, contents)
		: ctx.writeTextFile(SETTINGS_PATHS[scope], contents, true);
}

/** Which scopes can be written right now — the project ones need a folder open. */
function writableScopes(ctx: ICodeMindCommandContext): SettingsScope[] {
	return ctx.workspaceRoot ? [...SETTINGS_SCOPES] : ['user'];
}

/** Ask which settings file to edit, skipping the pick when there is only one. */
async function pickSettingsScope(ctx: ICodeMindCommandContext, placeHolder: string): Promise<SettingsScope | undefined> {
	const scopes = writableScopes(ctx);
	if (scopes.length === 1) {
		return scopes[0];
	}
	const picked = await ctx.pick(placeHolder, scopes.map(scope => ({ id: scope, label: scope, description: SETTINGS_LABELS[scope] })));
	return picked as SettingsScope | undefined;
}

/** The `permissions` object of a settings file, or an empty one. */
function permissionsSection(file: ISettingsFile): Record<string, unknown> {
	const section = file.value['permissions'];
	return section && typeof section === 'object' && !Array.isArray(section) ? section as Record<string, unknown> : {};
}

/** One rule list out of a `permissions` object, as strings. */
function ruleList(section: Record<string, unknown>, list: string): string[] {
	const value = section[list];
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

// --- /permissions

/** The three rule lists the engine understands, in the order it applies them. */
const PERMISSION_RULE_LISTS = ['deny', 'ask', 'allow'] as const;
type PermissionRuleList = typeof PERMISSION_RULE_LISTS[number];

/**
 * `/permissions` — the mode plus the saved rules.
 *
 * The mode is a session setting the panel owns, but the rules live in the same
 * settings files the engine reads, so editing them here is editing the engine's
 * real configuration: they apply from the next turn on, including to sessions
 * started outside the panel.
 */
async function managePermissions(ctx: ICodeMindCommandContext, args: string): Promise<void> {
	const [verb, ...rest] = args.split(/\s+/).filter(Boolean);
	const sub = (verb ?? '').toLowerCase();
	const rule = rest.join(' ').trim();

	if (!sub || sub === 'list' || sub === 'show') {
		await showPermissions(ctx);
		return;
	}
	// Shift+Tab in the composer arrives here, which is what keeps the shortcut and
	// the slash command from ever disagreeing about the order.
	if (sub === 'cycle' || sub === 'next') {
		const current = ctx.isPlanMode() ? 'plan' : ctx.getPermissionMode();
		const at = PERMISSION_MODE_CYCLE.indexOf(current);
		const next = PERMISSION_MODE_CYCLE[(at + 1) % PERMISSION_MODE_CYCLE.length];
		await applyPermissionMode(ctx, next);
		ctx.appendSystemMessage(`${PERMISSION_MODE_LABELS[next]} Shift+Tab cycles.`);
		return;
	}
	if (sub === 'mode' || resolvePermissionMode(sub)) {
		// `sub` is lowercased for dispatch, so the mode it names has to be looked up rather
		// than used as-is: `acceptEdits` typed by hand would otherwise miss the list.
		const mode = sub === 'mode' ? resolvePermissionMode(rest[0] ?? '') : resolvePermissionMode(sub);
		if (!mode) {
			ctx.appendSystemMessage(`Unknown mode "${(sub === 'mode' ? rest[0] : sub) || '(none)'}". Choose one of: ${PERMISSION_MODES.join(', ')}.`);
			return;
		}
		await applyPermissionMode(ctx, mode);
		ctx.appendSystemMessage(PERMISSION_MODE_LABELS[mode] ?? `Permission mode set to ${mode}.`);
		return;
	}
	if ((PERMISSION_RULE_LISTS as readonly string[]).includes(sub)) {
		await addPermissionRule(ctx, sub as PermissionRuleList, rule);
		return;
	}
	if (sub === 'remove' || sub === 'delete') {
		await removePermissionRule(ctx, rule);
		return;
	}
	ctx.appendSystemMessage([
		`Unknown option "${sub}".`,
		'',
		'  /permissions                     show the mode and every saved rule',
		'  /permissions <mode>              default | acceptEdits | bypassPermissions | plan',
		'  /permissions cycle               step to the next mode (Shift+Tab does this)',
		'  /permissions allow <rule>        never ask for this again',
		'  /permissions ask <rule>          always ask, even in acceptEdits',
		'  /permissions deny <rule>         refuse it outright',
		'  /permissions remove [rule]       drop a saved rule',
		'',
		'A rule is a tool name with an optional argument pattern, e.g. Bash(git diff:*), Edit, Read(~/.ssh/**).',
	].join('\n'));
}

/**
 * Switch mode. Plan mode is recorded in two places — the pane's own flag, which
 * shapes the system prompt and paints the badge, and the `codemind.permissionMode`
 * setting the engine reads — so both always move together.
 */
async function applyPermissionMode(ctx: ICodeMindCommandContext, mode: string): Promise<void> {
	ctx.setPlanMode(mode === 'plan');
	await ctx.setPermissionMode(mode);
}

/** Print the session mode, the saved default, and the rules from all three files. */
async function showPermissions(ctx: ICodeMindCommandContext): Promise<void> {
	const files = await Promise.all(SETTINGS_SCOPES.map(scope => readSettingsFile(ctx, scope)));
	const lines: string[] = [
		`Current mode: ${ctx.isPlanMode() ? 'plan (read-only)' : ctx.getPermissionMode()}`,
		'',
		'  default            ask before edits and commands',
		'  acceptEdits        auto-approve file edits, still ask for commands',
		'  bypassPermissions  never ask — only in disposable workspaces',
		'  plan               read-only: research and plan, change nothing',
	];
	let anyRules = false;
	for (const file of files) {
		if (file.invalid) {
			lines.push('', `${SETTINGS_LABELS[file.scope]}: not valid JSON, so the engine ignores it.`);
			continue;
		}
		const section = permissionsSection(file);
		const rules = PERMISSION_RULE_LISTS.map(list => [list, ruleList(section, list)] as const).filter(([, entries]) => entries.length);
		const defaultMode = typeof section['defaultMode'] === 'string' ? section['defaultMode'] : undefined;
		const dirs = ruleList(section, 'additionalDirectories');
		if (!rules.length && !defaultMode && !dirs.length) {
			continue;
		}
		anyRules = true;
		lines.push('', `${SETTINGS_LABELS[file.scope]}:`);
		if (defaultMode) {
			lines.push(`  default mode: ${defaultMode}`);
		}
		for (const [list, entries] of rules) {
			lines.push(`  ${list}:`);
			lines.push(...entries.map(entry => `    ${entry}`));
		}
		if (dirs.length) {
			lines.push('  extra directories:', ...dirs.map(dir => `    ${dir}`));
		}
	}
	if (!anyRules) {
		lines.push('', 'No saved rules yet. Add one with /permissions allow <rule>.');
	} else {
		lines.push('', 'deny wins over ask, and ask wins over allow. Changes apply from the next turn.');
	}
	ctx.appendSystemMessage(lines.join('\n'));
}

/**
 * Add a rule to one of the lists. A rule that already sits in a different list of
 * the same file is moved rather than duplicated — leaving it in both would make
 * the stricter list silently win and the new rule look broken.
 */
async function addPermissionRule(ctx: ICodeMindCommandContext, list: PermissionRuleList, requested: string): Promise<void> {
	const rule = requested || (await ctx.promptText(`Rule to ${list} — a tool name with an optional pattern, e.g. Bash(git diff:*)`) ?? '').trim();
	if (!rule) {
		return;
	}
	const scope = await pickSettingsScope(ctx, `Save "${rule}" to which settings file?`);
	if (!scope) {
		return;
	}
	const file = await readSettingsFile(ctx, scope);
	if (file.invalid) {
		ctx.appendSystemMessage(`${SETTINGS_LABELS[scope]} is not valid JSON — fix it before adding rules, or the change would be lost.`);
		return;
	}
	const section = { ...permissionsSection(file) };
	const moved: string[] = [];
	for (const other of PERMISSION_RULE_LISTS) {
		const entries = ruleList(section, other);
		if (other !== list && entries.includes(rule)) {
			section[other] = entries.filter(entry => entry !== rule);
			moved.push(other);
		}
	}
	const target = ruleList(section, list);
	if (target.includes(rule) && !moved.length) {
		ctx.appendSystemMessage(`"${rule}" is already in the ${list} list of ${SETTINGS_LABELS[scope]}.`);
		return;
	}
	section[list] = target.includes(rule) ? target : [...target, rule];
	const written = await writeSettingsFile(ctx, scope, { ...file.value, permissions: section });
	ctx.appendSystemMessage(written
		? `${moved.length ? `Moved "${rule}" from ${moved.join(' and ')} to ${list}` : `Added "${rule}" to ${list}`} in ${written}. It applies from the next turn.`
		: `Could not write ${SETTINGS_LABELS[scope]}.`);
}

/** Remove a saved rule, offering the rules from every scope when none was named. */
async function removePermissionRule(ctx: ICodeMindCommandContext, requested: string): Promise<void> {
	const scopes = writableScopes(ctx);
	const files = await Promise.all(scopes.map(scope => readSettingsFile(ctx, scope)));
	const candidates: { scope: SettingsScope; list: PermissionRuleList; rule: string }[] = [];
	for (const file of files) {
		if (file.invalid) {
			continue;
		}
		const section = permissionsSection(file);
		for (const list of PERMISSION_RULE_LISTS) {
			for (const rule of ruleList(section, list)) {
				candidates.push({ scope: file.scope, list, rule });
			}
		}
	}
	if (!candidates.length) {
		ctx.appendSystemMessage('There are no saved permission rules to remove.');
		return;
	}
	let matches = requested ? candidates.filter(entry => entry.rule === requested) : candidates;
	if (requested && !matches.length) {
		ctx.appendSystemMessage(`No saved rule matches "${requested}". Run /permissions to see them.`);
		return;
	}
	// One rule can be saved in more than one file, so still ask which one to drop.
	if (matches.length > 1) {
		const picked = await ctx.pick('Remove which rule?', matches.map((entry, i) => ({
			id: String(i),
			label: `${entry.list}: ${entry.rule}`,
			description: SETTINGS_LABELS[entry.scope],
		})));
		if (picked === undefined) {
			return;
		}
		matches = [matches[Number.parseInt(picked, 10)]];
	}
	const { scope, list, rule } = matches[0];
	const file = files.find(entry => entry.scope === scope)!;
	const section = { ...permissionsSection(file) };
	section[list] = ruleList(section, list).filter(entry => entry !== rule);
	const written = await writeSettingsFile(ctx, scope, { ...file.value, permissions: section });
	ctx.appendSystemMessage(written
		? `Removed "${rule}" from the ${list} list in ${written}.`
		: `Could not write ${SETTINGS_LABELS[scope]}.`);
}

// --- /hooks

/** The events the engine fires hooks on, with what each one is for. */
const HOOK_EVENTS: readonly { readonly name: string; readonly detail: string; readonly matcher?: string }[] = [
	{ name: 'PreToolUse', detail: 'before a tool runs — can block it', matcher: 'tool name, e.g. Bash or Edit|Write ( * for all )' },
	{ name: 'PostToolUse', detail: 'after a tool has run', matcher: 'tool name, e.g. Bash or Edit|Write ( * for all )' },
	{ name: 'UserPromptSubmit', detail: 'when you send a prompt' },
	{ name: 'Notification', detail: 'when the agent notifies you' },
	{ name: 'Stop', detail: 'when the agent finishes answering' },
	{ name: 'SubagentStop', detail: 'when a subagent finishes' },
	{ name: 'SessionStart', detail: 'when a session starts or resumes', matcher: 'startup, resume or clear' },
	{ name: 'SessionEnd', detail: 'when a session ends' },
	{ name: 'PreCompact', detail: 'before the conversation is compacted', matcher: 'manual or auto' },
];

/** One command hook, with where it is saved and how to find it again. */
interface IHookEntry {
	readonly scope: SettingsScope;
	readonly event: string;
	readonly matcher: string;
	readonly command: string;
	readonly groupIndex: number;
	readonly hookIndex: number;
}

/**
 * `/hooks` — the shell commands the engine runs around tool use.
 *
 * These are the engine's own hooks, read from the same settings files it reads,
 * so what is listed here is what will actually run. Adding one writes the
 * `hooks` section of the chosen file.
 */
async function manageHooks(ctx: ICodeMindCommandContext, args: string): Promise<void> {
	const sub = args.split(/\s+/)[0]?.toLowerCase() ?? '';
	if (sub === 'add' || sub === 'new') {
		await addHook(ctx);
		return;
	}
	if (sub === 'remove' || sub === 'delete') {
		await removeHook(ctx);
		return;
	}
	if (sub && sub !== 'list' && sub !== 'show') {
		ctx.appendSystemMessage(`Unknown option "${sub}". Use /hooks, /hooks add or /hooks remove.`);
		return;
	}
	const entries = await readHooks(ctx, writableScopes(ctx));
	if (!entries.length) {
		ctx.appendSystemMessage([
			'No hooks configured.',
			'',
			'A hook is a shell command the engine runs at a fixed point — before a tool call, after a prompt, when a session ends. Add one with /hooks add.',
		].join('\n'));
		return;
	}
	const lines: string[] = [];
	for (const scope of SETTINGS_SCOPES) {
		const forScope = entries.filter(entry => entry.scope === scope);
		if (!forScope.length) {
			continue;
		}
		lines.push(lines.length ? '' : '', `${SETTINGS_LABELS[scope]}:`);
		for (const event of new Set(forScope.map(entry => entry.event))) {
			lines.push(`  ${event}:`);
			for (const entry of forScope.filter(e => e.event === event)) {
				lines.push(`    ${entry.matcher ? `[${entry.matcher}] ` : ''}${clip(entry.command, 200)}`);
			}
		}
	}
	lines.push('', 'Hooks run with the workspace as their working directory. Changes apply from the next turn.');
	ctx.appendSystemMessage(lines.join('\n').trim());
}

/** Flatten the `hooks` section of each scope into one list of command hooks. */
async function readHooks(ctx: ICodeMindCommandContext, scopes: readonly SettingsScope[]): Promise<IHookEntry[]> {
	const files = await Promise.all(scopes.map(scope => readSettingsFile(ctx, scope)));
	const entries: IHookEntry[] = [];
	for (const file of files) {
		const section = file.value['hooks'];
		if (!section || typeof section !== 'object' || Array.isArray(section)) {
			continue;
		}
		for (const [event, groups] of Object.entries(section as Record<string, unknown>)) {
			if (!Array.isArray(groups)) {
				continue;
			}
			groups.forEach((group, groupIndex) => {
				if (!group || typeof group !== 'object') {
					return;
				}
				const { matcher, hooks } = group as { matcher?: unknown; hooks?: unknown };
				if (!Array.isArray(hooks)) {
					return;
				}
				hooks.forEach((hook, hookIndex) => {
					const command = (hook as { command?: unknown } | undefined)?.command;
					if (typeof command === 'string') {
						entries.push({
							scope: file.scope, event,
							matcher: typeof matcher === 'string' ? matcher : '',
							command, groupIndex, hookIndex,
						});
					}
				});
			});
		}
	}
	return entries;
}

/** Ask for an event, a matcher and a command, then write the hook. */
async function addHook(ctx: ICodeMindCommandContext): Promise<void> {
	const event = await ctx.pick('Run the hook when?', HOOK_EVENTS.map(entry => ({ id: entry.name, label: entry.name, description: entry.detail })));
	if (!event) {
		return;
	}
	const spec = HOOK_EVENTS.find(entry => entry.name === event);
	const matcher = spec?.matcher
		? (await ctx.promptText(`Which ${spec.matcher}? Leave empty for every one.`) ?? undefined)
		: undefined;
	if (matcher === undefined && spec?.matcher) {
		return; // dismissed rather than left empty
	}
	const command = (await ctx.promptText('Shell command to run') ?? '').trim();
	if (!command) {
		return;
	}
	const scope = await pickSettingsScope(ctx, 'Save the hook to which settings file?');
	if (!scope) {
		return;
	}
	const file = await readSettingsFile(ctx, scope);
	if (file.invalid) {
		ctx.appendSystemMessage(`${SETTINGS_LABELS[scope]} is not valid JSON — fix it before adding hooks, or the change would be lost.`);
		return;
	}
	const section: Record<string, unknown> = { ...(file.value['hooks'] as Record<string, unknown> | undefined ?? {}) };
	const groups = Array.isArray(section[event]) ? [...(section[event] as unknown[])] : [];
	// Reuse the group for this matcher when there is one, so the file stays the
	// shape the engine writes rather than growing a group per hook.
	const existing = groups.findIndex(group => {
		const value = (group as { matcher?: unknown } | undefined)?.matcher;
		return (typeof value === 'string' ? value : '') === (matcher ?? '');
	});
	const hook = { type: 'command', command };
	if (existing >= 0) {
		const group = groups[existing] as { matcher?: string; hooks?: unknown[] };
		groups[existing] = { ...group, hooks: [...(Array.isArray(group.hooks) ? group.hooks : []), hook] };
	} else {
		groups.push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] });
	}
	section[event] = groups;
	const written = await writeSettingsFile(ctx, scope, { ...file.value, hooks: section });
	ctx.appendSystemMessage(written
		? `Added a ${event} hook${matcher ? ` for ${matcher}` : ''} to ${written}. It runs from the next turn.`
		: `Could not write ${SETTINGS_LABELS[scope]}.`);
}

/** Pick a configured hook and delete it, pruning the group it leaves empty. */
async function removeHook(ctx: ICodeMindCommandContext): Promise<void> {
	const entries = await readHooks(ctx, writableScopes(ctx));
	if (!entries.length) {
		ctx.appendSystemMessage('There are no hooks to remove.');
		return;
	}
	const picked = await ctx.pick('Remove which hook?', entries.map((entry, i) => ({
		id: String(i),
		label: `${entry.event}${entry.matcher ? ` [${entry.matcher}]` : ''}`,
		description: clip(entry.command, 120),
		detail: SETTINGS_LABELS[entry.scope],
	})));
	if (picked === undefined) {
		return;
	}
	const target = entries[Number.parseInt(picked, 10)];
	const file = await readSettingsFile(ctx, target.scope);
	const section: Record<string, unknown> = { ...(file.value['hooks'] as Record<string, unknown> | undefined ?? {}) };
	const groups = Array.isArray(section[target.event]) ? [...(section[target.event] as unknown[])] : [];
	const group = groups[target.groupIndex] as { matcher?: string; hooks?: unknown[] } | undefined;
	if (!group || !Array.isArray(group.hooks)) {
		ctx.appendSystemMessage('That hook is no longer there — the settings file changed underneath.');
		return;
	}
	const hooks = group.hooks.filter((_, i) => i !== target.hookIndex);
	if (hooks.length) {
		groups[target.groupIndex] = { ...group, hooks };
	} else {
		groups.splice(target.groupIndex, 1);
	}
	if (groups.length) {
		section[target.event] = groups;
	} else {
		delete section[target.event];
	}
	const next = { ...file.value, hooks: section };
	if (!Object.keys(section).length) {
		delete (next as { hooks?: unknown }).hooks;
	}
	const written = await writeSettingsFile(ctx, target.scope, next);
	ctx.appendSystemMessage(written
		? `Removed the ${target.event} hook from ${written}.`
		: `Could not write ${SETTINGS_LABELS[target.scope]}.`);
}

// --- /agents

/** A subagent definition file, from either the project or the user directory. */
interface IAgentDefinition {
	readonly name: string;
	readonly scope: 'project' | 'user';
	readonly path: string;
	readonly description: string;
	readonly tools?: string;
	readonly model?: string;
}

/**
 * `/agents` — the subagents the agent can delegate to.
 *
 * The engine loads these from `.claude/agents` and `~/.claude/agents`; the CLI
 * lists both, so listing only the project ones would hide half of them.
 */
async function manageAgents(ctx: ICodeMindCommandContext, args: string): Promise<void> {
	const [verb, ...rest] = args.split(/\s+/).filter(Boolean);
	const sub = (verb ?? '').toLowerCase();
	if (sub === 'create' || sub === 'new') {
		await createAgent(ctx);
		return;
	}
	const agents = await readAgentDefinitions(ctx);
	if (sub === 'show' || sub === 'view') {
		await showAgent(ctx, agents, rest.join(' ').trim());
		return;
	}
	if (sub && sub !== 'list') {
		ctx.appendSystemMessage(`Unknown option "${sub}". Use /agents, /agents show <name> or /agents create.`);
		return;
	}
	if (!agents.length) {
		ctx.appendSystemMessage([
			'No subagents defined.',
			'',
			'A subagent is a separate context with its own instructions and tool set that the agent can hand a task to. Create one with /agents create.',
		].join('\n'));
		return;
	}
	const lines: string[] = [];
	for (const scope of ['project', 'user'] as const) {
		const forScope = agents.filter(agent => agent.scope === scope);
		if (!forScope.length) {
			continue;
		}
		lines.push(lines.length ? '' : '', scope === 'project' ? '.claude/agents (this project):' : '~/.claude/agents (all projects):');
		for (const agent of forScope) {
			lines.push(`  ${agent.name}${agent.model ? ` (${agent.model})` : ''}`);
			if (agent.description) {
				lines.push(`    ${clip(agent.description, 200)}`);
			}
			if (agent.tools) {
				lines.push(`    tools: ${agent.tools}`);
			}
		}
	}
	lines.push('', 'Ask the agent to use one by name, or run /agents show <name> to read its instructions.');
	ctx.appendSystemMessage(lines.join('\n').trim());
}

/** Read both agent directories, project first — the scope the engine prefers. */
async function readAgentDefinitions(ctx: ICodeMindCommandContext): Promise<IAgentDefinition[]> {
	const [projectNames, userNames] = await Promise.all([
		ctx.workspaceRoot ? ctx.listDirectory('.claude/agents') : Promise.resolve([]),
		ctx.listHomeEntries('agents'),
	]);
	const definitions: IAgentDefinition[] = [];
	for (const [scope, names] of [['project', projectNames], ['user', userNames]] as const) {
		for (const entry of names) {
			if (!entry.endsWith('.md')) {
				continue;
			}
			const path = scope === 'project' ? `.claude/agents/${entry}` : `agents/${entry}`;
			const raw = scope === 'project' ? await ctx.readTextFile(path) : await ctx.readHomeFile(path);
			const front = parseFrontmatter(raw ?? '');
			definitions.push({
				name: front['name'] || entry.replace(/\.md$/, ''),
				scope,
				path: scope === 'project' ? path : `~/.claude/${path}`,
				description: front['description'] ?? '',
				tools: front['tools'],
				model: front['model'],
			});
		}
	}
	return definitions;
}

/**
 * The leading `--- ... ---` block of an agent or skill file, as key/value pairs.
 * Only the flat scalar keys these files use are read — no YAML parser is needed
 * and pulling one in is not allowed in this tree.
 */
function parseFrontmatter(text: string): Record<string, string> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) {
		return {};
	}
	const values: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (pair) {
			values[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
		}
	}
	return values;
}

/** Print one agent's instructions, asking which when the name is missing. */
async function showAgent(ctx: ICodeMindCommandContext, agents: readonly IAgentDefinition[], requested: string): Promise<void> {
	if (!agents.length) {
		ctx.appendSystemMessage('No subagents defined yet.');
		return;
	}
	let agent = requested ? agents.find(entry => entry.name.toLowerCase() === requested.toLowerCase()) : undefined;
	if (!agent && requested) {
		ctx.appendSystemMessage(`No subagent named "${requested}". Run /agents to list them.`);
		return;
	}
	if (!agent) {
		const picked = await ctx.pick('Show which subagent?', agents.map((entry, i) => ({
			id: String(i), label: entry.name, description: clip(entry.description, 100), detail: entry.path,
		})));
		if (picked === undefined) {
			return;
		}
		agent = agents[Number.parseInt(picked, 10)];
	}
	const raw = agent.scope === 'project'
		? await ctx.readTextFile(agent.path)
		: await ctx.readHomeFile(agent.path.replace(/^~\/\.claude\//, ''));
	ctx.appendSystemMessage(raw
		? `${agent.path}:\n\n${clip(raw, 8000)}`
		: `Could not read ${agent.path}.`);
}

/** Ask for the parts of a definition and write the markdown file. */
async function createAgent(ctx: ICodeMindCommandContext): Promise<void> {
	const name = (await ctx.promptText('Name for the subagent — lowercase, dashes instead of spaces') ?? '').trim();
	if (!name) {
		return;
	}
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		ctx.appendSystemMessage('Use lowercase letters, digits and dashes only — the engine matches subagents by that name.');
		return;
	}
	const description = (await ctx.promptText('When should the agent use it? This is what it reads to decide.') ?? '').trim();
	if (!description) {
		return;
	}
	const tools = (await ctx.promptText('Tools it may use, comma separated. Leave empty to allow all of them.') ?? '').trim();
	const instructions = (await ctx.promptText('Its system prompt — how it should do the work') ?? '').trim();
	if (!instructions) {
		return;
	}
	const scope = ctx.workspaceRoot
		? await ctx.pick('Save the subagent where?', [
			{ id: 'project', label: 'project', description: '.claude/agents — shared with the repository' },
			{ id: 'user', label: 'user', description: '~/.claude/agents — available in every project' },
		])
		: 'user';
	if (!scope) {
		return;
	}
	const contents = [
		'---',
		`name: ${name}`,
		`description: ${description}`,
		...(tools ? [`tools: ${tools}`] : []),
		'---',
		'',
		instructions,
		'',
	].join('\n');
	// Writing under the home directory has no overwrite guard of its own, so check
	// first — a subagent definition is hand-written and must not be clobbered.
	if (scope === 'user' && await ctx.readHomeFile(`agents/${name}.md`) !== undefined) {
		ctx.appendSystemMessage(`~/.claude/agents/${name}.md already exists — pick another name or edit that file.`);
		return;
	}
	const written = scope === 'project'
		? await ctx.writeTextFile(`.claude/agents/${name}.md`, contents)
		: await ctx.writeHomeFile(`agents/${name}.md`, contents);
	if (!written) {
		ctx.appendSystemMessage(`Could not write the subagent — ${scope === 'project' ? `.claude/agents/${name}.md` : `~/.claude/agents/${name}.md`} may already exist.`);
		return;
	}
	ctx.appendSystemMessage(`Created ${written}. The engine picks it up on the next turn; ask for it by name.`);
}

// --- /insights

/**
 * `/insights` — how this project has actually been worked on.
 *
 * The numbers come from the engine's transcript logs, so they cover every past
 * session rather than just the one on screen; the written analysis is left to the
 * agent, which is the part it is better at than a template.
 */
async function showInsights(ctx: ICodeMindCommandContext): Promise<void> {
	const [insights, usage] = await Promise.all([ctx.projectInsights(), ctx.engineService.getSessionUsage()]);
	const messages = ctx.transcript();
	const lines: string[] = ['Insights'];

	if (insights && insights.sessions) {
		const days = Math.max(1, Math.round((insights.lastAt - insights.firstAt) / 86400000));
		lines.push(
			`  Sessions:       ${insights.sessions} on this project${insights.scanned < insights.sessions ? ` (newest ${insights.scanned} analysed)` : ''}`,
			`  Active:         over ${days} day${days === 1 ? '' : 's'}, last on ${new Date(insights.lastAt).toLocaleDateString()}`,
			`  Exchanges:      ${insights.userPrompts} prompts · ${insights.assistantMessages} answers`,
		);
		if (insights.toolCalls.length) {
			lines.push(`  Tools used:     ${insights.toolCalls.slice(0, 6).map(tool => `${tool.name} ×${tool.count}`).join(', ')}`);
		}
		if (insights.files.length) {
			lines.push('  Files touched most:');
			lines.push(...insights.files.slice(0, 8).map(file => `    ${file.count} × ${file.path}`));
		}
	} else {
		lines.push('  No past session logs found for this project, so this is only the session on screen.');
	}

	const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
	const spanMs = messages.length > 1 ? messages[messages.length - 1].timestamp - messages[0].timestamp : 0;
	lines.push(
		'',
		'This session',
		`  Exchanges:      ${messages.filter(m => m.role === 'user').length} asked · ${messages.filter(m => m.role === 'assistant').length} answered`,
		`  Volume:         ${totalChars.toLocaleString()} characters (~${estimateTokensForChars(totalChars).toLocaleString()} est. tokens)`,
		`  Elapsed:        ${spanMs ? formatDuration(spanMs) : 'just started'}`,
		`  Model:          ${ctx.getModel()}`,
		`  Permissions:    ${ctx.isPlanMode() ? 'plan (read-only)' : ctx.getPermissionMode()}`,
	);
	if (usage) {
		lines.push(`  Engine tokens:  ${formatTokens(usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens)} in · ${formatTokens(usage.outputTokens)} out${usage.totalCostUsd != null ? ` · $${usage.totalCostUsd.toFixed(4)}` : ''}`);
	}
	ctx.appendSystemMessage(lines.join('\n'));

	if (!messages.length) {
		return;
	}
	ctx.sendToAgent([
		'Analyse this session and write a short report: what I was trying to do, what got done,',
		'where we lost time, and two concrete suggestions for working faster next time.',
		'Use the conversation you already have — do not re-read the repository for this.',
	].join(' '));
}

// --- /plugin

/** Where the engine keeps plugin state, all under `~/.claude`. */
const PLUGIN_INSTALLED_FILE = 'plugins/installed_plugins.json';
const PLUGIN_MARKETPLACES_FILE = 'plugins/known_marketplaces.json';

/**
 * `/plugin` — what the engine has installed, and which of it is switched on.
 *
 * Installation is the engine's own job (it clones marketplaces and resolves
 * dependencies), so this reads its state files rather than reimplementing that.
 * Enabling and disabling, though, is just the `enabledPlugins` map in a settings
 * file, which is why those are editable here.
 */
async function managePlugins(ctx: ICodeMindCommandContext, args: string): Promise<void> {
	const [verb, ...rest] = args.split(/\s+/).filter(Boolean);
	const sub = (verb ?? '').toLowerCase();
	const id = rest.join(' ').trim();
	if (sub === 'dir') {
		ctx.appendSystemMessage('Plugins live in ~/.claude/plugins (installed_plugins.json, known_marketplaces.json, marketplaces/, cache/).');
		return;
	}
	if (sub === 'enable' || sub === 'disable') {
		await setPluginEnabled(ctx, id, sub === 'enable');
		return;
	}
	if (sub && sub !== 'list') {
		ctx.appendSystemMessage(`Unknown option "${sub}". Use /plugin, /plugin enable <id>, /plugin disable <id> or /plugin dir.`);
		return;
	}

	const [installed, marketplaces, enabled] = await Promise.all([
		readInstalledPlugins(ctx),
		readKnownMarketplaces(ctx),
		readEnabledPlugins(ctx),
	]);
	const lines: string[] = [];
	if (installed.length) {
		lines.push('Installed plugins:');
		for (const plugin of installed) {
			const state = enabled.get(plugin);
			lines.push(`  ${plugin} — ${state === undefined ? 'not listed in settings (the engine decides)' : state.enabled ? `enabled in ${state.scope} settings` : `disabled in ${state.scope} settings`}`);
		}
	} else {
		lines.push('No plugins installed.');
	}
	// A plugin can be switched on in settings before it has been installed; the
	// engine installs it on the next start, so it belongs in the list.
	const pending = [...enabled.keys()].filter(candidate => !installed.includes(candidate));
	if (pending.length) {
		lines.push('', 'Configured but not installed yet:', ...pending.map(candidate => `  ${candidate} — ${enabled.get(candidate)?.enabled ? 'enabled' : 'disabled'} in ${enabled.get(candidate)?.scope} settings`));
	}
	lines.push('');
	lines.push(marketplaces.length
		? `Known marketplaces:\n${marketplaces.map(entry => `  ${entry.name} — ${entry.source}`).join('\n')}`
		: 'No marketplaces registered.');
	lines.push('', 'Turn one on or off with /plugin enable <id> or /plugin disable <id>, then /reload-plugins.');
	ctx.appendSystemMessage(lines.join('\n'));
}

/** Plugin ids from `installed_plugins.json`, in either the V1 or V2 shape. */
async function readInstalledPlugins(ctx: ICodeMindCommandContext): Promise<string[]> {
	const raw = await ctx.readHomeFile(PLUGIN_INSTALLED_FILE);
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
		return parsed.plugins && typeof parsed.plugins === 'object' ? Object.keys(parsed.plugins) : [];
	} catch {
		// The engine rewrites this file itself; a broken one is not ours to fix.
		return [];
	}
}

/** Marketplaces from `known_marketplaces.json`, with their source described. */
async function readKnownMarketplaces(ctx: ICodeMindCommandContext): Promise<{ name: string; source: string }[]> {
	const raw = await ctx.readHomeFile(PLUGIN_MARKETPLACES_FILE);
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, { source?: Record<string, unknown> }>;
		return Object.entries(parsed).map(([name, entry]) => {
			const source = entry?.source ?? {};
			const kind = typeof source['source'] === 'string' ? source['source'] : 'unknown';
			const where = ['repo', 'url', 'path', 'package'].map(key => source[key]).find(value => typeof value === 'string');
			return { name, source: where ? `${kind}: ${where}` : kind };
		});
	} catch {
		return [];
	}
}

/**
 * The `enabledPlugins` map as the engine resolves it: the more specific settings
 * file wins, so walk them in the order it merges them.
 */
async function readEnabledPlugins(ctx: ICodeMindCommandContext): Promise<Map<string, { enabled: boolean; scope: SettingsScope }>> {
	const resolved = new Map<string, { enabled: boolean; scope: SettingsScope }>();
	for (const scope of writableScopes(ctx)) {
		const file = await readSettingsFile(ctx, scope);
		const section = file.value['enabledPlugins'];
		if (!section || typeof section !== 'object' || Array.isArray(section)) {
			continue;
		}
		for (const [id, value] of Object.entries(section as Record<string, unknown>)) {
			if (value === undefined) {
				continue;
			}
			// A list of channels counts as on, the same way the engine reads it.
			resolved.set(id, { enabled: Array.isArray(value) ? value.length > 0 : value === true, scope });
		}
	}
	return resolved;
}

/** Write one entry of `enabledPlugins`, asking which plugin and file when needed. */
async function setPluginEnabled(ctx: ICodeMindCommandContext, requested: string, enabled: boolean): Promise<void> {
	let id = requested;
	if (!id) {
		const [installed, configured] = await Promise.all([readInstalledPlugins(ctx), readEnabledPlugins(ctx)]);
		const candidates = [...new Set([...installed, ...configured.keys()])];
		if (!candidates.length) {
			ctx.appendSystemMessage('No plugins are installed, so there is nothing to enable. Install one from a marketplace first.');
			return;
		}
		const picked = await ctx.pick(enabled ? 'Enable which plugin?' : 'Disable which plugin?', candidates.map(candidate => ({
			id: candidate,
			label: candidate,
			description: configured.get(candidate)?.enabled === false ? 'currently disabled' : configured.has(candidate) ? 'currently enabled' : 'not configured',
		})));
		if (picked === undefined) {
			return;
		}
		id = picked;
	}
	const scope = await pickSettingsScope(ctx, `${enabled ? 'Enable' : 'Disable'} "${id}" in which settings file?`);
	if (!scope) {
		return;
	}
	const file = await readSettingsFile(ctx, scope);
	if (file.invalid) {
		ctx.appendSystemMessage(`${SETTINGS_LABELS[scope]} is not valid JSON — fix it first, or the change would be lost.`);
		return;
	}
	const section = { ...(file.value['enabledPlugins'] as Record<string, unknown> | undefined ?? {}) };
	section[id] = enabled;
	const written = await writeSettingsFile(ctx, scope, { ...file.value, enabledPlugins: section });
	ctx.appendSystemMessage(written
		? `${enabled ? 'Enabled' : 'Disabled'} ${id} in ${written}. Run /reload-plugins, or restart to let the engine install it if it is not there yet.`
		: `Could not write ${SETTINGS_LABELS[scope]}.`);
}

// --- panels and help

function registerPanelCommands(registry: CodeMindCommandRegistry): void {

	registry.register({
		name: 'mcp',
		description: localize('cmcmd.mcp', 'Manage MCP servers: open the panel, list them, or turn one on and off.'),
		args: '[list|enable <name|all>|disable <name|all>]',
		execute: async (args, ctx) => {
			const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const sub = (verb ?? '').toLowerCase();
			if (!sub) {
				ctx.openPanel('mcp');
				return;
			}
			const servers = await ctx.engineService.getMcpServers();
			if (sub === 'list') {
				// Ask the engine for live connection state rather than reporting whatever
				// the last turn happened to see.
				const live = await ctx.engineService.refreshMcpStatus();
				ctx.appendSystemMessage(live.length
					? live.map(s => `  ${s.enabled === false ? '○' : '●'} ${s.name} — ${s.status ?? 'disconnected'}${s.tools?.length ? ` (${s.tools.length} tool${s.tools.length === 1 ? '' : 's'})` : ''}`).join('\n')
					: 'No MCP servers configured. Add one with /mcp and the panel.');
				return;
			}
			if (sub !== 'enable' && sub !== 'disable') {
				ctx.appendSystemMessage('Usage: /mcp · /mcp list · /mcp enable <name|all> · /mcp disable <name|all>');
				return;
			}
			const target = rest.join(' ').trim();
			if (!target) {
				ctx.appendSystemMessage(`Usage: /mcp ${sub} <name|all>`);
				return;
			}
			const enabled = sub === 'enable';
			const all = target.toLowerCase() === 'all';
			if (!all && !servers.some(s => s.name.toLowerCase() === target.toLowerCase())) {
				ctx.appendSystemMessage(`No MCP server named ${target}.${servers.length ? ` Known: ${servers.map(s => s.name).join(', ')}` : ''}`);
				return;
			}
			// Rebuild from the configurable fields only: `status` and `tools` are the
			// engine's observations, not settings, and the panel re-decorates them.
			const next: ICodeMindMcpServer[] = servers.map(server => ({
				name: server.name,
				type: server.type,
				command: server.command,
				args: server.args,
				url: server.url,
				env: server.env,
				enabled: all || server.name.toLowerCase() === target.toLowerCase() ? enabled : server.enabled,
			}));
			await ctx.engineService.setMcpServers(next);
			// Writing the setting is what makes it survive a reload, and the view pane's
			// configuration listener pushes the fresh list back to the panel.
			await ctx.setConfig('codemind.mcpServers', next);
			const changed = all ? servers.map(s => s.name) : [target];
			ctx.appendSystemMessage(`${enabled ? 'Enabled' : 'Disabled'} ${changed.length ? changed.join(', ') : 'nothing'}. Takes effect on the next turn.`);
		},
	});

	registry.register({
		name: 'config',
		aliases: ['settings'],
		description: localize('cmcmd.config', 'Open the settings panel.'),
		execute: async (_args, ctx) => { ctx.openPanel('settings'); },
	});

	registry.register({
		name: 'memory',
		description: localize('cmcmd.memory', 'Open the memory management panel.'),
		execute: async (_args, ctx) => { ctx.openPanel('memory'); },
	});

	registry.register({
		name: 'skills',
		description: localize('cmcmd.skills', 'Open the skills management panel.'),
		execute: async (_args, ctx) => { ctx.openPanel('skills'); },
	});

	registry.register({
		name: 'tasks',
		// The CLI's /tasks is its background-shell dialog; the panel keeps that on
		// /bashes and gives /tasks the tracked-work panel, which the CLI has no
		// command for at all.
		description: localize('cmcmd.tasks', 'Open the task management panel.'),
		execute: async (_args, ctx) => { ctx.openPanel('tasks'); },
	});

	registry.register({
		name: 'bashes',
		aliases: ['background'],
		description: localize('cmcmd.bashes', 'List the background shells, monitors and agents this session started.'),
		execute: async (_args, ctx) => { ctx.openPanel('backgroundTasks'); },
	});

	registry.register({
		name: 'theme',
		description: localize('cmcmd.theme', 'Change the colour theme.'),
		args: '[dark|light|high contrast|<name>]',
		execute: async (args, ctx) => {
			const wanted = args.trim();
			if (!wanted) {
				// The panel has no palette of its own — every colour comes from the workbench
				// theme, so a bare /theme opens the real picker instead of describing where it lives.
				await ctx.runWorkbenchCommand('workbench.action.selectTheme');
				return;
			}
			const themes = await ctx.listColorThemes();
			const match = resolveColorTheme(themes, wanted, ctx.getColorTheme());
			if (!match) {
				const kinds = ['dark', 'light', 'high contrast'];
				ctx.appendSystemMessage([
					`No colour theme matches "${wanted}".`,
					`Say a kind (${kinds.join(', ')}) or part of a theme's name. Installed: ${themes.map(t => t.label).join(', ')}.`,
				].join('\n'));
				return;
			}
			await ctx.setColorTheme(match.id);
			ctx.appendSystemMessage(`Colour theme: ${match.label} (${match.kind}).`);
		},
	});

	registry.register({
		name: 'desktop',
		aliases: ['app'],
		description: localize('cmcmd.desktop', 'No-op: you are already using the desktop app.'),
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage('Already running in the CodeMind desktop app.');
		},
	});

	registry.register({
		name: 'mobile',
		aliases: ['ios', 'android'],
		description: localize('cmcmd.mobile', 'Explain how to continue this work away from the desktop.'),
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage('CodeMind has no mobile client. Export the conversation with /export and continue it elsewhere.');
		},
	});

	registry.register({
		name: 'help',
		description: localize('cmcmd.help', 'List all available slash commands.'),
		execute: async (_args, ctx) => {
			const lines = ['Available commands:'];
			for (const c of registry.listVisible().slice().sort((a, b) => a.name.localeCompare(b.name))) {
				const aliases = c.aliases?.length ? ` (also /${c.aliases.join(', /')})` : '';
				lines.push(`  /${c.name}${c.args ? ' ' + c.args : ''}  — ${c.description}${aliases}`);
			}
			ctx.appendSystemMessage(lines.join('\n'));
		},
	});

}

// --- model behaviour: effort, fast mode, advisor, sandbox

/** The help block `/effort` prints, matching the CLI's own wording. */
const EFFORT_HELP = [
	'Usage: /effort [low|medium|high|xhigh|max|auto]',
	'',
	'Effort levels:',
	'- low: Quick, straightforward implementation',
	'- medium: Balanced approach with standard testing',
	'- high: Comprehensive implementation with extensive testing',
	'- xhigh: Deeper than high. Newer models only',
	'- max: Maximum capability with deepest reasoning',
	'- auto: Use the default effort level for your model',
].join('\n');

function registerModelCommands(registry: CodeMindCommandRegistry): void {

	registry.register({
		name: 'effort',
		description: localize('cmcmd.effort', 'Set effort level for model usage.'),
		args: '[low|medium|high|xhigh|max|auto]',
		execute: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			const current = ctx.getConfig<string>('codemind.effort') || 'auto';
			if (!requested || requested === 'current' || requested === 'status') {
				ctx.appendSystemMessage(`Effort level: ${current}\n\n${EFFORT_HELP}`);
				return;
			}
			if (requested === 'help' || requested === '?') {
				ctx.appendSystemMessage(EFFORT_HELP);
				return;
			}
			if (requested === 'unset') {
				await ctx.setConfig('codemind.effort', 'auto');
				ctx.appendSystemMessage('Effort level set to auto.');
				return;
			}
			if (!EFFORT_LEVELS.includes(requested)) {
				ctx.appendSystemMessage(`Invalid argument: ${args.trim()}. Valid options are: ${EFFORT_LEVELS.join(', ')}`);
				return;
			}
			await ctx.setConfig('codemind.effort', requested);
			ctx.appendSystemMessage(requested === 'auto'
				? 'Effort level set to auto.'
				: `Effort level set to ${requested}. Models without this level fall back to the closest one they support.`);
		},
	});

	registry.register({
		name: 'fast',
		description: localize('cmcmd.fast', 'Toggle fast mode: quicker output from the same model.'),
		args: '[on|off]',
		execute: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			const current = ctx.getConfig<boolean>('codemind.fastMode') === true;
			let next: boolean;
			if (requested === 'on' || requested === 'true' || requested === 'enable') {
				next = true;
			} else if (requested === 'off' || requested === 'false' || requested === 'disable') {
				next = false;
			} else if (!requested || requested === 'toggle') {
				next = !current;
			} else {
				ctx.appendSystemMessage(`Invalid argument: ${args.trim()}. Usage: /fast [on|off]`);
				return;
			}
			await ctx.setConfig('codemind.fastMode', next);
			ctx.appendSystemMessage(next
				? 'Fast mode on — the same model, asked for faster output. Models that do not offer it ignore the request.'
				: 'Fast mode off.');
		},
	});

	registry.register({
		name: 'advisor',
		description: localize('cmcmd.advisor', 'Set a second model the agent may consult on hard turns.'),
		args: '[<model>|off]',
		execute: async (args, ctx) => {
			const requested = args.trim();
			const current = ctx.getConfig<string>('codemind.advisorModel') || '';
			if (!requested) {
				ctx.appendSystemMessage([
					current ? `Advisor model: ${current}` : 'No advisor model set.',
					'',
					'Available:',
					...ADVISOR_CHOICES.map(m => `  ${m}`),
					'',
					'Set one with /advisor <model>, or turn it off with /advisor off.',
				].join('\n'));
				return;
			}
			if (MODEL_RESET_WORDS.includes(requested.toLowerCase())) {
				await ctx.setConfig('codemind.advisorModel', '');
				ctx.appendSystemMessage('Advisor model turned off.');
				return;
			}
			// Haiku is never a useful advisor, and the plan-mode/1M aliases are not
			// meaningful for a single consulting call — reject those rather than let
			// the engine silently ignore the setting.
			const lowered = requested.toLowerCase();
			if (lowered === 'haiku' || lowered.startsWith('claude-haiku-') || lowered === 'opusplan' || lowered.endsWith('[1m]')) {
				ctx.appendSystemMessage(`${requested} cannot be an advisor. Choose one of: ${ADVISOR_CHOICES.join(', ')}.`);
				return;
			}
			await ctx.setConfig('codemind.advisorModel', requested);
			ctx.appendSystemMessage(`Advisor model set to ${requested}.`);
		},
	});

	registry.register({
		name: 'sandbox',
		description: localize('cmcmd.sandbox', 'Show or change the sandbox the agent runs commands in.'),
		args: '[on|off|auto-allow|fallback|exclude "<pattern>"]',
		execute: async (args, ctx) => {
			const sandbox = ctx.getConfig<ICodeMindSandboxSettings>('codemind.sandbox') ?? {};
			const excluded = Array.isArray(sandbox.excludedCommands) ? [...sandbox.excludedCommands] : [];
			const write = (next: ICodeMindSandboxSettings) => ctx.setConfig('codemind.sandbox', next);
			const raw = args.trim();
			const [verb, ...rest] = raw.split(/\s+/);
			const keyword = (verb ?? '').toLowerCase();

			if (!raw || keyword === 'status') {
				const mark = (on: boolean | undefined) => (on ? '✓' : '○');
				ctx.appendSystemMessage([
					`${mark(sandbox.enabled)} sandbox ${sandbox.enabled ? 'enabled' : 'disabled'}`,
					`${mark(sandbox.autoAllowBashIfSandboxed)} auto-allow sandboxed commands (skip the permission prompt)`,
					`${mark(sandbox.allowUnsandboxedCommands)} fallback allowed (a command that cannot be sandboxed may run outside it)`,
					excluded.length ? `Excluded patterns:\n${excluded.map(p => `  ${p}`).join('\n')}` : 'No excluded patterns.',
					'',
					'Change with /sandbox on|off, /sandbox auto-allow, /sandbox fallback, /sandbox exclude "<pattern>".',
				].join('\n'));
				return;
			}

			switch (keyword) {
				case 'on':
				case 'enable':
					await write({ ...sandbox, enabled: true, excludedCommands: excluded });
					ctx.appendSystemMessage('Sandbox on — the agent runs commands with restricted filesystem and network access.');
					return;
				case 'off':
				case 'disable':
					await write({ ...sandbox, enabled: false, excludedCommands: excluded });
					ctx.appendSystemMessage('Sandbox off — commands run with your full permissions.');
					return;
				case 'auto-allow':
				case 'autoallow': {
					const next = !(sandbox.autoAllowBashIfSandboxed === true);
					await write({ ...sandbox, autoAllowBashIfSandboxed: next, excludedCommands: excluded });
					ctx.appendSystemMessage(next
						? 'Auto-allow on — commands that run inside the sandbox no longer prompt.'
						: 'Auto-allow off — every command prompts.');
					return;
				}
				case 'fallback': {
					const next = !(sandbox.allowUnsandboxedCommands === true);
					await write({ ...sandbox, allowUnsandboxedCommands: next, excludedCommands: excluded });
					ctx.appendSystemMessage(next
						? 'Fallback on — a command that cannot be sandboxed may run outside it, with a prompt.'
						: 'Fallback off — a command that cannot be sandboxed is refused.');
					return;
				}
				case 'exclude': {
					// Accept both quoted and bare patterns: `exclude "npm run *"` and `exclude git`.
					const pattern = rest.join(' ').trim().replace(/^["']|["']$/g, '');
					if (!pattern) {
						ctx.appendSystemMessage('Usage: /sandbox exclude "command pattern"');
						return;
					}
					const at = excluded.indexOf(pattern);
					if (at >= 0) {
						excluded.splice(at, 1);
						await write({ ...sandbox, excludedCommands: excluded });
						ctx.appendSystemMessage(`Removed sandbox exclusion: ${pattern}`);
						return;
					}
					excluded.push(pattern);
					await write({ ...sandbox, excludedCommands: excluded });
					ctx.appendSystemMessage(`Commands matching "${pattern}" will always run outside the sandbox.`);
					return;
				}
				default:
					ctx.appendSystemMessage(`Unknown argument "${raw}". Usage: /sandbox [on|off|auto-allow|fallback|exclude "<pattern>"]`);
					return;
			}
		},
	});

}

// --- the conversation itself: copying, naming, tagging, side questions

/** Fenced code blocks in a markdown answer, in the order they appear. */
function codeBlocks(text: string): { language: string; code: string }[] {
	const blocks: { language: string; code: string }[] = [];
	// Deliberately simple: an opening fence with an optional language, then
	// everything up to the next fence. Nested fences are rare in answers and the
	// picker degrades gracefully — the whole response is always an option.
	const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = fence.exec(text)) !== null) {
		const code = match[2].replace(/\n$/, '');
		if (code.trim()) {
			blocks.push({ language: match[1].trim(), code });
		}
	}
	return blocks;
}

/** A one-line preview of a code block for the picker. */
function firstLine(code: string, max = 60): string {
	const line = code.split('\n', 1)[0].trim();
	return line.length <= max ? line : `${line.slice(0, max)}…`;
}

function registerConversationCommands(registry: CodeMindCommandRegistry): void {

	registry.register({
		name: 'copy',
		description: localize('cmcmd.copy', "Copy the agent's last response to the clipboard (or /copy N for the Nth-latest)."),
		args: '[N]',
		execute: async (args, ctx) => {
			// Newest first, so N=1 is the latest answer — the same numbering the CLI uses.
			const answers = ctx.transcript().filter(m => m.role === 'assistant').map(m => m.content).reverse();
			if (answers.length === 0) {
				ctx.appendSystemMessage('No assistant message to copy.');
				return;
			}
			const raw = args.trim();
			let index = 0;
			if (raw) {
				const n = Number(raw);
				if (!Number.isInteger(n) || n < 1) {
					ctx.appendSystemMessage(`Usage: /copy [N] where N is 1 (latest), 2, 3, … Got: ${raw}`);
					return;
				}
				if (n > answers.length) {
					ctx.appendSystemMessage(`Only ${answers.length} assistant message(s) available to copy.`);
					return;
				}
				index = n - 1;
			}
			const text = answers[index];
			const blocks = codeBlocks(text);
			if (blocks.length === 0) {
				await ctx.copyToClipboard(text);
				ctx.appendSystemMessage(`Copied ${text.length} characters to the clipboard.`);
				return;
			}
			// The answer contains code, so offer the same choice the CLI does: the
			// whole response, or one specific block.
			const choice = await ctx.pick('Copy which part of the response?', [
				{ id: 'all', label: 'Whole response', description: `${text.length} characters` },
				...blocks.map((b, i) => ({
					id: String(i),
					label: b.language ? `Code block ${i + 1} (${b.language})` : `Code block ${i + 1}`,
					description: firstLine(b.code),
				})),
			]);
			if (choice === undefined) {
				return;
			}
			const picked = choice === 'all' ? text : blocks[Number(choice)]?.code;
			if (picked === undefined) {
				return;
			}
			await ctx.copyToClipboard(picked);
			ctx.appendSystemMessage(`Copied ${picked.length} characters to the clipboard.`);
		},
	});

	registry.register({
		name: 'rename',
		description: localize('cmcmd.rename', 'Rename the current conversation.'),
		args: '[name]',
		execute: async (args, ctx) => {
			const requested = args.trim();
			if (requested) {
				await ctx.setSessionName(requested);
				ctx.appendSystemMessage(`Session renamed to: ${requested}`);
				return;
			}
			// No name given: ask the model for one, exactly as the CLI does.
			const recent = ctx.transcript().slice(-6).map(m => `${m.role}: ${clip(m.content, 400)}`).join('\n\n');
			if (!recent) {
				ctx.appendSystemMessage('Nothing to name yet — send a message first, or use /rename <name>.');
				return;
			}
			const generated = (await ctx.silentQuery([
				'Give this conversation a short title: at most four words, no quotes, no trailing punctuation, no preamble.',
				'Reply with the title and nothing else.',
				'',
				recent,
			].join('\n'))).trim().split('\n')[0].replace(/^["']|["']$/g, '').slice(0, 60);
			if (!generated) {
				ctx.appendSystemMessage('Could not generate a name. Use /rename <name>.');
				return;
			}
			await ctx.setSessionName(generated);
			ctx.appendSystemMessage(`Session renamed to: ${generated}`);
		},
	});

	registry.register({
		name: 'color',
		description: localize('cmcmd.color', 'Set the prompt bar colour for this session.'),
		args: '<color|default>',
		execute: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested) {
				const current = ctx.getPromptColor();
				ctx.appendSystemMessage([
					current ? `Session colour: ${current}` : 'Session colour: default',
					`Please provide a color. Available colors: ${AGENT_COLORS.join(', ')}, default`,
				].join('\n'));
				return;
			}
			if (COLOR_RESET_WORDS.includes(requested)) {
				await ctx.setPromptColor('');
				ctx.appendSystemMessage('Session color reset to default');
				return;
			}
			if (!AGENT_COLORS.includes(requested)) {
				ctx.appendSystemMessage(`Invalid color "${args.trim()}". Available colors: ${AGENT_COLORS.join(', ')}, default`);
				return;
			}
			await ctx.setPromptColor(requested);
			ctx.appendSystemMessage(`Session color set to: ${requested}`);
		},
	});

	registry.register({
		name: 'tag',
		description: localize('cmcmd.tag', 'Toggle a searchable tag on the current session.'),
		args: '<tag-name>',
		// Hidden for the same reason the CLI hides it: tags are only useful to
		// sessions that get indexed somewhere, which a local panel session is not.
		hidden: true,
		execute: async (args, ctx) => {
			const tag = args.trim();
			if (!tag) {
				const tags = ctx.getTags();
				ctx.appendSystemMessage(tags.length
					? `Tags on this session: ${tags.join(', ')}\n\nUsage: /tag <tag-name>`
					: 'Usage: /tag <tag-name>');
				return;
			}
			const after = await ctx.toggleTag(tag);
			ctx.appendSystemMessage(after.includes(tag)
				? `Tagged this session "${tag}". Tags: ${after.join(', ')}`
				: (after.length ? `Removed tag "${tag}". Tags: ${after.join(', ')}` : `Removed tag "${tag}". No tags left.`));
		},
	});

	registry.register({
		name: 'btw',
		description: localize('cmcmd.btw', 'Ask a quick side question without interrupting the main conversation.'),
		args: '<question>',
		execute: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.appendSystemMessage('Usage: /btw <your question>');
				return;
			}
			ctx.appendSystemMessage(`Side question: ${question}`);
			const answer = await ctx.sideQuery(question);
			ctx.appendSystemMessage(answer.trim() || 'No answer.');
		},
	});

	registry.register({
		name: 'exit',
		aliases: ['quit'],
		description: localize('cmcmd.exit', 'Close the agent panel.'),
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage('Goodbye! Reopen the panel with Ctrl+Alt+M.');
			ctx.hidePanel();
		},
	});

	registry.register({
		name: 'insights',
		description: localize('cmcmd.insights', 'Report how this project has been worked on, across sessions.'),
		execute: async (_args, ctx) => { await showInsights(ctx); },
	});

	registry.register({
		name: 'think-back',
		description: localize('cmcmd.thinkBack', 'Review what this session has covered so far.'),
		execute: async (_args, ctx) => {
			const messages = ctx.transcript();
			if (messages.length === 0) {
				ctx.appendSystemMessage('Nothing to look back on yet.');
				return;
			}
			const lines = ['Your session so far:'];
			let turn = 0;
			for (const message of messages) {
				if (message.role !== 'user') {
					continue;
				}
				turn++;
				const when = new Date(message.timestamp).toLocaleTimeString();
				lines.push(`  ${turn}. [${when}] ${clip(message.content.replace(/\s+/g, ' ').trim(), 100)}`);
			}
			ctx.appendSystemMessage(lines.join('\n'));
		},
	});

	registry.register({
		name: 'thinkback-play',
		description: localize('cmcmd.thinkbackPlay', 'Replay the session as a timeline.'),
		hidden: true,
		execute: async (_args, ctx) => {
			const messages = ctx.transcript();
			if (messages.length === 0) {
				ctx.appendSystemMessage('Nothing to replay yet.');
				return;
			}
			const start = messages[0].timestamp;
			const lines = ['Session timeline:'];
			for (const message of messages) {
				const offset = Math.round((message.timestamp - start) / 1000);
				const stamp = `${String(Math.floor(offset / 60)).padStart(2, '0')}:${String(offset % 60).padStart(2, '0')}`;
				lines.push(`  ${stamp}  ${message.role === 'user' ? 'you' : 'agent'}  ${clip(message.content.replace(/\s+/g, ' ').trim(), 80)}`);
			}
			ctx.appendSystemMessage(lines.join('\n'));
		},
	});

}

// --- editor integration, keybindings, plugins

/** The GitHub Actions workflow `/install-github-app` writes. */
const CLAUDE_WORKFLOW = `name: Claude
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
jobs:
  claude:
    if: contains(github.event.comment.body, '@claude')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
`;

/** The review workflow `/install-github-app` writes alongside it. */
const CLAUDE_REVIEW_WORKFLOW = `name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  claude-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          prompt: Review this pull request and leave inline comments on anything that looks wrong.
`;

function registerSetupCommands(registry: CodeMindCommandRegistry): void {

	registry.register({
		name: 'ide',
		description: localize('cmcmd.ide', 'Show how the agent is integrated with this editor.'),
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage([
				'CodeMind Agent is built into this editor — there is nothing to connect.',
				'',
				'  Panel        Secondary side bar (Ctrl+Alt+M)',
				`  Workspace    ${ctx.workspaceRoot || 'no folder open'}`,
				`  Model        ${ctx.getModel()}`,
				`  Permissions  ${ctx.getPermissionMode()}`,
				`  Plan mode    ${ctx.isPlanMode() ? 'on' : 'off'}`,
				'',
				'Diffs open in the editor, @ mentions complete against workspace files, and file edits',
				'appear in the same buffers you are working in.',
			].join('\n'));
		},
	});

	registry.register({
		name: 'keybindings',
		description: localize('cmcmd.keybindings', 'Open your keyboard shortcuts configuration.'),
		args: '[json]',
		execute: async (args, ctx) => {
			// The GUI has real keybinding UI, so this opens that rather than writing a
			// parallel file nothing in the editor would read.
			const wantsJson = ['json', 'file', 'edit'].includes(args.trim().toLowerCase());
			await ctx.runWorkbenchCommand(wantsJson
				? 'workbench.action.openGlobalKeybindingsFile'
				: 'workbench.action.openGlobalKeybindings');
			ctx.appendSystemMessage(wantsJson
				? 'Opened keybindings.json. Add a `codemind` entry to rebind the panel.'
				: 'Opened Keyboard Shortcuts. Search for "CodeMind" to rebind the panel (Ctrl+Alt+M by default). Use /keybindings json to edit the file directly.');
		},
	});

	registry.register({
		name: 'terminal-setup',
		description: localize('cmcmd.terminalSetup', 'Explain the chat input key bindings.'),
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage([
				'The chat input is a text box, not a terminal, so no terminal setup is needed:',
				'',
				'  Enter        send',
				'  Shift+Enter  newline',
				'  Esc          stop the current turn',
				'  /            slash commands',
				'  @            mention a workspace file',
				'',
				'Use /keybindings to change the panel shortcut.',
			].join('\n'));
		},
	});

	registry.register({
		name: 'statusline',
		description: localize('cmcmd.statusline', "Set up the editor status bar entry for the agent."),
		args: '[instructions]',
		execute: async (args, ctx) => {
			const extra = args.trim();
			ctx.sendToAgent([
				'Configure a status line for the CodeMind Agent panel.',
				extra || 'Use my shell prompt configuration as the model for what to show.',
				'The panel is part of the workbench, so implement it in the workbench sources rather than in a settings file.',
			].join(' '));
		},
	});

	registry.register({
		name: 'install-github-app',
		description: localize('cmcmd.installGithubApp', 'Set up the Claude GitHub app for this repository.'),
		execute: async (_args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			const remote = await git(ctx, 'remote', 'get-url', 'origin');
			const origin = succeeded(remote) ? remote.stdout.trim() : '';
			const choice = await ctx.pick('Set up the Claude GitHub app', [
				{ id: 'app', label: 'Install the GitHub app', description: LINKS.githubApp },
				{ id: 'workflows', label: 'Write the workflow files', description: '.github/workflows/claude.yml and claude-code-review.yml' },
				{ id: 'docs', label: 'Open the action documentation', description: LINKS.githubAction },
			]);
			if (!choice) {
				return;
			}
			if (choice === 'app') {
				await ctx.openExternal(LINKS.githubApp);
				ctx.appendSystemMessage([
					'Opened the GitHub app installation page.',
					origin ? `Install it on the repository behind ${origin}.` : 'Install it on this repository.',
					'',
					'Then add your Anthropic API key as the repository secret ANTHROPIC_API_KEY, and run /install-github-app again to write the workflows.',
				].join('\n'));
				return;
			}
			if (choice === 'docs') {
				await ctx.openExternal(LINKS.githubAction);
				ctx.appendSystemMessage(`Opened ${LINKS.githubAction}. Example workflow: ${LINKS.githubActionExample}`);
				return;
			}
			const written: string[] = [];
			for (const [path, contents] of [
				['.github/workflows/claude.yml', CLAUDE_WORKFLOW],
				['.github/workflows/claude-code-review.yml', CLAUDE_REVIEW_WORKFLOW],
			] as const) {
				const existing = await ctx.readTextFile(path);
				if (existing !== undefined) {
					ctx.appendSystemMessage(`${path} already exists — leaving it alone.`);
					continue;
				}
				const saved = await ctx.saveTextFile(path, contents);
				if (saved) {
					written.push(saved);
				}
			}
			ctx.appendSystemMessage(written.length
				? [
					`Wrote:\n${written.map(p => `  ${p}`).join('\n')}`,
					'',
					'Add your Anthropic API key as the repository secret ANTHROPIC_API_KEY, then commit and push the workflows.',
					`Install the app itself from ${LINKS.githubApp} if you have not already.`,
				].join('\n')
				: 'No workflow files were written.');
		},
	});

	registry.register({
		name: 'install-slack-app',
		description: localize('cmcmd.installSlackApp', 'Install the Claude Slack app.'),
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage('Opening Slack app installation page in browser…');
			try {
				await ctx.openExternal(LINKS.slackApp);
			} catch {
				ctx.appendSystemMessage(`Couldn't open browser. Visit: ${LINKS.slackApp}`);
			}
		},
	});

	registry.register({
		name: 'plugin',
		aliases: ['plugins', 'marketplace'],
		description: localize('cmcmd.plugin', 'List the installed plugins and marketplaces, and turn a plugin on or off.'),
		args: '[list|enable <id>|disable <id>|dir]',
		execute: async (args, ctx) => { await managePlugins(ctx, args.trim()); },
	});

	registry.register({
		name: 'reload-plugins',
		description: localize('cmcmd.reloadPlugins', 'Reload plugins, skills, agents and hooks for the next turn.'),
		execute: async (_args, ctx) => {
			// Every turn starts a fresh SDK query that re-reads the plugin, skill, agent
			// and hook directories, so there is nothing to invalidate here — this reports
			// what the next turn will pick up. It must NOT clear the session: that throws
			// away the resume id and with it the whole conversation.
			const [marketplaces, homeSkills, homeAgents] = await Promise.all([
				ctx.listHomeEntries('plugins/marketplaces'),
				ctx.listHomeEntries('skills'),
				ctx.listHomeEntries('agents'),
			]);
			// `listHomeEntries` returns bare names; `listDirectory` marks folders with a
			// trailing slash, which is how a project skill directory is told from a file.
			const projectSkills = ctx.workspaceRoot ? (await ctx.listDirectory('.claude/skills')).filter(name => name.endsWith('/')) : [];
			const projectAgents = ctx.workspaceRoot ? (await ctx.listDirectory('.claude/agents')).filter(name => name.endsWith('.md')) : [];
			ctx.appendSystemMessage([
				'Reloaded for the next turn:',
				`  ${marketplaces.length} marketplace(s) in ~/.claude/plugins/marketplaces`,
				`  ${homeSkills.length + projectSkills.length} skill(s) · ${homeAgents.filter(name => name.endsWith('.md')).length + projectAgents.length} agent(s)`,
				'',
				'The conversation is untouched — the next turn resumes it against the reloaded set.',
				'Run /doctor if something is still missing.',
			].join('\n'));
		},
	});

	registry.register({
		name: 'remote-env',
		description: localize('cmcmd.remoteEnv', 'Show where the agent runs.'),
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage([
				'The agent runs locally, in this editor, against your workspace:',
				'',
				`  Workspace  ${ctx.workspaceRoot || 'no folder open'}`,
				'  Engine     local utility process (Claude Agent SDK, in-process)',
				'',
				'There is no remote environment to configure. Use /add-dir to give the agent another folder.',
			].join('\n'));
		},
	});

}

// --- account, plan and external pages

/**
 * Open a page in the browser and report honestly if the shell refused.
 * `openExternal` rejects rather than silently doing nothing, so the fallback
 * message always shows a URL the user can copy.
 */
async function openLink(ctx: ICodeMindCommandContext, url: string, opening: string): Promise<void> {
	ctx.appendSystemMessage(opening);
	try {
		await ctx.openExternal(url);
	} catch {
		ctx.appendSystemMessage(`Couldn't open browser. Visit: ${url}`);
	}
}

/**
 * Split a markdown changelog into its `## <version>` sections, newest first.
 * Anything above the first version heading (the file's own title) is dropped.
 */
function changelogSections(markdown: string): { readonly version: string; readonly body: string }[] {
	const out: { version: string; body: string }[] = [];
	let current: { version: string; body: string[] } | undefined;
	for (const line of markdown.split(/\r?\n/)) {
		const heading = /^##\s+\[?v?([0-9][^\s\]]*)/.exec(line);
		if (heading) {
			if (current) {
				out.push({ version: current.version, body: current.body.join('\n').trim() });
			}
			current = { version: heading[1], body: [] };
			continue;
		}
		current?.body.push(line);
	}
	if (current) {
		out.push({ version: current.version, body: current.body.join('\n').trim() });
	}
	return out;
}

function registerAccountCommands(registry: CodeMindCommandRegistry): void {

	registry.register({
		name: 'upgrade',
		description: localize('cmcmd.upgrade', 'Upgrade to Max for higher rate limits and more Opus.'),
		// CodeMind authenticates with a console API key, so plan changes happen in the
		// console rather than here — the same reason the CLI hides this outside
		// claude.ai accounts.
		hidden: true,
		execute: async (_args, ctx) => {
			await openLink(ctx, LINKS.upgradeMax, 'Opening the plan upgrade page in your browser…');
		},
	});

	registry.register({
		name: 'extra-usage',
		description: localize('cmcmd.extraUsage', 'Configure extra usage to keep working when limits are hit.'),
		hidden: true,
		execute: async (_args, ctx) => {
			await openLink(ctx, LINKS.extraUsage, `Please visit ${LINKS.extraUsage} to manage extra usage.`);
		},
	});

	registry.register({
		name: 'rate-limit-options',
		description: localize('cmcmd.rateLimitOptions', 'Show what to do when a rate limit is reached.'),
		hidden: true,
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage([
				'When the API returns a rate-limit error:',
				'',
				'  · Wait for the window to reset and send the turn again.',
				'  · Switch to a smaller model for the next few turns: /model sonnet or /model haiku.',
				'  · Lower the per-turn work: /effort low, or /config to reduce Max turns.',
				`  · Raise your limits or add extra usage: ${LINKS.extraUsage}`,
			].join('\n'));
		},
	});

	registry.register({
		name: 'privacy-settings',
		description: localize('cmcmd.privacySettings', 'View and update your privacy settings.'),
		hidden: true,
		execute: async (_args, ctx) => {
			await openLink(ctx, LINKS.privacy, 'Opening your privacy settings in the browser…');
		},
	});

	registry.register({
		name: 'passes',
		description: localize('cmcmd.passes', 'Share a free week of Claude Code with friends.'),
		// Passes are issued to claude.ai subscriptions; an API-key install has none,
		// so this stays hidden exactly as the CLI hides it when ineligible.
		hidden: true,
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage('Passes are issued to claude.ai subscriptions. This build authenticates with a console API key, so there are none to share.');
		},
	});

	registry.register({
		name: 'chrome',
		description: localize('cmcmd.chrome', 'Claude in Chrome settings.'),
		hidden: true,
		execute: async (_args, ctx) => {
			const choice = await ctx.pick('Claude in Chrome', [
				{ id: 'setup', label: 'Open Claude in Chrome', description: LINKS.chrome },
				{ id: 'docs', label: 'Read the documentation', description: LINKS.chromeDocs },
			]);
			if (!choice) {
				return;
			}
			await openLink(ctx, choice === 'docs' ? LINKS.chromeDocs : LINKS.chrome, 'Opening the page in your browser…');
		},
	});

	registry.register({
		name: 'stickers',
		description: localize('cmcmd.stickers', 'Order Claude Code stickers.'),
		execute: async (_args, ctx) => {
			await openLink(ctx, LINKS.stickers, 'Opening sticker page in browser…');
		},
	});

	registry.register({
		name: 'release-notes',
		description: localize('cmcmd.releaseNotes', 'Show the engine changelog, newest first.'),
		args: '[version]',
		execute: async (args, ctx) => {
			const wanted = args.trim().replace(/^v/i, '');
			// The webview host cannot fetch cross-origin, so the changelog comes through
			// `gh api` on the node side, which needs gh installed and authenticated. The
			// raw Accept header returns the markdown rather than a base64 JSON blob.
			const fetched = await ctx.engineService.exec({
				command: 'gh',
				args: ['api', 'repos/anthropics/claude-code/contents/CHANGELOG.md', '-H', 'Accept: application/vnd.github.raw'],
				cwd: ctx.workspaceRoot || undefined,
				timeoutMs: 15000,
			});
			const sections = succeeded(fetched) ? changelogSections(fetched.stdout) : [];
			if (sections.length) {
				if (wanted) {
					const match = sections.find(s => s.version === wanted)
						?? sections.find(s => s.version.startsWith(wanted));
					ctx.appendSystemMessage(match
						? `## ${match.version}\n\n${clip(match.body, 8000)}`
						: `No changelog entry for ${wanted}. Available: ${sections.slice(0, 20).map(s => s.version).join(', ')}`);
					return;
				}
				ctx.appendSystemMessage([
					...sections.slice(0, 3).map(s => `## ${s.version}\n\n${clip(s.body, 3000)}`),
					`Full changelog: ${LINKS.changelog}`,
				].join('\n\n'));
				return;
			}

			// No gh, no auth, or a rate limit: fall back to what is provably local.
			const why = fetched.error
				? 'GitHub CLI (gh) is not on PATH'
				: `gh could not read the changelog (${clip((fetched.stderr || fetched.stdout).trim(), 200) || `exit ${fetched.exitCode}`})`;
			const log = ctx.workspaceRoot
				? await ctx.engineService.exec({
					command: 'git',
					args: ['log', '-n', '15', '--pretty=format:%h %ad %s', '--date=short'],
					cwd: ctx.workspaceRoot,
					timeoutMs: 8000,
				})
				: undefined;
			if (log && succeeded(log) && log.stdout.trim()) {
				ctx.appendSystemMessage([
					`${why}, so here is this workspace's own recent history instead:`,
					'',
					clip(log.stdout.trim(), 2000),
					'',
					`Claude Code's changelog: ${LINKS.changelog}`,
				].join('\n'));
				return;
			}
			ctx.appendSystemMessage(`${why}. Read the changelog at: ${LINKS.changelog}`);
		},
	});

	registry.register({
		name: 'feedback',
		aliases: ['bug'],
		description: localize('cmcmd.feedback', 'Write a feedback report you can file yourself.'),
		args: '[report]',
		execute: async (args, ctx) => {
			const report = args.trim();
			if (!report) {
				ctx.appendSystemMessage('Usage: /feedback <what went wrong or what you want>');
				return;
			}
			const recent = ctx.transcript().slice(-4).map(m => `${m.role}: ${clip(m.content, 800)}`).join('\n\n');
			// Written to a file the user chooses rather than uploaded: the transcript is
			// their code and their conversation, so sending it anywhere is their call.
			const contents = [
				'# CodeMind Agent feedback',
				'',
				`Reported: ${new Date().toISOString()}`,
				`Model: ${ctx.getModel()}`,
				`Permission mode: ${ctx.getPermissionMode()}`,
				`Plan mode: ${ctx.isPlanMode() ? 'on' : 'off'}`,
				`Workspace: ${ctx.workspaceRoot || '(none)'}`,
				'',
				'## Report',
				'',
				report,
				'',
				'## Recent conversation',
				'',
				recent || '(none)',
			].join('\n');
			const saved = await ctx.saveTextFile('codemind-feedback.md', contents);
			ctx.appendSystemMessage(saved
				? `Feedback report written to ${saved}. Nothing was uploaded — attach the file wherever you file the issue.`
				: 'Feedback report was not saved.');
		},
	});

}

// --- diagnostics

function registerDiagnosticCommands(registry: CodeMindCommandRegistry): void {

	registry.register({
		name: 'heapdump',
		description: localize('cmcmd.heapdump', 'Dump the engine JS heap to a file.'),
		hidden: true,
		execute: async (_args, ctx) => {
			ctx.appendSystemMessage('Writing a heap snapshot of the engine process — this can take a few seconds…');
			const result = await ctx.engineService.heapSnapshot();
			ctx.appendSystemMessage(result.path
				? `${result.path}\nOpen it in Chrome DevTools → Memory → Load.`
				: `Failed to create heap dump: ${result.error ?? 'unknown error'}`);
		},
	});

	registry.register({
		name: 'ultrareview',
		description: localize('cmcmd.ultrareview', 'Find and verify bugs across your branch (slow, thorough).'),
		args: '[base-branch]',
		execute: async (args, ctx) => {
			if (!requireWorkspace(ctx)) {
				return;
			}
			const requested = args.trim();
			const base = await detectBaseBranch(ctx, requested || undefined);
			if (!base) {
				ctx.appendSystemMessage('Could not work out the base branch. Pass one: /ultrareview <base-branch>.');
				return;
			}
			const range = `${base}...HEAD`;
			const stat = await git(ctx, 'diff', '--stat', range);
			if (!succeeded(stat)) {
				ctx.appendSystemMessage(`Could not diff against ${base}: ${failureText(stat)}`);
				return;
			}
			if (!stat.stdout.trim()) {
				ctx.appendSystemMessage(`No changes against ${base} — nothing to review.`);
				return;
			}
			ctx.appendSystemMessage([
				`Reviewing every change against ${base}. This is the thorough pass, so it takes a while.`,
				'',
				clip(stat.stdout.trim(), 1500),
			].join('\n'));
			ctx.sendToAgent([
				`Review every change in \`git diff ${range}\` for real defects.`,
				'Work file by file. For each candidate bug, verify it by reading the surrounding code and the callers before reporting it —',
				'discard anything you cannot show a concrete failure path for.',
				'Report what survives verification, most severe first, each with file:line, the failing scenario, and the fix.',
				'Do not change any files.',
			].join(' '));
		},
	});

}

