import { z } from 'zod';

import {
	executeProjectBrainOperation,
	IProjectBrainRetriever,
	ISegmentSink,
	RetrievedFact
} from './ProjectBrainLogic.js';

export class NullRetriever implements IProjectBrainRetriever {
	async retrieve(req: any): Promise<RetrievedFact[]> {
		return [];
	}
}

export class NoopSegmentSink implements ISegmentSink {
	async ingest(segments: any[]): Promise<void> {
		// Drop segments intentionally.
	}
}

// These will be overridden by the bootstrap shim.
let _retriever: IProjectBrainRetriever = new NullRetriever();
let _sink: ISegmentSink = new NoopSegmentSink();

export function setRetriever(r: IProjectBrainRetriever) {
	_retriever = r;
}

export function setSink(s: ISegmentSink) {
	_sink = s;
}

const inputSchema = z.object({
	operation: z.enum(['recall', 'store', 'list']).describe('The operation to perform.'),
	query: z.string().optional().describe('Search query for recall operation.'),
	content: z.string().optional().describe('Information to save for store operation.'),
});

export const ProjectBrainTool = {
	name: 'ProjectBrain',
	description: 'Personalized Project Brain for long-term project context and memory. Use to recall learned project knowledge or store new important insights.',
	inputSchema,
	isEnabled: () => process.env.CODEMIND_PPB_ENABLED === '1',
	call: async (input: z.infer<typeof inputSchema>) => {
		const projectId = process.env.CODEMIND_CURRENT_PROJECT_ID;
		return executeProjectBrainOperation(input, projectId, _retriever, _sink);
	}
};
