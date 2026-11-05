/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Long-term reasoning layer (C1.7, P1-T13, spec §17, IF-8 → IF-9).
 *
 * Answers historical/causal natural-language questions from stored project knowledge, grounded in
 * the underlying fact/decision/event records and returned with citations (§17.6/§17.7). Nothing is
 * answered from model memory: when the decomposition finds no evidence the layer returns an explicit
 * insufficient-evidence result rather than fabricating an answer (§17.9/§24).
 *
 * The taxonomy and the decomposition algorithm are implementation decisions (spec §32):
 *
 *  - `current-state`        — "what are we currently using"
 *  - `causal`               — "why did we choose X"
 *  - `rejected-alternative` — "what was evaluated but not selected / when was X rejected"
 *  - `migration-timing`     — "when did we migrate from X to Y"
 *  - `chronological-listing`— "show all deployment decisions since …"
 *  - `general`              — anything else
 *
 * Unlike ordinary retrieval (§15/§16), which surfaces Active memories for prompt injection, the
 * reasoning path deliberately reaches historical (`archived`/`superseded`) records too, since
 * historical questions are precisely about non-current state (§11.4/§13.8).
 */

import { listDecisions, listEvents, type DecisionRecord, type EventRecord } from '../decisions/decisionMemory.js';
import type { EmbeddingClient } from '../embeddings/embedder.js';
import { searchFactsByVector } from '../embeddings/vectorStore.js';
import type { GraphNode, GraphRepository } from '../graph/graphRepo.js';
import type { DecisionStatus, MemoryVersionState } from '../ontology.js';
import { findFacts, getFact, type MemoryRecord, type ReadQueryable } from '../storage/read.js';

// --- public types ---------------------------------------------------------------------------

export type ReasoningQuestionType =
	| 'current-state'
	| 'causal'
	| 'rejected-alternative'
	| 'migration-timing'
	| 'chronological-listing'
	| 'general';

export type ReasoningSourceType = 'fact' | 'decision' | 'event';

export interface ReasoningQuery {
	readonly projectId: string;
	readonly question: string;
}

/** IF-8 — one citation to an underlying stored memory record. */
export interface ReasoningCitation {
	readonly sourceType: ReasoningSourceType;
	readonly id: string;
	readonly content: string;
	readonly sourceRef?: string;
	/** ISO timestamp of the decision/event, when dated. */
	readonly occurredAt?: string;
	/** Decision-only: the reason the choice was made. */
	readonly reason?: string;
	/** Decision-only: the alternatives text. */
	readonly alternatives?: string;
	/** Decision-only: the stored status vocabulary (§10.2). */
	readonly status?: string;
	/** Decision-only: rejected alternatives recovered from the `REJECTED` graph edges (§10.3). */
	readonly rejectedAlternatives?: readonly string[];
}

/** The plan produced by classifying + decomposing the question (§17.3/§17.4). */
export interface ReasoningPlan {
	readonly questionType: ReasoningQuestionType;
	readonly keywords: readonly string[];
	readonly topic: string;
	readonly includeDecisions: boolean;
	readonly includeEvents: boolean;
	readonly includeFacts: boolean;
	/** `active` for current-state lookups; `undefined` reaches historical state (§11.4). */
	readonly factStatus: MemoryVersionState | undefined;
	/** Bias the decision query to accepted records for current-state. */
	readonly decisionStatus: DecisionStatus | undefined;
	/** Follow `SUPERSEDES`/`REJECTED` chains from matched decisions (§17.4). */
	readonly followHistory: boolean;
	readonly useVector: boolean;
}

export type ReasoningAnswerStatus = 'answered' | 'insufficient-evidence';

/** IF-9 — a grounded answer with citations to the underlying memory records. */
export interface ReasoningAnswer {
	readonly projectId: string;
	readonly question: string;
	readonly status: ReasoningAnswerStatus;
	readonly answer: string;
	readonly citations: readonly ReasoningCitation[];
	readonly plan: ReasoningPlan;
}

