/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CodeMindAgentViewPane, CodeMindAgentViewIcon, CodeMindComposerFocusedContext } from './codeMindAgentViewPane.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { registerBuiltinCommands } from './codeMindCommands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

// --- identifiers

export const CODEMIND_AGENT_CONTAINER_ID = 'workbench.view.codemindAgent';
export const CODEMIND_AGENT_VIEW_ID = 'workbench.panel.codemindAgent';
export const CODEMIND_AGENT_OPEN_COMMAND_ID = 'workbench.action.openCodeMindAgent';

// --- configuration
//
// Every key the settings / MCP panels write through IConfigurationService must be
// declared here: `updateValue` rejects unregistered keys, which would make the
// panels appear to save while silently dropping the value.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'codemind',
	order: 100,
	title: localize('codeMindConfigurationTitle', "CodeMind Agent"),
	type: 'object',
	properties: {
		'codemind.baseUrl': {
			type: 'string',
			default: '',
			description: localize('codemind.baseUrl', "Anthropic-compatible endpoint the CodeMind Agent sends turns to, e.g. https://my-gateway.example.com. Do not include /v1. Empty uses the ANTHROPIC_BASE_URL environment variable, or the official API."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.model': {
			type: 'string',
			default: 'claude-opus-5',
			description: localize('codemind.model', "Model the CodeMind Agent uses for new turns. Accepts an alias (opus, sonnet, haiku, best, opusplan, opus[1m], sonnet[1m]) or a full model id such as claude-opus-5. Empty uses the account default."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.fallbackModel': {
			type: 'string',
			default: '',
			description: localize('codemind.fallbackModel', "Model to fall back to when the primary model is overloaded. Empty means no fallback."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.maxTurns': {
			type: 'number',
			default: 40,
			minimum: 1,
			maximum: 500,
			description: localize('codemind.maxTurns', "Maximum number of agent turns (tool round trips) per request."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.maxThinkingTokens': {
			type: 'number',
			default: 0,
			minimum: 0,
			description: localize('codemind.maxThinkingTokens', "Extended-thinking token budget. 0 leaves the engine default in place."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.systemPrompt': {
			type: 'string',
			default: '',
			description: localize('codemind.systemPrompt', "Extra instructions appended to the agent's own system prompt."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.permissionMode': {
			type: 'string',
			enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
			default: 'default',
			enumDescriptions: [
				localize('codemind.permissionMode.default', "Ask before running tools that change files or run commands."),
				localize('codemind.permissionMode.acceptEdits', "Auto-approve file edits, still ask for commands."),
				localize('codemind.permissionMode.bypassPermissions', "Never ask. Use only in disposable workspaces."),
				localize('codemind.permissionMode.plan', "Read-only: research and plan without changing anything."),
			],
			description: localize('codemind.permissionMode', "How the agent asks for permission before using tools."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.outputStyle': {
			type: 'string',
			enum: ['default', 'explanatory', 'concise', 'learning'],
			default: 'default',
			enumDescriptions: [
				localize('codemind.outputStyle.default', "Concise engineering answers."),
				localize('codemind.outputStyle.explanatory', "Adds the reasoning behind each step."),
				localize('codemind.outputStyle.concise', "Shortest correct answer, minimal prose."),
				localize('codemind.outputStyle.learning', "Teaches as it works, with small exercises."),
			],
			description: localize('codemind.outputStyle', "How the agent writes its answers."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.voiceMode': {
			type: 'boolean',
			default: false,
			description: localize('codemind.voiceMode', "Show the microphone button for voice input (requires engine voice support)."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.vimMode': {
			type: 'boolean',
			default: false,
			description: localize('codemind.vimMode', "Start the chat input in Vim normal mode."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.showOnStartup': {
			type: 'boolean',
			default: true,
			description: localize('codemind.showOnStartup', "Reveal the CodeMind Agent panel on the right on every launch."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.effort': {
			type: 'string',
			enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
			default: 'auto',
			enumDescriptions: [
				localize('codemind.effort.auto', "Let the model decide how long to think."),
				localize('codemind.effort.low', "Answer quickly, minimal deliberation."),
				localize('codemind.effort.medium', "Balanced thinking for everyday work."),
				localize('codemind.effort.high', "Think hard — slower, better on tricky problems."),
				localize('codemind.effort.xhigh', "Deeper than high. Newer models only."),
				localize('codemind.effort.max', "Think as long as the model is willing to."),
			],
			description: localize('codemind.effort', "How much reasoning the agent spends per turn. Models without the level you pick fall back to the closest one they support."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.fastMode': {
			type: 'boolean',
			default: false,
			description: localize('codemind.fastMode', "Ask for faster output from the same model. Ignored by models that do not offer it."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.advisorModel': {
			type: 'string',
			default: '',
			description: localize('codemind.advisorModel', "A second model the agent may consult for advice on hard turns. Empty means no advisor."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.sandbox': {
			type: 'object',
			default: {},
			description: localize('codemind.sandbox', "Sandbox settings for the commands the agent runs."),
			scope: ConfigurationScope.APPLICATION,
			properties: {
				enabled: { type: 'boolean', default: false, description: localize('codemind.sandbox.enabled', "Run the agent's commands with restricted filesystem and network access.") },
				autoAllowBashIfSandboxed: { type: 'boolean', default: false, description: localize('codemind.sandbox.autoAllow', "Skip the permission prompt for commands that run inside the sandbox.") },
				allowUnsandboxedCommands: { type: 'boolean', default: false, description: localize('codemind.sandbox.fallback', "Let a command that cannot be sandboxed run outside it, with a prompt.") },
				excludedCommands: { type: 'array', items: { type: 'string' }, default: [], description: localize('codemind.sandbox.excluded', "Command patterns that always run outside the sandbox.") },
			},
		},
		'codemind.coordinatorMode': {
			type: 'boolean',
			default: false,
			description: localize('codemind.coordinatorMode', "Orchestrate instead of editing: the agent delegates the work to subagents and synthesizes what they report. Also togglable with /coordinator."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.autoCompact': {
			type: 'boolean',
			default: true,
			description: localize('codemind.autoCompact', "Summarise the conversation automatically when it nearly fills the model's context window. Turning this off keeps /compact available but lets turns fail once the window is full."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.settingSources': {
			type: 'array',
			items: { type: 'string', enum: ['user', 'project', 'local'] },
			default: ['user', 'project', 'local'],
			description: localize('codemind.settingSources', "Which settings files the engine loads. 'project' is what makes CLAUDE.md, project hooks and project skills apply."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.disabledSkills': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('codemind.disabledSkills', "Names of skills the agent must not use."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.companion': {
			type: 'boolean',
			default: false,
			description: localize('codemind.companion', "Keep a small companion beside the composer. Run /buddy to hatch one; turning this off puts it to sleep without forgetting it."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.companionMuted': {
			type: 'boolean',
			default: false,
			description: localize('codemind.companionMuted', "Hide the companion and stop its remarks, keeping the creature itself. Also togglable with /buddy mute."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.companionSoul': {
			type: 'object',
			default: {},
			description: localize('codemind.companionSoul', "The companion's name and personality, written once when it hatched. /buddy manages this — editing it by hand only renames the creature, because its species, rarity and stats are derived from the seed."),
			scope: ConfigurationScope.APPLICATION,
			properties: {
				name: { type: 'string', description: localize('codemind.companionSoul.name', "What it is called.") },
				personality: { type: 'string', description: localize('codemind.companionSoul.personality', "One sentence describing how it behaves.") },
				hatchedAt: { type: 'number', description: localize('codemind.companionSoul.hatchedAt', "When it hatched, in milliseconds since the epoch.") },
				seed: { type: 'string', description: localize('codemind.companionSoul.seed', "What its species, rarity, eyes, hat and stats are derived from. Changing this replaces the creature.") },
			},
		},
		'codemind.mcpServers': {
			type: 'array',
			default: [],
			description: localize('codemind.mcpServers', "MCP servers the agent connects to."),
			scope: ConfigurationScope.APPLICATION,
			items: {
				type: 'object',
				required: ['name'],
				properties: {
					name: { type: 'string', description: localize('codemind.mcpServers.name', "Display name, also the tool namespace.") },
					type: { type: 'string', enum: ['stdio', 'sse', 'http'], default: 'stdio', description: localize('codemind.mcpServers.type', "Transport used to reach the server.") },
					command: { type: 'string', description: localize('codemind.mcpServers.command', "Executable to spawn for stdio servers.") },
					args: { type: 'array', items: { type: 'string' }, description: localize('codemind.mcpServers.args', "Arguments passed to the command.") },
					url: { type: 'string', description: localize('codemind.mcpServers.url', "Endpoint for sse / http servers.") },
					env: { type: 'object', additionalProperties: { type: 'string' }, description: localize('codemind.mcpServers.env', "Extra environment variables for stdio servers.") },
					enabled: { type: 'boolean', default: true, description: localize('codemind.mcpServers.enabled', "Whether the agent connects to this server.") },
				},
			},
		},
		'codemind.providers': {
			type: 'array',
			default: [],
			description: localize('codemind.providers', "Anthropic-compatible providers the CodeMind Agent can use. Each has an endpoint and the full set of models it serves; API keys are stored securely, not here."),
			scope: ConfigurationScope.APPLICATION,
			items: {
				type: 'object',
				required: ['id', 'name'],
				properties: {
					id: { type: 'string', description: localize('codemind.providers.id', "Stable identifier for the provider.") },
					name: { type: 'string', description: localize('codemind.providers.name', "Display name, e.g. Anthropic.") },
					baseUrl: { type: 'string', default: '', description: localize('codemind.providers.baseUrl', "Endpoint base URL. Do not include /v1. Empty uses the official API.") },
					models: { type: 'array', items: { type: 'string' }, default: [], description: localize('codemind.providers.models', "All model ids or aliases this provider serves, imported from its endpoint. Which of these appear in the composer picker is controlled by codemind.pickerModels.") },
					enabled: { type: 'boolean', default: true, description: localize('codemind.providers.enabled', "Whether this provider can be made active.") },
					wire: { type: 'string', enum: ['anthropic', 'openai'], description: localize('codemind.providers.wire', "Protocol the endpoint speaks, as detected by \"Fetch models\": anthropic (/v1/messages) or openai (/v1/chat/completions). Only anthropic endpoints can serve a conversation today.") },
				},
			},
		},
		'codemind.activeProviderId': {
			type: 'string',
			default: '',
			description: localize('codemind.activeProviderId', "Id of the provider whose endpoint, key and models are currently active."),
			scope: ConfigurationScope.APPLICATION,
		},
		'codemind.pickerModels': {
			type: 'array',
			default: [],
			description: localize('codemind.pickerModels', "Models shown in the composer model picker, each tied to the provider that serves it. Picking one makes that provider active. Empty falls back to the active provider's models."),
			scope: ConfigurationScope.APPLICATION,
			items: {
				type: 'object',
				required: ['providerId', 'model'],
				properties: {
					providerId: { type: 'string', description: localize('codemind.pickerModels.providerId', "Id of the provider that serves this model.") },
					model: { type: 'string', description: localize('codemind.pickerModels.model', "Model id or alias to show in the composer picker.") },
				},
			},
		},
	},
});

// --- view container + view (Secondary Side Bar = right side)

const containerIcon = CodeMindAgentViewIcon;

const VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: CODEMIND_AGENT_CONTAINER_ID,
	title: localize2('codeMindAgent', "CodeMind Agent"),
	icon: containerIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CODEMIND_AGENT_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: CODEMIND_AGENT_CONTAINER_ID,
	hideIfEmpty: false,
	order: 100,
}, ViewContainerLocation.AuxiliaryBar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: CODEMIND_AGENT_VIEW_ID,
	name: localize2('codeMindAgent', "CodeMind Agent"),
	containerIcon,
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(CodeMindAgentViewPane),
	openCommandActionDescriptor: {
		id: CODEMIND_AGENT_OPEN_COMMAND_ID,
		mnemonicTitle: localize('codeMindAgentMnemonic', "CodeMind Agent"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyM },
		order: 100,
	},
}], VIEW_CONTAINER);

// The open command + Ctrl+Alt+M keybinding + side-bar reveal is auto-registered
// by ViewsService from the view's `openCommandActionDescriptor` above. Do NOT
// also registerAction2 the same id — that throws "Cannot register two commands
// with the same id" during ViewsService construction and black-screens the workbench.

// --- composer keybinding shadows (Section 4.2)
//
// The webview host posts every keydown to the workbench and re-dispatches it into
// the keybinding service even when the webview called preventDefault, so the
// composer's readline chords would fire the workbench command too — Ctrl+W would
// close the window on its way to deleting a word, and Ctrl+K would open a chord
// prefix that swallows the next keystroke. These no-op rules take the chord while
// the composer holds focus and are inert everywhere else.
//
// Ctrl+A/C/V/X/Z are deliberately absent: select-all, clipboard and undo stay
// native in the composer, exactly as they are in a text box. Tab is absent too —
// it is the composer's completion key and never reaches the workbench.
//
// Ctrl+S is taken while the composer holds focus, so the draft stash gets the chord
// the CLI gives it. Nothing is being edited at that moment, so no save is lost;
// clicking back into an editor restores the usual binding.

/** Chords the composer owns, as `[id suffix, key code]`, bound with Ctrl on every platform. */
const COMPOSER_CTRL_CHORDS: readonly [string, KeyCode][] = [
	['b', KeyCode.KeyB], // back one character
	['d', KeyCode.KeyD], // delete the character ahead
	['e', KeyCode.KeyE], // end of line (Ctrl+X Ctrl+E: edit the prompt in an editor)
	['f', KeyCode.KeyF], // forward one character
	['g', KeyCode.KeyG], // abort the current chord, search or selection
	['h', KeyCode.KeyH], // backspace
	['k', KeyCode.KeyK], // kill to end of line
	['l', KeyCode.KeyL], // clear the transcript
	['n', KeyCode.KeyN], // next history entry
	['o', KeyCode.KeyO], // expand or collapse every transcript detail
	['p', KeyCode.KeyP], // previous history entry
	['r', KeyCode.KeyR], // reverse history search / vim redo
	['s', KeyCode.KeyS], // stash or restore the draft
	['t', KeyCode.KeyT], // toggle the tasks panel
	['u', KeyCode.KeyU], // kill to start of line
	['w', KeyCode.KeyW], // delete the word behind
	['y', KeyCode.KeyY], // yank the kill ring
];

/** The same, with Alt (the CLI's meta) for the word-wise variants and the pickers. */
const COMPOSER_ALT_CHORDS: readonly [string, KeyCode][] = [
	['b', KeyCode.KeyB], // back one word
	['d', KeyCode.KeyD], // delete the word ahead
	['f', KeyCode.KeyF], // forward one word
	['o', KeyCode.KeyO], // toggle fast mode
	['p', KeyCode.KeyP], // model picker
	['t', KeyCode.KeyT], // reasoning-effort picker
	['y', KeyCode.KeyY], // yank-pop
];

for (const [name, key] of COMPOSER_CTRL_CHORDS) {
	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: `codemind.composer.shadowCtrl.${name}`,
		weight: KeybindingWeight.WorkbenchContrib + 100,
		when: CodeMindComposerFocusedContext,
		primary: KeyMod.CtrlCmd | key,
		// The CLI's readline layer is Ctrl-based on macOS too, so shadow Ctrl there
		// rather than Cmd — Cmd+B still toggles the side bar from the composer.
		mac: { primary: KeyMod.WinCtrl | key },
		handler: () => { /* Consumed by the composer inside the webview. */ },
	});
}

for (const [name, key] of COMPOSER_ALT_CHORDS) {
	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: `codemind.composer.shadowAlt.${name}`,
		weight: KeybindingWeight.WorkbenchContrib + 100,
		when: CodeMindComposerFocusedContext,
		primary: KeyMod.Alt | key,
		handler: () => { /* Consumed by the composer inside the webview. */ },
	});
}

// Ctrl+_ — readline's undo, which a keyboard reports as Ctrl+Shift+Minus. Plain
// Ctrl+Minus is left alone on purpose: that is the window's zoom-out, and the
// composer offers Ctrl+X Ctrl+U for layouts where `_` is awkward to reach.
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'codemind.composer.shadowCtrl.undo',
	weight: KeybindingWeight.WorkbenchContrib + 100,
	when: CodeMindComposerFocusedContext,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Minus,
	mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Minus },
	handler: () => { /* Consumed by the composer inside the webview. */ },
});

// --- startup contribution: pin the agent to the right side on every launch

class ShowCodeMindAgentOnStartupContribution {

	static readonly ID = 'workbench.contrib.codemindAgent.showOnStartup';

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly viewsService: IViewsService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		if (configurationService.getValue<boolean>('codemind.showOnStartup') === false) {
			return;
		}
		// Show the Secondary Side Bar (right panel) idempotently, then open the
		// CodeMind Agent view. Runs on every launch so the panel is permanently
		// visible on the right by default.
		if (!this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		}
		this.viewsService.openView(CODEMIND_AGENT_VIEW_ID, false);
	}
}

registerWorkbenchContribution2(ShowCodeMindAgentOnStartupContribution.ID, ShowCodeMindAgentOnStartupContribution, WorkbenchPhase.AfterRestored);

// Register the slash command registry (Step 6). Runs once at module load.
registerBuiltinCommands();

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeMindConsensusPanel } from './codeMindConsensusPanel.js';

registerAction2(class OpenCodeMindConsensusAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openCodeMindConsensus',
			title: {
				value: localize('openCodeMindConsensus', 'Open Multi-Agent Consensus'),
				original: 'Open Multi-Agent Consensus'
			},
			f1: true
		});
	}

	run(accessor: ServicesAccessor): void {
		const instantiationService = accessor.get(IInstantiationService);
		CodeMindConsensusPanel.open(instantiationService);
	}
});

registerAction2(class CloseCodeMindConsensusAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.closeCodeMindConsensus',
			title: {
				value: localize('closeCodeMindConsensus', 'Close Multi-Agent Consensus'),
				original: 'Close Multi-Agent Consensus'
			},
			f1: false
		});
	}

	run(): void {
		// Refused while a run is in flight (see CodeMindConsensusPanel.close).
		CodeMindConsensusPanel.close();
	}
});

// Phase-2 dev-mode Orchestration Trace window — a separate editor tab (mirrors consensus)
// that displays the 7-layer pipeline trace instead of rendering it inside the chat bubble.
import { CodeMindOrchestrationTracePanel } from './codeMindOrchestrationTracePanel.js';

registerAction2(class OpenCodeMindTraceAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openCodeMindTrace',
			title: {
				value: localize('openCodeMindTrace', 'Open Orchestration Trace'),
				original: 'Open Orchestration Trace'
			},
			f1: true
		});
	}

	run(accessor: ServicesAccessor): void {
		const instantiationService = accessor.get(IInstantiationService);
		CodeMindOrchestrationTracePanel.open(instantiationService);
	}
});

registerAction2(class CloseCodeMindTraceAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.closeCodeMindTrace',
			title: {
				value: localize('closeCodeMindTrace', 'Close Orchestration Trace'),
				original: 'Close Orchestration Trace'
			},
			f1: false
		});
	}

	run(): void {
		CodeMindOrchestrationTracePanel.close();
	}
});

