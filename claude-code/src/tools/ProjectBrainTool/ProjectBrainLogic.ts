export interface RetrievedFact {
	id: string;
	projectId: string;
	content: string;
	score: number;
	category?: string;
}

export interface IProjectBrainRetriever {
	retrieve(req: any): Promise<RetrievedFact[]>;
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
		return { type: 'text', text: 'List operation not yet implemented.' };
	}

	return { type: 'text', text: 'Unknown operation.' };
}
