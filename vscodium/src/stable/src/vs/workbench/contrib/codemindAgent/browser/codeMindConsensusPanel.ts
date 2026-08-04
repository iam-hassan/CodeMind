/*---------------------------------------------------------------------------------------------
 *  LLM Consensus — Webview Host Panel
 *  Opens a new IDE tab to display the Consensus Dashboard.
 *--------------------------------------------------------------------------------------------*/

import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { IWebview } from '../../webview/browser/webview.js';
import { asWebviewUri } from '../../webview/common/webview.js';
import { FileAccess } from '../../../../base/common/network.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ConsensusOrchestrator } from './consensus/consensusOrchestrator.js';
import { LLM_MODELS, fetchFreeModels } from './consensus/models.js';

export class CodeMindConsensusPanel extends Disposable {
	private static readonly MEDIA_ROOT = 'vs/workbench/contrib/codemindAgent/browser/media/';

	private _orchestrator: ConsensusOrchestrator;
	private _webviewPanel: any;
	private _fetchedModels: any[] = [];

	constructor(
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService
	) {
		super();
		this._orchestrator = new ConsensusOrchestrator();
	}

	public show() {
		if (this._webviewPanel) {
			this._webviewPanel.reveal();
			return;
		}

		this._webviewPanel = this.webviewWorkbenchService.openWebview(
			{
				title: 'CodeMind Consensus',
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
			'CodeMind Consensus',
			undefined,
			{ preserveFocus: false }
		);

		this._register(toDisposable(() => {
			this._webviewPanel = undefined;
		}));

		const webview = this._webviewPanel.webview;
		webview.setHtml(this._getHtml(webview));

		this._register(webview.onMessage(async (e: any) => {
			const message = e.message;
			if (message.type === 'start_consensus') {
				try {
					const selectedConfigs = this._fetchedModels.filter(m => message.payload.selectedModels.includes(m.id));
					await this._orchestrator.orchestrateConsensus(message.payload.prompt, Date.now().toString(), selectedConfigs);
				} catch (err: any) {
					webview.postMessage({ type: 'error', payload: err.message });
				}
			} else if (message.type === 'fetch_models') {
				try {
					this._fetchedModels = await fetchFreeModels();
					webview.postMessage({ type: 'models_loaded', payload: this._fetchedModels });
				} catch (err: any) {
					this._fetchedModels = LLM_MODELS;
					webview.postMessage({ type: 'models_loaded', payload: LLM_MODELS });
				}
			}
		}));

		this._register(this._orchestrator.onDidEmitEvent((event: any) => {
			webview.postMessage(event);
		}));
	}

	private _getHtml(webview: IWebview): string {
		const cssUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindConsensusPanel.MEDIA_ROOT}consensus.css`));
		const jsUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindConsensusPanel.MEDIA_ROOT}consensus.js`));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>CodeMind Consensus</title>
	<link rel="stylesheet" href="${cssUri.toString(true)}">
</head>
<body>
	<div id="root">
		<!-- Dashboard UI will be injected here by consensus.js -->
		<div class="consensus-container">
			<header class="header">
				<h1>Ask the Validator Network</h1>
				<p>Submit a complex query for multi-agent PBFT consensus</p>
			</header>

			<div class="input-area">
				<div class="model-selection">
					<h4>Select Models (Must be an odd number: 3, 5, or 7)</h4>
					<div id="modelCheckboxes" class="model-checkboxes"></div>
					<div id="modelSelectionError" class="error-text hidden">Please select an odd number of models (at least 3).</div>
				</div>
				<textarea id="promptInput" rows="4" placeholder="Enter a complex research question..."></textarea>
				<button id="submitBtn" class="btn-primary" disabled>Start Consensus</button>
			</div>

			<div class="status-banner hidden" id="statusBanner">
				<h3 id="currentPhase">Idle</h3>
				<p id="phaseMessage">Waiting for query...</p>
			</div>

			<div class="main-content hidden" id="mainContent">
				<div class="model-grid" id="modelGrid">
					<!-- Model cards generated dynamically -->
				</div>
				<div class="event-log-container">
					<h3>Event Stream</h3>
					<div id="eventLog" class="event-log"></div>
				</div>
			</div>
			
			<div class="final-result hidden" id="finalResult">
				<h3>Final Consensus Synthesis</h3>
				<div id="finalAnswer" class="final-answer"></div>
			</div>
		</div>
	</div>
	<script src="${jsUri.toString(true)}"></script>
</body>
</html>`;
	}
}
