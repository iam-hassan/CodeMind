/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import {
	CodeMindPermissionDecision,
	ICodeMindAccountInfo,
	ICodeMindAgentEngineService,
	ICodeMindCheckpoint,
	ICodeMindDoctorCheck,
	ICodeMindEndpointCheck,
	ICodeMindEngineEvent,
	ICodeMindEngineRequest,
	ICodeMindEngineResponse,
	ICodeMindEngineSettings,
	ICodeMindEngineCommandResult,
	ICodeMindEngineCommandInfo,
	ICodeMindExecRequest,
	ICodeMindExecResult,
	ICodeMindHeapSnapshotResult,
	ICodeMindMcpServer,
	ICodeMindModelInfo,
	ICodeMindPermissionAnswer,
	ICodeMindRewindResult,
	ICodeMindSessionUsage,
	ICodeMindShellRequest,
} from '../common/codeMindAgentEngineService.js';

/**
 * Renderer-side engine service interface implemented by the node-side utility
 * process worker. Methods and the `onEvent` event are marshalled over IPC.
 */
interface ICodeMindAgentEngineWorkerService {
	readonly onEvent: Event<{ queryId: string; event: ICodeMindEngineEvent }>;
	diagnose(apiKey: string | undefined): Promise<string | undefined>;
	validateApiKey(key: string, baseUrl?: string): Promise<ICodeMindEndpointCheck>;
	listEndpointModels(key?: string, baseUrl?: string): Promise<readonly ICodeMindModelInfo[]>;
	queryStream(queryId: string, request: ICodeMindEngineRequest, apiKey: string): Promise<ICodeMindEngineResponse>;
	cancelQuery(queryId: string): Promise<void>;
	respondToPermission(toolUseId: string, decision: CodeMindPermissionDecision, answer?: ICodeMindPermissionAnswer): Promise<void>;
	setModel(model: string): Promise<void>;
	updateSettings(settings: ICodeMindEngineSettings): Promise<void>;
	setMcpServers(servers: readonly ICodeMindMcpServer[]): Promise<void>;
	getMcpServers(): Promise<readonly ICodeMindMcpServer[]>;
	refreshMcpStatus(apiKey: string, cwd?: string): Promise<readonly ICodeMindMcpServer[]>;
	getAccountInfo(apiKey: string, cwd?: string): Promise<ICodeMindAccountInfo | undefined>;
	getSupportedModels(apiKey: string, cwd?: string): Promise<readonly ICodeMindModelInfo[]>;
	getEngineCommands(apiKey: string, cwd?: string): Promise<readonly ICodeMindEngineCommandInfo[]>;
	getCheckpoints(cwd?: string): Promise<readonly ICodeMindCheckpoint[]>;
	rewindFiles(apiKey: string, userMessageId: string, dryRun?: boolean, cwd?: string): Promise<ICodeMindRewindResult>;
	runEngineCommand(apiKey: string, command: string, cwd?: string, timeoutMs?: number): Promise<ICodeMindEngineCommandResult>;
	getSessionUsage(): Promise<ICodeMindSessionUsage | undefined>;
	getSessionCost(): Promise<{ totalCostUsd?: number } | undefined>;
	getSessionId(): Promise<string | undefined>;
	resumeSession(sessionId: string): Promise<void>;
	forkSession(): Promise<string | undefined>;
	clearSession(): Promise<void>;
	exec(request: ICodeMindExecRequest): Promise<ICodeMindExecResult>;
	execShell(request: ICodeMindShellRequest): Promise<ICodeMindExecResult>;
	doctor(): Promise<readonly ICodeMindDoctorCheck[]>;
	heapSnapshot(): Promise<ICodeMindHeapSnapshotResult>;
	getFeatureFlags(): Promise<Readonly<Record<string, boolean>>>;
}

