export interface RetrievedFact {
	id: string;
	projectId: string;
	content: string;
	score: number;
	category?: string;
}

export interface IProjectBrainRetriever {
	retrieve(req: any): Promise<RetrievedFact[]>;
	/** Optional: list the stored memories for a project (IF-11 read half). */
	list?(projectId: string): Promise<Array<{ id: string; category?: string; content: string; status?: string; sourceRef?: string }>>;
}

export interface ISegmentSink {
	ingest(segments: any[]): Promise<void>;
}

export async function executeProjectBrainOperation(
	input: { operation: string; query?: string; content?: string },
	projectId: string | undefined,
	retriever: IProjectBrainRetriever,
	sink: ISegmentSink
): Promise<{ type: 'text'; text: string }> {
	if (!projectId) {
		return { type: 'text', text: 'No active project' };
	}

	if (input.operation === 'recall') {
		const facts = await retriever.retrieve({ projectId, query: input.query || '', maxResults: 10 });
		const filtered = facts.filter(f => f.projectId === projectId);
		return { type: 'text', text: filtered.length ? JSON.stringify(filtered) : 'No results found.' };
	}

	if (input.operation === 'store') {
		if (!input.content) {
			return { type: 'text', text: 'Content is required for store operation.' };
		}
		
		await sink.ingest([{
			projectId,
			text: input.content,
			timestamp: Date.now(),
			role: 'assistant',
			intent: 'store'
		}]);
		
		return { type: 'text', text: 'Stored successfully.' };
	}

	if (input.operation === 'list') {
		if (typeof retriever.list === 'function') {
			const memories = await retriever.list(projectId);
			return { type: 'text', text: memories.length ? JSON.stringify(memories) : 'No memories stored for this project yet.' };
		}
		return { type: 'text', text: 'List operation not available.' };
	}

	return { type: 'text', text: 'Unknown operation.' };
}
