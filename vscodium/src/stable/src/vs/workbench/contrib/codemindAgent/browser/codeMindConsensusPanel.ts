/*---------------------------------------------------------------------------------------------
 *  Multi-Agent Consensus — Webview Host Panel
 *  Opens an editor tab hosting the CodeMind Multi-Agent Consensus experience.
 *--------------------------------------------------------------------------------------------*/

import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { IWebview } from '../../webview/browser/webview.js';
import { asWebviewUri } from '../../webview/common/webview.js';
import { FileAccess } from '../../../../base/common/network.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICodeMindAgentEngineService } from '../common/codeMindAgentEngineService.js';
import { ConsensusOrchestrator } from './consensus/consensusOrchestrator.js';
import { LLM_MODELS, fetchFreeModels, ModelConfig, toPublicModelInfo } from './consensus/models.js';

/** State the composer's Multi-Agent toggle mirrors: is the window open, and is a run in flight. */
export interface ConsensusPanelState {
	readonly open: boolean;
	readonly running: boolean;
}

export class CodeMindConsensusPanel extends Disposable {
	private static readonly MEDIA_ROOT = 'vs/workbench/contrib/codemindAgent/browser/media/';

	/**
	 * A single shared instance. The composer toggle opens and closes *this* window, so a
	 * second click must reveal the existing tab rather than spawn a duplicate. State
	 * changes (open/close/running) are broadcast so the composer can mirror them.
	 */
	private static _instance: CodeMindConsensusPanel | undefined;

	private static readonly _onDidChangeState = new Emitter<ConsensusPanelState>();
	public static readonly onDidChangeState: Event<ConsensusPanelState> = CodeMindConsensusPanel._onDidChangeState.event;

	public static get isOpen(): boolean { return !!CodeMindConsensusPanel._instance; }
	public static get isRunning(): boolean { return CodeMindConsensusPanel._instance?._running ?? false; }
	public static get state(): ConsensusPanelState {
		const inst = CodeMindConsensusPanel._instance;
		return { open: !!inst, running: inst?._running ?? false };
	}

	/** Open the window, or reveal it if already open. */
	public static open(instantiationService: IInstantiationService): void {
		let inst = CodeMindConsensusPanel._instance;
		if (!inst) {
			inst = instantiationService.createInstance(CodeMindConsensusPanel);
			CodeMindConsensusPanel._instance = inst;
		}
		inst.show();
	}

	/**
	 * Close the window. Refused while a run is in flight so an accidental toggle can't kill
	 * an in-progress consensus — the window can only be closed manually then. Returns
	 * whether the close actually happened.
	 */
	public static close(): boolean {
		const inst = CodeMindConsensusPanel._instance;
		if (!inst || inst._running) {
			return false;
		}
		inst._closeEditorTab();
		return true;
	}

	private static _fireState(): void {
		CodeMindConsensusPanel._onDidChangeState.fire(CodeMindConsensusPanel.state);
	}

	private _orchestrator: ConsensusOrchestrator;
	private _webviewPanel: any;
	/** Full participant configs, credentials included. Never posted to the webview as-is. */
	private _fetchedModels: ModelConfig[] = [];
	private _running = false;

	constructor(
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeMindAgentEngineService private readonly engineService: ICodeMindAgentEngineService
	) {
		super();
		this._orchestrator = new ConsensusOrchestrator();
		this._register(toDisposable(() => {
			if (CodeMindConsensusPanel._instance === this) {
				CodeMindConsensusPanel._instance = undefined;
			}
			this._running = false;
			CodeMindConsensusPanel._fireState();
		}));
	}