/** Optional natural-language composer constrained to the retrieved evidence (§17.6). */
export type ReasoningComposer = (
	question: string,
	plan: ReasoningPlan,
	evidence: readonly ReasoningCitation[]
) => Promise<string>;

export interface ReasoningDeps {
	readonly read: ReadQueryable;
	readonly graph: GraphRepository;
	/** Optional — without it evidence gathering is keyword/graph-only rather than semantic. */
	readonly embedding?: EmbeddingClient;
	/** Optional grounding composer; when absent a deterministic template is used. */
	readonly composer?: ReasoningComposer;
}

export class ReasoningError extends Error {
	constructor(message: string, readonly code: 'invalid-project' | 'invalid-question') {
		super(message);
		this.name = 'ReasoningError';
	}
}

export const REASONING_INSUFFICIENT_MESSAGE =
	'I could not find enough stored project knowledge to answer this confidently, so no answer is given. Add or confirm the relevant decision/event and ask again (spec §17.9).';

// --- PLACEHOLDER bounds (spec §26/§32) ------------------------------------------------------

const DECISION_LIMIT = 5;
const EVENT_LIMIT = 10;
const FACT_LIMIT = 8;
const VECTOR_LIMIT = 8;
const FIND_FACTS_LIMIT = 50;

// --- classification -------------------------------------------------------------------------

const LIST_PATTERN = /\b(show|list)\s+(all|every)\b|\ball\s+(the\s+)?(decisions|events|changes)\b|\bsince\b/i;
const MIGRATION_PATTERN = /\b(migrat(e|ed|ion|ing)|switch(ed|ing)?\s+from|moved?\s+from)\b/i;
const REJECTED_PATTERN = /\b(reject(ed|ion)?|not selected|never selected|evaluated but|considered but|alternatives?|instead of|decided against)\b/i;
const CAUSAL_PATTERN = /\bwhy\b|\breason(s|ing)?\b|\bcause\b/i;
const CURRENT_PATTERN = /\bcurrent(ly)?\b|\bright now\b|\bare we (now )?using\b|\bwhat\b[^?]*\b(are|is)\b[^?]*\busing\b|\bwhich\b[^?]*\b(are|is)\b[^?]*\busing\b/i;

const STOPWORDS = new Set([
	'what', 'why', 'when', 'who', 'which', 'where', 'how', 'did', 'does', 'doing', 'done',
	'we', 'our', 'us', 'the', 'are', 'is', 'was', 'were', 'be', 'been', 'being', 'for', 'and',
	'but', 'or', 'of', 'to', 'in', 'on', 'at', 'from', 'with', 'use', 'uses', 'used', 'using',
	'choose', 'chosen', 'chose', 'have', 'has', 'had', 'will', 'would', 'should', 'could', 'can',
	'project', 'made', 'make', 'all', 'since', 'started', 'currently', 'current', 'right', 'now',
	'explain', 'tell', 'about', 'that', 'this', 'these', 'those', 'there', 'their', 'them',
	'they', 'it', 'its', 'into', 'not', 'explain', 'show', 'list', 'every',
	'decision', 'decisions', 'event', 'events', 'change', 'changes', 'changed',
	'evaluate', 'evaluated', 'select', 'selected', 'consider', 'considered',
	'suggest', 'suggested', 'reject', 'rejected', 'migrate', 'migrated', 'migration', 'migrating',
	'switch', 'switched', 'alternative', 'alternatives', 'reason', 'reasons', 'behind',
	'make', 'made', 'take', 'took', 'going', 'went', 'get', 'got'
]);