/**
 * The worker's channel proxy, held inside a plain object.
 *
 * `ProxyChannel.toService` returns a `Proxy` that answers *every* string property with a
 * remote-call function — including `then`. That makes the proxy look like a thenable, so
 * `await proxy` (or returning it from an `async` function, which resolves it the same way)
 * makes the runtime call `then(resolve, reject)`: the two callbacks are arguments to an IPC
 * call and cannot cross the wire, so neither is ever invoked and the promise never settles.
 * Every await in this file therefore goes through this holder, never the proxy itself.
 */
interface ICodeMindEngineWorkerHandle {
	readonly service: ICodeMindAgentEngineWorkerService;
}

/**
 * Renderer-side implementation of {@link ICodeMindAgentEngineService}.
 *
 * Reads the Anthropic API key from secret storage, drives the node-side engine
 * worker over IPC, and re-emits streaming events. The actual Bun child process
 * lives in the utility process worker (the renderer is sandboxed and cannot spawn).
 */
class CodeMindAgentEngineService extends Disposable implements ICodeMindAgentEngineService {

	declare readonly _serviceBrand: undefined;

	private static readonly API_KEY_SECRET = 'codemind.anthropicApiKey';
	private static readonly WORKER_MODULE_ID = 'vs/workbench/contrib/codemindAgent/node/codeMindAgentEngineMain';

	private readonly _workerDisposables = this._register(new DisposableStore());
	private _worker: ICodeMindEngineWorkerHandle | undefined;
	private _workerPromise: Promise<ICodeMindEngineWorkerHandle> | undefined;
	private _apiKey: string | undefined | null = null; // null = not yet loaded

	private readonly _onEvent = this._register(new Emitter<{ queryId: string; event: ICodeMindEngineEvent }>());
	readonly onEvent: Event<{ queryId: string; event: ICodeMindEngineEvent }> = this._onEvent.event;

	private readonly _workerEventListener = this._register(new MutableDisposable<IDisposable>());

	constructor(
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IUtilityProcessWorkerWorkbenchService private readonly _utilityProcessWorkerWorkbenchService: IUtilityProcessWorkerWorkbenchService,
	) {
		super();
	}

	/**
	 * The one engine worker, created on first use.
	 *
	 * The cache holds the *promise*, not the resolved service: the panel fires several
	 * engine calls the moment it becomes ready, and a resolved-value cache lets all of
	 * them past the check while the first is still awaiting its message port. Each extra
	 * `createWorker` for the same module id makes the main process terminate the worker it
	 * already tracks — they hash to the same worker id — so the earlier callers are left
	 * holding a client whose process is gone, and their requests never settle. One shared
	 * promise means one worker and one client for everyone.
	 */
	private _getWorkerService(): Promise<ICodeMindEngineWorkerHandle> {
		const existing = this._workerPromise;
		if (existing) {
			return existing;
		}
		const created = this._createWorker();
		this._workerPromise = created;
		// A failed spawn must not poison the cache: drop it so the next call can retry.
		created.catch(() => {
			if (this._workerPromise === created) {
				this._workerPromise = undefined;
			}
		});
		return created;
	}

	private async _createWorker(): Promise<ICodeMindEngineWorkerHandle> {
		const { client } = this._workerDisposables.add(await this._utilityProcessWorkerWorkbenchService.createWorker({
			moduleId: CodeMindAgentEngineService.WORKER_MODULE_ID,
			type: 'codeMindAgentEngine',
			name: 'codemind-agent-engine',
		}));
		const channel = client.getChannel('codeMindAgentEngine');
		const service = ProxyChannel.toService<ICodeMindAgentEngineWorkerService>(channel);
		const handle: ICodeMindEngineWorkerHandle = { service };
		this._worker = handle;

		// Forward worker events to this service's emitter.
		this._workerEventListener.value = service.onEvent((e: { queryId: string; event: ICodeMindEngineEvent }) => this._onEvent.fire(e));

		return handle;
	}

	async diagnose(): Promise<string | undefined> {
		const apiKey = await this.getApiKey();
		const { service } = await this._getWorkerService();
		return service.diagnose(apiKey);
	}

