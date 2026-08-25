/*---------------------------------------------------------------------------------------------
 *  Phase-2 Orchestration Trace — Webview Host Panel
 *  Opens an editor tab that shows the per-layer input/output trace of the orchestration
 *  pipeline. Unlike the Multi-Agent Consensus window (which *runs* work), this panel is a
 *  passive display: the view pane feeds it traces via the static `pushTrace` sink.
 *--------------------------------------------------------------------------------------------*/

import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { IWebview } from '../../webview/browser/webview.js';
import { asWebviewUri } from '../../webview/common/webview.js';
import { FileAccess } from '../../../../base/common/network.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/** State the composer's 🐛 dev-mode toggle can mirror: is the trace window open. */
export interface TracePanelState {
	readonly open: boolean;
}

export class CodeMindOrchestrationTracePanel extends Disposable {
	private static readonly MEDIA_ROOT = 'vs/workbench/contrib/codemindAgent/browser/media/';

	/**
	 * A single shared instance, exactly like the consensus window — a second "open" reveals
	 * the existing tab rather than spawning a duplicate.
	 */
	private static _instance: CodeMindOrchestrationTracePanel | undefined;

	/**
	 * Recent traces survive across open/close so re-opening the window shows history rather
	 * than a blank page. Capped so a long session cannot grow this without bound.
	 */
	private static readonly _buffer: any[] = [];
	private static readonly MAX_BUFFER = 20;

	private static readonly _onDidChangeState = new Emitter<TracePanelState>();
	public static readonly onDidChangeState: Event<TracePanelState> = CodeMindOrchestrationTracePanel._onDidChangeState.event;

	public static get isOpen(): boolean { return !!CodeMindOrchestrationTracePanel._instance; }
	public static get state(): TracePanelState { return { open: !!CodeMindOrchestrationTracePanel._instance }; }

	/** Open the window, or reveal it if already open. */
	public static open(instantiationService: IInstantiationService): void {
		let inst = CodeMindOrchestrationTracePanel._instance;
		if (!inst) {
			inst = instantiationService.createInstance(CodeMindOrchestrationTracePanel);
			CodeMindOrchestrationTracePanel._instance = inst;
		}
		inst.show();
	}

	/** Close the window. Returns whether a close actually happened. */
	public static close(): boolean {
		const inst = CodeMindOrchestrationTracePanel._instance;
		if (!inst) {
			return false;
		}
		inst._closeEditorTab();
		return true;
	}

	/**
	 * The trace sink. Called from the view pane's engine-event listener whenever the worker
	 * emits an `orchestration_trace` (dev mode only). Buffers the trace and, if the window is
	 * open, renders it live. Safe to call when the window is closed — it just fills the buffer.
	 */
	public static pushTrace(trace: any): void {
		if (!trace) {
			return;
		}
		CodeMindOrchestrationTracePanel._buffer.push(trace);
		while (CodeMindOrchestrationTracePanel._buffer.length > CodeMindOrchestrationTracePanel.MAX_BUFFER) {
			CodeMindOrchestrationTracePanel._buffer.shift();
		}
		CodeMindOrchestrationTracePanel._instance?._post({ type: 'trace', payload: trace });
	}

	public static clearTraces(): void {
		CodeMindOrchestrationTracePanel._buffer.length = 0;
		CodeMindOrchestrationTracePanel._instance?._post({ type: 'clear' });
	}

	private static _fireState(): void {
		CodeMindOrchestrationTracePanel._onDidChangeState.fire(CodeMindOrchestrationTracePanel.state);
	}

	private _webviewPanel: any;

	constructor(
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this._register(toDisposable(() => {
			if (CodeMindOrchestrationTracePanel._instance === this) {
				CodeMindOrchestrationTracePanel._instance = undefined;
			}
			CodeMindOrchestrationTracePanel._fireState();
		}));
	}

	private _post(msg: any): void {
		try { this._webviewPanel?.webview?.postMessage(msg); } catch { /* webview gone */ }
	}

	public show() {
		if (this._webviewPanel) {
			this._webviewPanel.reveal();
			return;
		}

		this._webviewPanel = this.webviewWorkbenchService.openWebview(
			{
				title: 'Orchestration Trace',
				options: {
					retainContextWhenHidden: true,
					enableFindWidget: true
				},
				contentOptions: {
					allowScripts: true,
					localResourceRoots: [FileAccess.asFileUri(CodeMindOrchestrationTracePanel.MEDIA_ROOT)]
				},
				extension: undefined
			},
			'codemind.orchestrationTrace',
			'Orchestration Trace',
			undefined,
			{ preserveFocus: false }
		);

		this._register(toDisposable(() => {
			this._webviewPanel = undefined;
		}));

		// The tab can be closed directly by the user; tear down the singleton when it disposes.
		this._register(this._webviewPanel.onWillDispose(() => this.dispose()));

		const webview = this._webviewPanel.webview;
		webview.setHtml(this._getHtml(webview));

		this._register(webview.onMessage((e: any) => {
			const message = e.message;
			if (!message) { return; }
			if (message.type === 'ready') {
				// The script has loaded and is listening — replay the buffer (oldest first).
				// The renderer keys cards by queryId, so a replay never duplicates a live card.
				for (const trace of CodeMindOrchestrationTracePanel._buffer) {
					this._post({ type: 'trace', payload: trace });
				}
			} else if (message.type === 'clear') {
				CodeMindOrchestrationTracePanel.clearTraces();
			}
		}));

		CodeMindOrchestrationTracePanel._fireState();
	}

	/**
	 * Close the editor tab hosting this panel. Closing the input fires `onWillDispose`, which
	 * disposes this instance and resets the singleton — mirrors the consensus window so a later
	 * "open" gives a fresh tab rather than a duplicate.
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
		if (!closed) {
			this.dispose();
		}
	}

	private _getHtml(webview: IWebview): string {
		const cssUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindOrchestrationTracePanel.MEDIA_ROOT}trace.css`));
		const jsUri = asWebviewUri(FileAccess.asFileUri(`${CodeMindOrchestrationTracePanel.MEDIA_ROOT}trace.js`));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Orchestration Trace</title>
	<link rel="stylesheet" href="${cssUri.toString(true)}">
</head>
<body>
	<div id="root">
		<header class="trace-header">
			<div class="trace-brand">
				<span class="trace-mark" aria-hidden="true">
					<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="9" r="4"/><circle cx="5.5" cy="4.5" r="1.5"/><circle cx="10.5" cy="4.5" r="1.5"/><line x1="4" y1="9" x2="2" y2="9"/><line x1="12" y1="9" x2="14" y2="9"/></svg>
				</span>
				<div class="trace-brand-text">
					<h1>Orchestration Trace</h1>
					<p>Headroom compression, one card per turn — what went in, and whether the local proxy optimized it.</p>
				</div>
			</div>
			<button id="clearBtn" class="trace-clear" title="Clear all traces">Clear</button>
		</header>

		<div id="emptyState" class="trace-empty">
			<p>No traces captured yet.</p>
			<p class="trace-empty-hint">Enable 🐛 dev mode in the CodeMind chat header, then send a message — each turn shows its input and whether the local Headroom proxy compressed the request.</p>
		</div>

		<div id="traceList" class="trace-list"></div>
	</div>
	<script src="${jsUri.toString(true)}"></script>
</body>
</html>`;
	}
}
