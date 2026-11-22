/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Brain bridge server (A7).
 *
 * The engine drives the Claude Agent SDK, which **spawns the Claude Code CLI as a child process**.
 * The canonical `ProjectBrainTool` (`claude-code/src/tools/ProjectBrainTool`) therefore runs in a
 * different process from the live PPB stack and cannot import it. This bridge exposes the four
 * memory operations (`recall` / `store` / `list` / `reason`) over a loopback-only HTTP endpoint,
 * authenticated with a per-process random token. The engine starts it once, passes the URL+token to
 * the child via env, and the child's `ProjectBrainTool` calls it — so every memory operation is
 * served by the live stack through the tool registered in `claude-code/src/tools`.
 *
 * Loopback + bearer token only; no external surface. All handlers are best-effort and never throw
 * to the caller beyond an HTTP error status.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import type { GraphRepository } from './graph/graphRepo.js';
import { findFacts, type ReadQueryable } from './storage/read.js';
import { reason } from './reasoning/reasoner.js';
import type { PpbRetriever } from './retrieval/retriever.js';
import type { PpbSegmentSink } from './sink.js';

export interface PpbBridgeServices {
	readonly read: ReadQueryable;
	readonly graph: GraphRepository;
	readonly retriever: PpbRetriever;
	readonly sink: PpbSegmentSink;
}

export interface PpbBridge {
	readonly url: string;
	readonly token: string;
	close(): Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('request body too large'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

function send(response: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
	response.end(body);
}

/** Start the loopback bridge. Resolves once the server is listening. */
export function startPpbBridge(services: PpbBridgeServices): Promise<PpbBridge> {
	const token = randomBytes(24).toString('hex');

	async function handleOperation(op: string, args: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
		const projectId = typeof args.projectId === 'string' ? args.projectId : '';
		if (!projectId) {
			return { status: 400, payload: { error: 'projectId is required' } };
		}
		switch (op) {
			case 'recall': {
				const query = typeof args.query === 'string' ? args.query : '';
				const facts = await services.retriever.retrieve({
					projectId, query, intent: 'project_analysis', openFiles: [], recentTurns: [], maxResults: 10, maxTokenBudget: 2000
				});
				return { status: 200, payload: { facts } };
			}
			case 'store': {
				const content = typeof args.content === 'string' ? args.content : '';
				if (!content) {
					return { status: 400, payload: { error: 'content is required for store' } };
				}
				await services.sink.store({ projectId, text: content });
				return { status: 200, payload: { stored: true } };
			}
			case 'list': {
				const facts = await findFacts(services.read, projectId, { limit: 50 });
				return { status: 200, payload: { facts: facts.map(f => ({ id: f.id, category: f.category, content: f.content, status: f.status, sourceRef: f.sourceRef })) } };
			}
			case 'reason': {
				const question = typeof args.question === 'string' ? args.question : '';
				if (!question) {
					return { status: 400, payload: { error: 'question is required for reason' } };
				}
				const answer = await reason({ read: services.read, graph: services.graph }, { projectId, question });
				return { status: 200, payload: { status: answer.status, answer: answer.answer, citations: answer.citations.map(c => ({ sourceType: c.sourceType, id: c.id, content: c.content })) } };
			}
			default:
				return { status: 400, payload: { error: `unknown operation: ${op}` } };
		}
	}

	const server: Server = createServer((request, response) => {
		void (async () => {
			try {
				if (request.method !== 'POST' || request.url !== '/op') {
					send(response, 404, { error: 'not found' });
					return;
				}
				const auth = String(request.headers['authorization'] ?? '');
				if (auth !== `Bearer ${token}`) {
					send(response, 401, { error: 'unauthorized' });
					return;
				}
				const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
				const result = await handleOperation(String(body.op ?? ''), body);
				send(response, result.status, result.payload);
			} catch (error) {
				send(response, 500, { error: String((error as Error)?.message ?? error).slice(0, 200) });
			}
		})();
	});

	return new Promise<PpbBridge>((resolve, reject) => {
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}`,
				token,
				close: () => new Promise<void>(done => server.close(() => done()))
			});
		});
	});
}