	public show() {
		if (this._webviewPanel) {
			this._webviewPanel.reveal();
			return;
		}

		this._webviewPanel = this.webviewWorkbenchService.openWebview(
			{
				title: 'Multi-Agent Consensus',
				options: {
					retainContextWhenHidden: true,
					enableFindWidget: true
				},
				contentOptions: {
					allowScripts: true,
					localResourceRoots: [FileAccess.asFileUri(CodeMindConsensusPanel.MEDIA_ROOT)]
				},
				extension: undefined
			},
			'codemind.consensus',
			'Multi-Agent Consensus',
			undefined,
			{ preserveFocus: false }
		);

		this._register(toDisposable(() => {
			this._webviewPanel = undefined;
		}));

		// The webview editor tab can be closed directly by the user. When it disposes,
		// tear down this instance so the singleton and the composer toggle reset.
		this._register(this._webviewPanel.onWillDispose(() => this.dispose()));

		const webview = this._webviewPanel.webview;
		webview.setHtml(this._getHtml(webview));

		this._register(webview.onMessage(async (e: any) => {
			const message = e.message;
			if (message.type === 'start_consensus') {
				this._running = true;
				CodeMindConsensusPanel._fireState();
				try {
					const selectedConfigs = this._fetchedModels.filter(m => message.payload.selectedModels.includes(m.id));
					const projectContext = await this._buildProjectContext();
					await this._orchestrator.orchestrateConsensus(message.payload.prompt, Date.now().toString(), selectedConfigs, projectContext);
				} catch (err: any) {
					this._running = false;
					CodeMindConsensusPanel._fireState();
					webview.postMessage({ type: 'error', payload: err.message });
				}
			} else if (message.type === 'fetch_models') {
				// GUI models are listed first: they are the user's own configured models, and
				// the webview pre-checks the leading entries.
				let guiModels: ModelConfig[] = [];
				try {
					guiModels = await this._buildGuiModels();
				} catch {
					guiModels = [];
				}
				try {
					const openRouterModels = await fetchFreeModels();
					this._fetchedModels = [...guiModels, ...openRouterModels];
				} catch {
					// Fall back to the built-in catalogue when the OpenRouter fetch fails.
					this._fetchedModels = [...guiModels, ...LLM_MODELS];
				}
				// Only identity and labels cross to the webview. `apiKey`/`baseUrl` stay in this
				// process — the keys live in secret storage and must never reach a webview.
				webview.postMessage({
					type: 'models_loaded',
					payload: this._fetchedModels.map(toPublicModelInfo)
				});
			}
		}));

		this._register(this._orchestrator.onDidEmitEvent((event: any) => {
			// A run ends on any of these — clear the running lock so the toggle can close
			// the window again.
			if (event.type === 'consensus_reached' || event.type === 'consensus_blocked' || event.type === 'error') {
				this._running = false;
				CodeMindConsensusPanel._fireState();
			}
			webview.postMessage(event);
		}));

		CodeMindConsensusPanel._fireState();
	}

	/**
	 * Close the editor tab hosting this panel. Closing the input fires its `onWillDispose`,
	 * which disposes this instance and resets the singleton and composer toggle — so a
	 * later "on" opens a fresh window rather than a duplicate. Just calling `dispose()`
	 * would leave the tab on screen, which is what caused the duplicate-window bug.
	 */
	private _closeEditorTab(): void {
		const input = this._webviewPanel;
		if (!input) {
			this.dispose();
			return;
		}
		let closed = false;
		for (const group of this.editorGroupsService.groups) {
			if (group.contains(input)) {
				void group.closeEditor(input);
				closed = true;
			}
		}
		// If the input was not found in any group, fall back to disposing directly.
		if (!closed) {
			this.dispose();
		}
	}

	/**
	 * Builds a short grounding document from the open workspace: folder name,
	 * README.md and package.json. This is what the consensus uses to decide
	 * whether a question belongs to the project.
	 */
	private async _buildProjectContext(): Promise<string> {
		try {
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (!folders.length) {
				return '';
			}
			const root = folders[0].uri;
			const parts: string[] = [`Project: ${folders[0].name}`];

			const readHead = async (path: URI, maxChars: number): Promise<string> => {
				try {
					const stat = await this.fileService.stat(path);
					if (stat.isDirectory || stat.size > 200_000) {
						return '';
					}
					const content = (await this.fileService.readFile(path)).value.toString();
					return content.slice(0, maxChars);
				} catch {
					return '';
				}
			};

			const readme = await readHead(URI.joinPath(root, 'README.md'), 2500);
			if (readme) {
				parts.push(`README:\n${readme}`);
			}

			const pkg = await readHead(URI.joinPath(root, 'package.json'), 1500);
			if (pkg) {
				parts.push(`package.json:\n${pkg}`);
			}

			const joined = parts.join('\n\n');
			return joined.length > 4000 ? joined.slice(0, 4000) : joined;
		} catch {
			return '';
		}
	}

