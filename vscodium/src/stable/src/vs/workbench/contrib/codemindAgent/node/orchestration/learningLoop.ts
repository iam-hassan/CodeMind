/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ISegmentSink } from './segmentQueue.js';

export interface BackfillOptions {
	scope: 'project' | 'dependency' | 'structure';
	changedPaths: string[];
	reason: string;
}

export function isDependencyFile(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith('package.json') ||
		lower.endsWith('package-lock.json') ||
		lower.endsWith('yarn.lock') ||
		lower.endsWith('pnpm-lock.yaml') ||
		lower.endsWith('requirements.txt') ||
		lower.endsWith('pipfile') ||
		lower.endsWith('pom.xml') ||
		lower.endsWith('build.gradle') ||
		lower.endsWith('go.mod') ||
		lower.endsWith('go.sum') ||
		lower.endsWith('cargo.toml');
}

export function isTopLevelStructureChange(path: string): boolean {
	const lower = path.toLowerCase();
	// heuristic: at most one slash after stripping leading /
	const clean = lower.replace(/^[/\\]+/, '');
	const slashCount = (clean.match(/[/\\]/g) || []).length;
	return slashCount <= 1;
}

export function detectRepoChanges(tools: any[]): { scope: 'dependency' | 'structure', changedPaths: string[] } | undefined {
	const fileTools = ['FileWrite', 'FileEdit', 'NotebookEdit'];
	const changedPaths: string[] = [];
	let hasDepChange = false;
	let hasStructChange = false;

	for (const tool of tools) {
		if (fileTools.includes(tool.name) && tool.inputJson) {
			try {
				const input = JSON.parse(tool.inputJson);
				// The tool input typically has a file_path, path, or notebook_path
				const p = input.file_path || input.path || input.notebook_path;
				if (p && typeof p === 'string') {
					changedPaths.push(p);
					if (isDependencyFile(p)) {
						hasDepChange = true;
					}
					if (isTopLevelStructureChange(p)) {
						hasStructChange = true;
					}
				}
			} catch (err) {
				// ignore parse errors
			}
		}
	}

	if (hasDepChange) {
		return { scope: 'dependency', changedPaths };
	}
	if (hasStructChange) {
		return { scope: 'structure', changedPaths };
	}
	return undefined;
}

export function triggerLearningLoop(
	result: { total_cost_usd?: number } | undefined,
	projectId: string,
	tools: any[],
	turnCount: number,
	sink: ISegmentSink
): void {
	try {
		if (turnCount === 1) {
			// First turn of a new project
			sink.scheduleBackfill?.(projectId, { scope: 'project', changedPaths: [], reason: 'First turn of new project' });
			return;
		}

		if (result?.total_cost_usd !== undefined && result.total_cost_usd > 0.01) {
			sink.scheduleBackfill?.(projectId, { scope: 'project', changedPaths: [], reason: `Cost exceeded 0.01 USD (${result.total_cost_usd})` });
			return;
		}

		if (turnCount > 0 && turnCount % 10 === 0) {
			sink.scheduleBackfill?.(projectId, { scope: 'project', changedPaths: [], reason: 'Periodic 10-turn backfill' });
			return;
		}

		const changes = detectRepoChanges(tools);
		if (changes) {
			sink.scheduleBackfill?.(projectId, {
				scope: changes.scope,
				changedPaths: changes.changedPaths,
				reason: `Detected ${changes.scope} file changes`
			});
		}
	} catch (err) {
		// Never throw or break the turn
	}
}
