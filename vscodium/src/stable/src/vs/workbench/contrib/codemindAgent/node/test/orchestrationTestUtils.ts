/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
	ToolAdapter, ToolOutput, OrchestrationRequest, SelectionContext,
	AggregatedContext, IntentClassification, DeveloperIntent, ToolAdapterRegistry, Capability,
} from '../orchestration/types.js';
import { CANONICAL_ADAPTER_CAPABILITIES } from '../orchestration/capabilities.js';
import { projectBrainAdapter } from '../orchestration/toolAdapters/projectBrainAdapter.js';

/** CancellationToken stub — never cancelled, no-op disposable. */
export function makeToken(): any {
	return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) };
}

/** OrchestrationRequest builder with sane defaults + a unique workspace/query id. */
export function makeRequest(overrides: Partial<OrchestrationRequest> = {}): OrchestrationRequest {
	const rnd = Math.random().toString(36).slice(2);
	return {
		queryId: 'q-' + rnd,
		userPrompt: 'do something meaningful with the codebase here',
		openFiles: [],
		workspaceFolder: '/virtual/ws-' + rnd,
		sessionHistory: [],
		isFollowUp: false,
		model: 'claude',
		token: makeToken(),
		...overrides,
	};
}

export function makeSelectionContext(overrides: Partial<SelectionContext> = {}): SelectionContext {
	return {
		hasOpenFiles: false,
		workspaceFolder: '/virtual/ws',
		promptLength: 40,
		hasImageAttachments: false,
		isFollowUp: false,
		...overrides,
	};
}

export function makeIntent(intent: DeveloperIntent, confidence = 0.9, signals: string[] = ['sig']): IntentClassification {
	return { intent, confidence, signals };
}

/** A fake adapter that resolves instantly with the given partial ToolOutput merged in. */
export function makeFakeAdapter(
	id: string,
	output: Partial<ToolOutput> = {},
	shouldRun: (i: IntentClassification, c: SelectionContext) => boolean = () => true,
	capabilities: Capability[] = CANONICAL_ADAPTER_CAPABILITIES[id] ?? [],
): ToolAdapter {
	return {
		id,
		name: id,
		// Capability-based selection reads adapter.capabilities. Fakes keyed by a
		// real id inherit that id's canonical capabilities so selection against a
		// fake registry behaves exactly like against the real one.
		capabilities,
		async execute(): Promise<ToolOutput> {
			return { adapterId: id, status: 'success', durationMs: 0, outputSummary: '', outputTokenEstimate: 0, ...output };
		},
		shouldRun,
	};
}

/** A fake adapter whose execute() never resolves — used to exercise the timeout path. */
export function makeHangingAdapter(id: string, timeoutMs: number): ToolAdapter {
	return {
		id,
		name: id,
		TIMEOUT_MS: timeoutMs,
		capabilities: CANONICAL_ADAPTER_CAPABILITIES[id] ?? [],
		execute(): Promise<ToolOutput> { return new Promise<ToolOutput>(() => { /* never resolves */ }); },
		shouldRun: () => true,
	};
}

/** A fake adapter whose execute() throws — used to exercise the error path. */
export function makeThrowingAdapter(id: string, message = 'boom'): ToolAdapter {
	return {
		id,
		name: id,
		capabilities: CANONICAL_ADAPTER_CAPABILITIES[id] ?? [],
		async execute(): Promise<ToolOutput> { throw new Error(message); },
		shouldRun: () => true,
	};
}

export function fakeRegistry(adapters: ToolAdapter[]): ToolAdapterRegistry {
	const m = new Map<string, ToolAdapter>();
	for (const a of adapters) { m.set(a.id, a); }
	return m;
}

/**
 * A registry used by the selection tests. The six "shadow adapters" were removed from the
 * product (Layer 3 now observes the real Claude Agent SDK tool stream), so the only real
 * adapter left is projectBrain. The other six are represented by canonical FAKES: capability
 * selection reads `adapter.capabilities`, so a fake keyed by a real id with that id's
 * canonical capabilities makes the selector behave exactly as it did against the real
 * adapters. fileContext keeps its real veto (needs an open file) so the gating tests hold.
 */
export function realRegistry(): ToolAdapterRegistry {
	return fakeRegistry([
		projectBrainAdapter,
		makeFakeAdapter('repositoryAdapter'),
		makeFakeAdapter('dependencyAdapter'),
		makeFakeAdapter('fileContextAdapter', {}, (_i, c) => c.hasOpenFiles),
		makeFakeAdapter('gitAdapter'),
		makeFakeAdapter('webSearchAdapter'),
		makeFakeAdapter('terminalAdapter'),
	]);
}

/** An empty AggregatedContext, optionally overridden — for optimizer/aggregator tests. */
export function emptyAggregated(overrides: Partial<AggregatedContext> = {}): AggregatedContext {
	return {
		projectBrain: null,
		repository: null,
		currentFiles: [],
		dependencies: null,
		gitState: null,
		webResults: [],
		terminalContext: null,
		collectionDurationMs: 0,
		toolsExecuted: [],
		toolsFailed: [],
		...overrides,
	};
}

/** Create a throwaway workspace dir with the given files; returns its absolute path. */
export async function makeTempWorkspace(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cmorch-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, content, 'utf8');
	}
	return dir;
}

export async function rmWorkspace(dir: string | undefined): Promise<void> {
	if (!dir) { return; }
	try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

