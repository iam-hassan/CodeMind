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
	/** Provenance (D48). Surfaced into the injection block so "who decided X / when" is answerable. */
	author?: string;
	extractedAt?: string;
	/**
	 * D57: graph impact edges incident to this memory ("depends on X" / "required by Y"), each
	 * resolved to the related memory's content. Surfaced into the injection block so multi-hop
	 * impact questions ("what is affected if X changes?") are answerable — the markdown view has no
	 * edges to traverse at all.
	 */
	related?: Array<{ readonly type: string; readonly content: string }>;
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