/** Classify a natural-language question into the taxonomy above (§17.3). */
export function classifyQuestion(question: string): ReasoningQuestionType {
	if (LIST_PATTERN.test(question)) {
		return 'chronological-listing';
	}
	if (MIGRATION_PATTERN.test(question)) {
		return 'migration-timing';
	}
	if (REJECTED_PATTERN.test(question)) {
		return 'rejected-alternative';
	}
	if (CAUSAL_PATTERN.test(question)) {
		return 'causal';
	}
	if (CURRENT_PATTERN.test(question)) {
		return 'current-state';
	}
	return 'general';
}

/** Significant topic terms (stopwords removed) used to match evidence and drive the vector query. */
export function extractKeywords(question: string): string[] {
	const seen = new Set<string>();
	const keywords: string[] = [];
	for (const token of question.toLowerCase().split(/[^a-z0-9]+/)) {
		if (token.length <= 2 || STOPWORDS.has(token) || seen.has(token)) {
			continue;
		}
		seen.add(token);
		keywords.push(token);
	}
	return keywords;
}

/** Decompose a classified question into the evidence sources to consult (§17.3/§17.4). */
export function planReasoning(question: string): ReasoningPlan {
	const questionType = classifyQuestion(question);
	const keywords = extractKeywords(question);
	const base = { questionType, keywords, topic: keywords.join(' ') };

	switch (questionType) {
		case 'current-state':
			return {
				...base,
				includeDecisions: true, includeEvents: false, includeFacts: true,
				factStatus: 'active', decisionStatus: 'accepted', followHistory: false, useVector: true
			};
		case 'causal':
		case 'rejected-alternative':
		case 'migration-timing':
			return {
				...base,
				includeDecisions: true, includeEvents: true, includeFacts: false,
				factStatus: undefined, decisionStatus: undefined, followHistory: true, useVector: true
			};
		case 'chronological-listing':
			return {
				...base,
				includeDecisions: true, includeEvents: true, includeFacts: false,
				factStatus: undefined, decisionStatus: undefined, followHistory: false, useVector: false
			};
		case 'general':
		default:
			return {
				...base,
				includeDecisions: true, includeEvents: true, includeFacts: true,
				factStatus: undefined, decisionStatus: undefined, followHistory: true, useVector: true
			};
	}
}

// --- matching helpers -----------------------------------------------------------------------

function requireProject(projectId: string | undefined): string {
	if (typeof projectId !== 'string' || projectId.trim().length === 0) {
		throw new ReasoningError('a non-empty projectId is required (spec §6.6/§17.8)', 'invalid-project');
	}
	return projectId;
}

function matchScore(keywords: readonly string[], text: string): number {
	if (keywords.length === 0) {
		return 0;
	}
	const haystack = text.toLowerCase();
	let hits = 0;
	for (const keyword of keywords) {
		if (haystack.includes(keyword)) {
			hits++;
		}
	}
	return hits;
}

