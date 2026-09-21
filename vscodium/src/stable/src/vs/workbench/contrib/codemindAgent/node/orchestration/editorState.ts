/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/


export interface EditorState {
	cwd: string;
	openFiles: string[];
	workspaceConfig?: any;
	intent: string;
}

export interface TurnSummary {
	role: 'user' | 'assistant';
	content: string;
}

export function buildEditorState(request: any, intent: string): EditorState {
	const cwd = request.cwd ?? process.cwd();
	const openFiles = (request.attachments ?? [])
		.map((f: any) => (typeof f === 'string' ? f : f.path ?? ''))
		.filter(Boolean);

	return {
		cwd,
		openFiles,
		intent,
		workspaceConfig: {} // Placeholder for actual workspace config if needed
	};
}
