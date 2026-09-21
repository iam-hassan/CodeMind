/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export interface TurnSummary {
	role: 'user' | 'assistant';
	content: string;
}

export interface RetrievalRequest {
	projectId: string;
	query: string;
	intent: string;
	openFiles: string[];
	recentTurns: TurnSummary[];
	maxResults: number;
	maxTokenBudget: number;
}

export interface RetrievedFact {
	id: string;
	content: string;
	score: number;             // [0,1] — used by injectionBlock token-budget drop policy
	category: 'decision' | 'pattern' | 'fact' | 'convention';
	sourceRef?: string;
	projectId: string;
}

export interface IProjectBrainRetriever {
	retrieve(req: RetrievalRequest): Promise<RetrievedFact[]>;
}

export class NullRetriever implements IProjectBrainRetriever {
	async retrieve(req: RetrievalRequest): Promise<RetrievedFact[]> {
		return [];
	}
}

export function buildRetrievalRequest(
	projectId: string,
	request: any,
	intent: string,
	sessionHistory: TurnSummary[],
	maxTokenBudget: number = 2000
): RetrievalRequest {
	const openFiles = (request.attachments ?? [])
		.map((f: any) => (typeof f === 'string' ? f : f.path ?? ''))
		.filter(Boolean);

	return {
		projectId,
		query: request.prompt,
		intent,
		openFiles,
		recentTurns: sessionHistory.slice(-3),
		maxResults: 8,
		maxTokenBudget
	};
}

export async function executeRetrieval(
	retriever: IProjectBrainRetriever,
	req: RetrievalRequest,
	timeoutMs: number = 800
): Promise<RetrievedFact[]> {
	try {
		return await Promise.race([
			retriever.retrieve(req),
			new Promise<RetrievedFact[]>((_, reject) => setTimeout(() => reject(new Error('Retrieval timeout')), timeoutMs))
		]);
	} catch (err) {
		return [];
	}
}