	async storeApiKey(key: string): Promise<void> {
		await this._secretStorageService.set(CodeMindAgentEngineService.API_KEY_SECRET, key);
		this._apiKey = key;
	}

	async deleteApiKey(): Promise<void> {
		await this._secretStorageService.delete(CodeMindAgentEngineService.API_KEY_SECRET);
		this._apiKey = undefined;
	}

	async getApiKey(): Promise<string | undefined> {
		if (this._apiKey === null) {
			this._apiKey = await this._secretStorageService.get(CodeMindAgentEngineService.API_KEY_SECRET);
		}
		return this._apiKey ?? undefined;
	}

	get apiKeyState(): boolean | undefined {
		return this._apiKey === null ? undefined : !!this._apiKey;
	}

	async validateApiKey(key?: string, baseUrl?: string): Promise<ICodeMindEndpointCheck> {
		const endpoint = (baseUrl ?? '').trim().replace(/\/+$/, '');
		// The stored key is the fallback: the panel clears the field after saving, so
		// Validate with an empty field means "check what is saved".
		const candidate = key || await this.getApiKey();
		if (!candidate) {
			return { ok: false, detail: 'No key was given, and none is stored.', endpoint };
		}
		const { service: worker } = await this._getWorkerService();
		return worker.validateApiKey(candidate, baseUrl);
	}

	async listEndpointModels(key?: string, baseUrl?: string): Promise<readonly ICodeMindModelInfo[]> {
		const { service: worker } = await this._getWorkerService();
		// The stored key is the fallback, so the settings panel can list models without
		// re-typing a key it already saved.
		return worker.listEndpointModels(key || await this.getApiKey(), baseUrl);
	}

	async queryStream(queryId: string, request: ICodeMindEngineRequest, token: CancellationToken): Promise<ICodeMindEngineResponse> {
		const apiKey = await this.getApiKey();
		const { service } = await this._getWorkerService();
		const cwd = request.cwd ?? this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		// Forward cancellation to the node-side worker. The listener is disposed with the
		// query: `onCancellationRequested` hands back a disposable, and one left behind per
		// turn is reported as a leaked disposable in the renderer console.
		const cancelListener = token.onCancellationRequested(() => { service.cancelQuery(queryId).catch(() => { }); });
		try {
			return await service.queryStream(queryId, { ...request, cwd }, apiKey ?? '');
		} finally {
			cancelListener.dispose();
		}
	}

	async cancelQuery(queryId: string): Promise<void> {
		const worker = this._worker;
		if (worker) {
			await worker.service.cancelQuery(queryId);
		}
	}

	async respondToPermission(toolUseId: string, decision: CodeMindPermissionDecision, answer?: ICodeMindPermissionAnswer): Promise<void> {
		// No worker means no pending permission request — nothing to answer.
		const worker = this._worker;
		if (!worker) { return; }
		await worker.service.respondToPermission(toolUseId, decision, answer);
	}

	async setModel(model: string): Promise<void> {
		const { service: worker } = await this._getWorkerService();
		await worker.setModel(model);
	}

	async updateSettings(settings: ICodeMindEngineSettings): Promise<void> {
		const { service: worker } = await this._getWorkerService();
		await worker.updateSettings(settings);
	}

	async setMcpServers(servers: readonly ICodeMindMcpServer[]): Promise<void> {
		const { service: worker } = await this._getWorkerService();
		await worker.setMcpServers(servers);
	}

	async getMcpServers(): Promise<readonly ICodeMindMcpServer[]> {
		const { service: worker } = await this._getWorkerService();
		return worker.getMcpServers();
	}

	async refreshMcpStatus(): Promise<readonly ICodeMindMcpServer[]> {
		const { service: worker } = await this._getWorkerService();
		const apiKey = await this.getApiKey();
		return worker.refreshMcpStatus(apiKey ?? '', this._workspaceCwd());
	}

