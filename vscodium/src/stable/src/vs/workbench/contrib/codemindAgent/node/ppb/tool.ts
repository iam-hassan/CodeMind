/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `project_brain` agent tool (P1-T14 surface, spec §17/§18, IF-8/IF-9/IF-11).
 *
 * Exposes the Part 1 services to the agent as a single in-process MCP tool with the operations
 * `recall` (IF-5 → IF-6), `store` (IF-1 ingestion), `list` (IF-11 relational read) and `reason`
 * (IF-8 → IF-9). The engine supplies the SDK's `tool`/`createSdkMcpServer` factories and a zod
 * instance at runtime (they are resolved from the bundled SDK, not imported statically), so this
 * module stays free of any build-time SDK dependency.
 */

import type { GraphRepository } from './graph/graphRepo.js';
import type { ReasoningCitation, ReasoningPlan } from './reasoning/reasoner.js';
import { reason } from './reasoning/reasoner.js';
import type { PpbRetriever } from './retrieval/retriever.js';
import type { PpbSegmentSink } from './sink.js';
import { findFacts, type ReadQueryable } from './storage/read.js';

export interface ProjectBrainServices {
	readonly read: ReadQueryable;
	readonly graph: GraphRepository;
	readonly retriever: PpbRetriever;
	readonly sink: PpbSegmentSink;
}

/** The SDK `tool()` factory shape (resolved at runtime). */
export type McpToolFactory = (
	name: string,
	description: string,
	inputSchema: Record<string, unknown>,
	handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
) => unknown;

/** The minimal zod surface used for the tool schema. */
export interface ZodLike {
	enum(values: readonly string[]): unknown;
	string(): { optional(): unknown };
}

export interface RegisterProjectBrainOptions {
	readonly createMcpServer: (options: { name: string; version?: string; tools?: readonly unknown[] }) => unknown;
	readonly tool: McpToolFactory;
	readonly z: ZodLike;
	readonly services: ProjectBrainServices;
	readonly maxResults?: number;
}

function text(value: string): { content: Array<{ type: 'text'; text: string }> } {
	return { content: [{ type: 'text', text: value }] };
}

function json(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
	return text(JSON.stringify(value));
}

function requireProject(projectId: string | undefined): { content: Array<{ type: 'text'; text: string }> } | undefined {
	return projectId ? undefined : text('No active project.');
}

/** Build the in-process MCP server exposing `project_brain`. */
export function registerProjectBrainTool(options: RegisterProjectBrainOptions): unknown {
	const { services, z } = options;
	const maxResults = options.maxResults ?? 10;

	const projectBrain = options.tool(
		'project_brain',
		'CodeMind Project Brain: recall learned project knowledge (recall), store a new insight (store), list known memories (list), or answer a historical "why/when" question from stored decisions/events (reason).',
		{
			operation: z.enum(['recall', 'store', 'list', 'reason']),
			query: z.string().optional(),
			content: z.string().optional(),
			question: z.string().optional()
		},
		async (args) => {
			const projectId = process.env.CODEMIND_CURRENT_PROJECT_ID;
			const missing = requireProject(projectId);
			if (missing) {
				return missing;
			}
			const activeProject = projectId as string;
			const operation = String(args.operation ?? '');

			if (operation === 'recall') {
				const query = typeof args.query === 'string' ? args.query : '';
				const facts = await services.retriever.retrieve({ projectId: activeProject, query, intent: 'project_analysis', openFiles: [], recentTurns: [], maxResults, maxTokenBudget: 2000 } as never);
				return facts.length > 0 ? json(facts) : text('No results found.');
			}

			if (operation === 'store') {
				if (typeof args.content !== 'string' || args.content.length === 0) {
					return text('Content is required for the store operation.');
				}
				await services.sink.store({ projectId: activeProject, text: args.content });
				return text('Stored successfully.');
			}

			if (operation === 'list') {
				const facts = await findFacts(services.read, activeProject, { limit: 50 });
				return facts.length > 0
					? json(facts.map(fact => ({ id: fact.id, category: fact.category, content: fact.content, status: fact.status, sourceRef: fact.sourceRef })))
					: text('No memories stored for this project yet.');
			}

			if (operation === 'reason') {
				const question = typeof args.question === 'string' && args.question.length > 0 ? args.question : (typeof args.query === 'string' ? args.query : '');
				if (question.length === 0) {
					return text('A question is required for the reason operation.');
				}
				const answer = await reason({ read: services.read, graph: services.graph }, { projectId: activeProject, question });
				return json({
					status: answer.status,
					answer: answer.answer,
					citations: answer.citations.map((citation: ReasoningCitation) => ({ sourceType: citation.sourceType, id: citation.id, content: citation.content })),
					plan: { questionType: (answer.plan as ReasoningPlan).questionType }
				});
			}

			return text('Unknown operation.');
		}
	);

	return options.createMcpServer({ name: 'ppb', version: '1.0.0', tools: [projectBrain] });
}

// --- Part 2 bridge --------------------------------------------------------------------------
//
// The canonical agent-side `ProjectBrainTool` (claude-code) keeps module-level retriever/sink
// references that default to Null/Noop. Part 2 can register the live adapters here so any
// consumer in the same process can pick them up without importing Part 1 internals.

export interface RetrieverAdapter {
	retrieve(req: unknown): Promise<Array<{ id: string; projectId: string; content: string; score: number; category?: string }>>;
}

let _retrieverAdapter: RetrieverAdapter | undefined;

export function setProjectBrainRetrieverAdapter(adapter: RetrieverAdapter): void {
	_retrieverAdapter = adapter;
}

export function getProjectBrainRetrieverAdapter(): RetrieverAdapter | undefined {
	return _retrieverAdapter;
}