function isoOrUndefined(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const time = new Date(value).getTime();
	return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function decisionCitation(record: DecisionRecord): ReasoningCitation {
	const detail = [record.reason, record.alternatives].filter((part): part is string => typeof part === 'string' && part.length > 0);
	return {
		sourceType: 'decision',
		id: record.id,
		content: detail.length > 0 ? `${record.decision} — ${detail.join('; ')}` : record.decision,
		sourceRef: record.sourceRef,
		occurredAt: isoOrUndefined(record.decidedAt),
		reason: record.reason,
		alternatives: record.alternatives,
		status: record.status
	};
}

function eventCitation(record: EventRecord): ReasoningCitation {
	return {
		sourceType: 'event',
		id: record.id,
		content: record.description,
		sourceRef: record.sourceRef,
		occurredAt: isoOrUndefined(record.occurredAt)
	};
}

function factCitation(record: MemoryRecord): ReasoningCitation {
	return {
		sourceType: 'fact',
		id: record.id,
		content: record.content,
		sourceRef: record.sourceRef
	};
}

function graphDecisionCitation(node: GraphNode): ReasoningCitation {
	const properties = node.properties;
	const decision = typeof properties.decision === 'string' ? properties.decision : node.id;
	const reason = typeof properties.reason === 'string' ? properties.reason : undefined;
	const alternatives = typeof properties.alternatives === 'string' ? properties.alternatives : undefined;
	const status = typeof properties.status === 'string' ? properties.status : undefined;
	const date = typeof properties.date === 'string' ? properties.date : undefined;
	const detail = [reason, alternatives].filter((part): part is string => typeof part === 'string' && part.length > 0);
	return {
		sourceType: 'decision',
		id: node.id,
		content: detail.length > 0 ? `${decision} — ${detail.join('; ')}` : decision,
		occurredAt: isoOrUndefined(date),
		reason,
		alternatives,
		status
	};
}

function rejectedName(node: GraphNode): string | undefined {
	const name = node.properties.name;
	return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function byDateAscending(a: ReasoningCitation, b: ReasoningCitation): number {
	const left = a.occurredAt ?? '';
	const right = b.occurredAt ?? '';
	return left < right ? -1 : left > right ? 1 : 0;
}

function mergeCitation(target: ReasoningCitation, incoming: ReasoningCitation): ReasoningCitation {
	return {
		...target,
		reason: target.reason ?? incoming.reason,
		alternatives: target.alternatives ?? incoming.alternatives,
		status: target.status ?? incoming.status,
		occurredAt: target.occurredAt ?? incoming.occurredAt,
		sourceRef: target.sourceRef ?? incoming.sourceRef,
		rejectedAlternatives: target.rejectedAlternatives ?? incoming.rejectedAlternatives
	};
}

// --- evidence gathering ---------------------------------------------------------------------

async function gatherDecisions(deps: ReasoningDeps, projectId: string, plan: ReasoningPlan): Promise<ReasoningCitation[]> {
	if (!plan.includeDecisions) {
		return [];
	}
	const decisions = await listDecisions(deps.read, projectId, plan.decisionStatus);
	const matched = decisions.filter(record => {
		if (plan.keywords.length === 0) {
			return true;
		}
		const text = [record.decision, record.reason, record.alternatives, record.author].filter((part): part is string => typeof part === 'string').join(' ');
		return matchScore(plan.keywords, text) > 0;
	});
	const ordered = matched
		.map(record => ({ record, score: matchScore(plan.keywords, [record.decision, record.reason, record.alternatives].filter((part): part is string => typeof part === 'string').join(' ')) }))
		.sort((a, b) => (b.score - a.score) || ((b.record.decidedAt ?? '').localeCompare(a.record.decidedAt ?? '')))
		.slice(0, DECISION_LIMIT)
		.map(entry => decisionCitation(entry.record));
	return ordered;
}

async function gatherEvents(deps: ReasoningDeps, projectId: string, plan: ReasoningPlan): Promise<ReasoningCitation[]> {
	if (!plan.includeEvents) {
		return [];
	}
	const events = await listEvents(deps.read, projectId, FIND_FACTS_LIMIT);
	const matched = events.filter(record => plan.keywords.length === 0 || matchScore(plan.keywords, `${record.description} ${record.eventType}`) > 0);
	return matched
		.map(eventCitation)
		.sort(byDateAscending)
		.slice(0, EVENT_LIMIT);
}

async function gatherFacts(deps: ReasoningDeps, projectId: string, plan: ReasoningPlan): Promise<ReasoningCitation[]> {
	if (!plan.includeFacts) {
		return [];
	}
	const options = plan.factStatus === undefined ? { limit: FIND_FACTS_LIMIT } : { status: plan.factStatus, limit: FIND_FACTS_LIMIT };
	const facts = await findFacts(deps.read, projectId, options);
	// Current-state is a broad snapshot of what the project "is" now (§11.4), so it keeps all
	// active facts (matched-first); every other question keeps only facts the topic matched.
	const relevant = plan.keywords.length === 0 || plan.questionType === 'current-state'
		? facts
		: facts.filter(record => matchScore(plan.keywords, record.content) > 0);
	const ordered = relevant
		.map(record => ({ record, score: matchScore(plan.keywords, record.content) }))
		.sort((a, b) => (b.score - a.score) || b.record.extractedAt.localeCompare(a.record.extractedAt))
		.slice(0, FACT_LIMIT)
		.map(entry => factCitation(entry.record));
	return ordered;
}

async function gatherVectorFacts(deps: ReasoningDeps, projectId: string, plan: ReasoningPlan, question: string): Promise<ReasoningCitation[]> {
	if (!plan.useVector || !deps.embedding || question.trim().length === 0) {
		return [];
	}
	let queryEmbedding: number[] | undefined;
	try {
		const [vector] = await deps.embedding.embed([question]);
		queryEmbedding = vector;
	} catch {
		return []; // §14.8/§24 — a vector failure degrades to the other evidence paths, never errors
	}
	if (!queryEmbedding || queryEmbedding.length === 0) {
		return [];
	}
	const matches = await searchFactsByVector(deps.read, projectId, queryEmbedding, VECTOR_LIMIT);
	const citations: ReasoningCitation[] = [];
	for (const match of matches) {
		const fact = await getFact(deps.read, projectId, match.ownerId);
		if (fact) {
			citations.push(factCitation(fact));
		}
	}
	return citations;
}

async function enrichWithHistory(deps: ReasoningDeps, projectId: string, decisions: ReasoningCitation[], byId: Map<string, ReasoningCitation>): Promise<void> {
	for (const citation of decisions) {
		let history: { chain: GraphNode[]; rejected: GraphNode[] };
		try {
			history = await deps.graph.history(projectId, citation.id);
		} catch {
			continue; // graph unavailable → keep the relational evidence (§24)
		}
		const rejected = history.rejected.map(rejectedName).filter((name): name is string => typeof name === 'string');
		if (rejected.length > 0) {
			const existing = byId.get(citation.id) ?? citation;
			byId.set(citation.id, { ...existing, rejectedAlternatives: [...new Set([...(existing.rejectedAlternatives ?? []), ...rejected])] });
		}
		for (const node of history.chain) {
			if (node.id === citation.id || byId.has(node.id)) {
				continue;
			}
			const chained = graphDecisionCitation(node);
			byId.set(chained.id, chained);
		}
	}
}

async function gatherEvidence(deps: ReasoningDeps, projectId: string, plan: ReasoningPlan, question: string): Promise<ReasoningCitation[]> {
	const byId = new Map<string, ReasoningCitation>();
	const add = (citation: ReasoningCitation): void => {
		const existing = byId.get(citation.id);
		byId.set(citation.id, existing ? mergeCitation(existing, citation) : citation);
	};

	const decisions = await gatherDecisions(deps, projectId, plan);
	for (const citation of decisions) {
		add(citation);
	}
	for (const citation of await gatherEvents(deps, projectId, plan)) {
		add(citation);
	}
	for (const citation of await gatherFacts(deps, projectId, plan)) {
		add(citation);
	}
	for (const citation of await gatherVectorFacts(deps, projectId, plan, question)) {
		add(citation);
	}
	if (plan.followHistory && decisions.length > 0) {
		await enrichWithHistory(deps, projectId, decisions, byId);
	}

	const citations = [...byId.values()];
	if (plan.questionType === 'chronological-listing' || plan.questionType === 'migration-timing') {
		return citations.sort(byDateAscending);
	}
	return citations;
}

// --- answer composition ---------------------------------------------------------------------

function citationMarker(index: number): string {
	return `[${index + 1}]`;
}

/** Compose a concise, grounded answer that cites the evidence by index (§17.6). */
function composeDeterministic(plan: ReasoningPlan, citations: readonly ReasoningCitation[]): string {
	const topic = plan.topic.length > 0 ? `"${plan.topic}"` : 'the question';
	const lines: string[] = [];

	const rejectedNames = citations.flatMap(citation => citation.rejectedAlternatives ?? []);
	const alternatives = citations.map(citation => citation.alternatives).filter((value): value is string => typeof value === 'string' && value.length > 0);

	switch (plan.questionType) {
		case 'current-state':
			lines.push(`Current state for ${topic}:`);
			citations.forEach((citation, index) => lines.push(`- ${citation.content} ${citationMarker(index)}`));
			break;
		case 'causal':
			lines.push(`Recorded reasoning for ${topic}:`);
			citations.forEach((citation, index) => {
				if (citation.sourceType === 'decision') {
					lines.push(`- ${citation.content} ${citationMarker(index)}`);
				} else {
					lines.push(`- ${citation.content} ${citationMarker(index)}`);
				}
			});
			break;
		case 'rejected-alternative': {
			lines.push(`Alternatives recorded for ${topic}:`);
			const names = [...new Set([...rejectedNames, ...alternatives.flatMap(value => value.split(/[,;]\s*/))])].filter(name => name.length > 0);
			if (names.length > 0) {
				lines.push(`- Evaluated but not selected: ${names.join(', ')}.`);
			}
			citations.forEach((citation, index) => lines.push(`- ${citation.content} ${citationMarker(index)}`));
			break;
		}
		case 'migration-timing':
			lines.push(`Recorded timeline for ${topic}:`);
			citations.forEach((citation, index) => {
				const when = citation.occurredAt !== undefined ? `${citation.occurredAt} — ` : '';
				lines.push(`- ${when}${citation.content} ${citationMarker(index)}`);
			});
			break;
		case 'chronological-listing':
			lines.push(`Chronological record for ${topic}:`);
			citations.forEach((citation, index) => {
				const when = citation.occurredAt !== undefined ? `${citation.occurredAt} — ` : '';
				lines.push(`- ${when}${citation.content} ${citationMarker(index)}`);
			});
			break;
		case 'general':
		default:
			lines.push(`Stored knowledge relevant to ${topic}:`);
			citations.forEach((citation, index) => lines.push(`- ${citation.content} ${citationMarker(index)}`));
			break;
	}

	lines.push(`Sources: ${citations.map((citation, index) => `${citationMarker(index)} ${citation.sourceType} ${citation.id}`).join('; ')}`);
	return lines.join('\n');
}

// --- public entry point ---------------------------------------------------------------------

/**
 * Answer an IF-8 historical question (§17). Project-scoped throughout (§17.8); returns an explicit
 * insufficient-evidence result rather than an unsupported answer (§17.9).
 */
export async function reason(deps: ReasoningDeps, query: ReasoningQuery): Promise<ReasoningAnswer> {
	const projectId = requireProject(query?.projectId);
	const question = typeof query.question === 'string' ? query.question.trim() : '';
	if (question.length === 0) {
		throw new ReasoningError('a non-empty question is required (spec §17.3)', 'invalid-question');
	}

	const plan = planReasoning(question);
	const citations = await gatherEvidence(deps, projectId, plan, question);

	if (citations.length === 0) {
		return {
			projectId,
			question,
			status: 'insufficient-evidence',
			answer: REASONING_INSUFFICIENT_MESSAGE,
			citations: [],
			plan
		};
	}

	let answer: string;
	if (deps.composer) {
		try {
			answer = (await deps.composer(question, plan, citations)).trim();
		} catch {
			answer = composeDeterministic(plan, citations); // a composer failure must not lose the grounded answer
		}
		if (answer.length === 0) {
			answer = composeDeterministic(plan, citations);
		}
	} else {
		answer = composeDeterministic(plan, citations);
	}

	return { projectId, question, status: 'answered', answer, citations, plan };
}