	async getAccountInfo(): Promise<ICodeMindAccountInfo | undefined> {
		const { service: worker } = await this._getWorkerService();
		const apiKey = await this.getApiKey();
		return worker.getAccountInfo(apiKey ?? '', this._workspaceCwd());
	}

	async getSupportedModels(): Promise<readonly ICodeMindModelInfo[]> {
		const { service: worker } = await this._getWorkerService();
		const apiKey = await this.getApiKey();
		return worker.getSupportedModels(apiKey ?? '', this._workspaceCwd());
	}

	async getEngineCommands(): Promise<readonly ICodeMindEngineCommandInfo[]> {
		const { service: worker } = await this._getWorkerService();
		const apiKey = await this.getApiKey();
		return worker.getEngineCommands(apiKey ?? '', this._workspaceCwd());
	}

	async getCheckpoints(): Promise<readonly ICodeMindCheckpoint[]> {
		const { service: worker } = await this._getWorkerService();
		return worker.getCheckpoints(this._workspaceCwd());
	}

	async rewindFiles(userMessageId: string, dryRun?: boolean): Promise<ICodeMindRewindResult> {
		const { service: worker } = await this._getWorkerService();
		const apiKey = await this.getApiKey();
		return worker.rewindFiles(apiKey ?? '', userMessageId, dryRun, this._workspaceCwd());
	}

	/** The folder the engine treats as the project — its session and checkpoint key. */
	private _workspaceCwd(): string | undefined {
		return this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
	}

	async getSessionCost(): Promise<{ totalCostUsd?: number } | undefined> {
		const { service: worker } = await this._getWorkerService();
		return worker.getSessionCost();
	}

	async runEngineCommand(command: string, timeoutMs?: number): Promise<ICodeMindEngineCommandResult> {
		const { service: worker } = await this._getWorkerService();
		const apiKey = await this.getApiKey();
		return worker.runEngineCommand(apiKey ?? '', command, this._workspaceCwd(), timeoutMs);
	}

	async getSessionUsage(): Promise<ICodeMindSessionUsage | undefined> {
		const { service: worker } = await this._getWorkerService();
		return worker.getSessionUsage();
	}

	async getSessionId(): Promise<string | undefined> {
		const { service: worker } = await this._getWorkerService();
		return worker.getSessionId();
	}

	async resumeSession(sessionId: string): Promise<void> {
		const { service: worker } = await this._getWorkerService();
		await worker.resumeSession(sessionId);
	}

	async forkSession(): Promise<string | undefined> {
		const { service: worker } = await this._getWorkerService();
		return worker.forkSession();
	}

	async clearSession(): Promise<void> {
		const { service: worker } = await this._getWorkerService();
		await worker.clearSession();
	}

	async exec(request: ICodeMindExecRequest): Promise<ICodeMindExecResult> {
		const { service: worker } = await this._getWorkerService();
		const cwd = request.cwd ?? this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		return worker.exec({ ...request, cwd });
	}

	async execShell(request: ICodeMindShellRequest): Promise<ICodeMindExecResult> {
		const { service: worker } = await this._getWorkerService();
		const cwd = request.cwd ?? this._workspaceCwd();
		return worker.execShell({ ...request, cwd });
	}

	async doctor(): Promise<readonly ICodeMindDoctorCheck[]> {
		const { service: worker } = await this._getWorkerService();
		const checks = await worker.doctor();
		const apiKey = await this.getApiKey();
		return [
			...checks,
			{ name: 'API key', ok: !!apiKey, detail: apiKey ? 'Stored in secret storage.' : 'Not set — use /login or the key button.' },
		];
	}

	async getFeatureFlags(): Promise<Readonly<Record<string, boolean>>> {
		const { service: worker } = await this._getWorkerService();
		return worker.getFeatureFlags();
	}

	async heapSnapshot(): Promise<ICodeMindHeapSnapshotResult> {
		const { service: worker } = await this._getWorkerService();
		return worker.heapSnapshot();
	}
}

registerSingleton(ICodeMindAgentEngineService, CodeMindAgentEngineService, InstantiationType.Delayed);
