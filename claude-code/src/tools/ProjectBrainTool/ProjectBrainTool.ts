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

/**
 * A7 — the memory backend the engine exposes over loopback HTTP (see
 * `node/ppb/bridgeServer.ts`). The Claude Code CLI runs in a child process, so it cannot import the
 * live PPB stack; it reaches it through this bridge, which the engine advertises via
 * CODEMIND_PPB_BACKEND_URL / CODEMIND_PPB_BACKEND_TOKEN.
 */
export class HttpRetriever implements IProjectBrainRetriever {
	constructor(private readonly baseUrl: string, private readonly token: string) {}

	private async op(body: Record<string, unknown>): Promise<any> {
		const response = await fetch(`${this.baseUrl}/op`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
			body: JSON.stringify(body)
		});
		if (!response.ok) {
			throw new Error(`Project Brain bridge returned HTTP ${response.status}`);
		}
		return await response.json();
	}

	async retrieve(req: any): Promise<RetrievedFact[]> {
		const out = await this.op({ op: 'recall', projectId: req?.projectId, query: req?.query ?? '' });
		return Array.isArray(out?.facts) ? out.facts : [];
	}

	async list(projectId: string): Promise<Array<{ id: string; category?: string; content: string; status?: string; sourceRef?: string }>> {
		const out = await this.op({ op: 'list', projectId });
		return Array.isArray(out?.facts) ? out.facts : [];
	}
}

export class HttpSink implements ISegmentSink {
	constructor(private readonly baseUrl: string, private readonly token: string) {}

	async ingest(segments: any[]): Promise<void> {
		for (const segment of segments) {
			await fetch(`${this.baseUrl}/op`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
				body: JSON.stringify({ op: 'store', projectId: segment?.projectId, content: segment?.text })
			});
		}
	}
}

// These will be overridden by the bootstrap shim.
let _retriever: IProjectBrainRetriever = new NullRetriever();
let _sink: ISegmentSink = new NoopSegmentSink();
let _bootstrapped = false;

export function setRetriever(r: IProjectBrainRetriever) {
	_retriever = r;
}

export function setSink(s: ISegmentSink) {
	_sink = s;
}

/**
 * Wire the live backend from the environment the engine advertised. Idempotent; returns true when a
 * live backend is in place (or was already). Called by `bootstrapPPB()` at startup and lazily on the
 * first tool call, so the tool works even if the bootstrap hook never ran.
 */
export function bootstrapPPBFromEnv(): boolean {
	if (_bootstrapped) { return true; }
	const url = process.env.CODEMIND_PPB_BACKEND_URL;
	const token = process.env.CODEMIND_PPB_BACKEND_TOKEN;
	if (!url || !token) { return false; }
	_retriever = new HttpRetriever(url, token);
	_sink = new HttpSink(url, token);
	_bootstrapped = true;
	return true;
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
	isEnabled: () => process.env.CODEMIND_PPB_ENABLED !== '0',
	call: async (input: z.infer<typeof inputSchema>) => {
		// A7 — bind the live backend from env on first use (no-op if already bound or absent).
		bootstrapPPBFromEnv();
		const projectId = process.env.CODEMIND_CURRENT_PROJECT_ID;
		return executeProjectBrainOperation(input, projectId, _retriever, _sink);
	}
};