	/**
	 * Builds model configs from GUI pickerModels. Each entry carries the provider's
	 * baseUrl, API key, and the model slug, so consensus calls route to the right
	 * endpoint with the right credentials.
	 */
	private async _buildGuiModels(): Promise<ModelConfig[]> {
		try {
			const providers = this.configurationService.getValue<any[]>('codemind.providers') || [];
			const pickerModels = this.configurationService.getValue<Array<{ providerId: string; model: string }>>('codemind.pickerModels') || [];
			const enabled = providers.filter(p => p.enabled !== false);
			const models: ModelConfig[] = [];
			for (const entry of pickerModels) {
				if (!entry || typeof entry.providerId !== 'string' || typeof entry.model !== 'string') {
					continue;
				}
				const provider = enabled.find(p => p.id === entry.providerId);
				if (!provider || !Array.isArray(provider.models) || !provider.models.includes(entry.model)) {
					continue; // stale or disabled
				}
				const baseUrl = String(provider.baseUrl || '').replace(/\/+$/, '');
				if (!baseUrl) { continue; }
				// A model with no stored key cannot be called, so it must not be offered.
				const apiKey = await this.engineService.getApiKey(entry.providerId).catch(() => '');
				if (!apiKey) { continue; }
				const providerName = provider.name || entry.providerId;
				models.push({
					id: `${entry.providerId}:${entry.model}`,
					displayName: `${entry.model} (${providerName})`,
					openRouterId: entry.model, // the provider's own model slug
					specialty: `via ${providerName}`,
					baseReputationScore: 1.0,
					baseUrl,
					apiKey,
					wire: provider.wire === 'anthropic' ? 'anthropic' : 'openai',
				});
			}
			return models;
		} catch {
			return [];
		}
	}

	private _getHtml(webview: IWebview): string {
		const cssUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindConsensusPanel.MEDIA_ROOT}consensus.css`));
		const jsUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindConsensusPanel.MEDIA_ROOT}consensus.js`));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Multi-Agent Consensus</title>
	<link rel="stylesheet" href="${cssUri.toString(true)}">
</head>
<body>
	<div id="root">
		<div class="consensus-container">
			<header class="header">
				<div class="brand">
					<span class="brand-mark" aria-hidden="true">
						<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="6" r="2.4"/><circle cx="5.5" cy="17" r="2.4"/><circle cx="18.5" cy="17" r="2.4"/><path d="M12 8.4L6.6 14.8M12 8.4l5.4 6.4M7.9 17h8.2"/></svg>
					</span>
					<div class="brand-text">
						<h1>Multi-Agent Consensus</h1>
						<p>Several AI models answer independently, critique each other, and converge on one vetted result.</p>
					</div>
				</div>
			</header>

			<div class="input-area">
				<div class="model-selection">
					<h4>Choose participating models <span class="hint">(pick 3, 5, or 7)</span></h4>
					<div id="modelCheckboxes" class="model-checkboxes"></div>
					<div id="modelSelectionError" class="error-text hidden">Please select an odd number of models (3, 5, or 7).</div>
				</div>
				<textarea id="promptInput" rows="4" placeholder="Ask a question for the models to deliberate on…"></textarea>
				<button id="submitBtn" class="btn-primary" disabled>
					<span class="btn-label">Start deliberation</span>
				</button>
			</div>

			<div class="status-banner hidden" id="statusBanner">
				<div class="status-dot" aria-hidden="true"></div>
				<div class="status-text">
					<h3 id="currentPhase">Ready</h3>
					<p id="phaseMessage">Waiting for your question…</p>
				</div>
			</div>

			<div class="main-content hidden" id="mainContent">
				<div class="model-grid" id="modelGrid">
					<!-- Model cards generated dynamically -->
				</div>
				<div class="event-log-container">
					<h3>Deliberation</h3>
					<div id="eventLog" class="event-log"></div>
				</div>
			</div>

			<div class="final-result hidden" id="finalResult">
				<h3>Agreed answer</h3>
				<div id="finalAnswer" class="final-answer"></div>
			</div>
		</div>
	</div>
	<script src="${jsUri.toString(true)}"></script>
</body>
</html>`;
	}
}
