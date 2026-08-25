/*---------------------------------------------------------------------------------------------
 *  LLM Consensus — OpenRouter Service
 *  Ported from LLM_consensus/LLM-Consensus/backend/src/services/openRouterService.ts
 *--------------------------------------------------------------------------------------------*/

import { LLM_MODELS, OPENROUTER_CONFIG, ModelConfig } from './models.js';
import { AgentAssignment, PromptStrategy } from './agentRouter.js';

export interface LLMResponse {
	modelId: string;
	displayName: string;
	answer: string;
	reasoning: string;
	confidence: number;
	processingTimeMs: number;
	strategy?: PromptStrategy;
	relevant?: boolean;
	error?: string;
}

export interface ModelCritique {
	sourceModelId: string;
	targetModel: string;
	critique: string;
	agreementScore: number;
	contradictions: string[];
	keyDisagreement?: string;
	suggestedMiddleGround?: string;
}

export type LLMRawResponse = LLMResponse;

export interface CritiqueResult {
	sourceModelId: string;
	critiques: ModelCritique[];
	revisedReasoning?: string;
	revisedConfidence: number;
}

let openRouterApiKey = OPENROUTER_CONFIG.apiKey;

export function setOpenRouterApiKey(key: string) {
	openRouterApiKey = key;
}

// Lightweight fetch wrapper instead of @openrouter/sdk to avoid heavy dependencies
async function fetchOpenRouter(modelId: string, messages: any[]) {
	if (!openRouterApiKey) {
		throw new Error('OpenRouter API Key not set');
	}

	const response = await fetch(`${OPENROUTER_CONFIG.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${openRouterApiKey}`,
			'HTTP-Referer': OPENROUTER_CONFIG.siteUrl,
			'X-Title': OPENROUTER_CONFIG.siteName,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: modelId,
			messages,
			temperature: 0.7
		})
	});

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`OpenRouter API error (${response.status}): ${errText}`);
	}

	return await response.json();
}

function buildSystemPrompt(strategy: PromptStrategy, isCreative = false, projectContext?: string): string {
	const baseFormat = `Respond ONLY in JSON:
{
  "answer": "Your final answer here",
  "reasoning": "A brief explanation of how you arrived at this answer",
  "confidence": 0.9,
  "relevant": true
}`;

	const scopeBlock = projectContext
		? `

PROJECT SCOPE (MANDATORY):
This consensus session belongs to the project below. You may ONLY answer questions that are directly about this project, its domain, its features or work that applies to it.

Project context:
${projectContext}

RULES:
- If the question is directly about this project or its domain, set "relevant" to true and answer it.
- If the question is unrelated (generic programming topics, general knowledge, anything outside this project's domain), set "relevant" to false and set "answer" to an empty string.
- Never answer an irrelevant question, even partially.`
		: '';

	const strategyInstructions: Partial<Record<PromptStrategy, string>> = {
		cot: 'Think step-by-step before answering.',
		self_consistency: 'Generate multiple possible paths to the answer internally, then select the most consistent one.',
		react: 'Use a Reason-Act observation loop before providing the final answer.',
		tot: 'Explore a tree of thoughts. Backtrack if a branch looks unpromising.',
		pot: 'Solve math problems by writing Python code in your reasoning.',
		chain_of_verification: 'Answer carefully, then verify your own claims before finalizing.',
	};
	const strategyInstruction = strategyInstructions[strategy] ?? 'Answer objectively and concisely.';

	return `You are a validator in a decentralized AI consensus network.
${strategyInstruction}${scopeBlock}
${baseFormat}`;
}

async function generateSingleResponse(
	model: ModelConfig,
	prompt: string,
	systemPrompt: string
): Promise<{ answer: string; reasoning: string; confidence: number }> {
	const completion = await fetchOpenRouter(model.openRouterId, [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: prompt }
	]);

	const content = completion.choices[0]?.message?.content || '';
	return parseLLMResponse(content);
}

export async function generateResponse(
	model: ModelConfig,
	prompt: string,
	strategy: PromptStrategy = 'cot',
	isCreative = false,
	selfConsistencyN = 5,
	memoryContext?: string,
	projectContext?: string
): Promise<LLMResponse> {
	const startTime = Date.now();

	const fullPrompt = memoryContext
		? `[Context from memory]\n${memoryContext}\n\n[User Question]\n${prompt}`
		: prompt;

	try {
		const systemPrompt = buildSystemPrompt(strategy, isCreative, projectContext);
		let answer: string;
		let reasoning: string;
		let confidence: number;

		if (strategy === 'self_consistency') {
			const samples = await Promise.all(
				Array.from({ length: selfConsistencyN }, () =>
					generateSingleResponse(model, fullPrompt, systemPrompt)
				)
			);

			const answerCounts = new Map<string, number>();
			for (const s of samples) {
				const normalized = s.answer.trim().toLowerCase().slice(0, 100);
				answerCounts.set(normalized, (answerCounts.get(normalized) || 0) + 1);
			}

			const [topAnswer] = [...answerCounts.entries()].sort((a, b) => b[1] - a[1]);
			const winner = samples.find(
				(s) => s.answer.trim().toLowerCase().startsWith(topAnswer[0].slice(0, 50))
			) || samples[0];

			answer = winner.answer;
			reasoning = `Self-Consistency (N=${selfConsistencyN}): majority of ${topAnswer[1]}/${selfConsistencyN} paths agree. ${winner.reasoning}`;
			confidence = winner.confidence;
		} else {
			const raw = await generateSingleResponse(model, fullPrompt, systemPrompt);
			answer = raw.answer;
			reasoning = raw.reasoning;
			confidence = raw.confidence;
		}

		return {
			modelId: model.id,
			displayName: model.displayName,
			answer,
			reasoning,
			confidence,
			processingTimeMs: Date.now() - startTime,
			strategy,
		};
	} catch (error: any) {
		console.error(`Error calling ${model.id}:`, error.message);
		throw new Error(`Model ${model.id} failed: ${error.message}`);
	}
}

export async function querySelectedModels(
	userPrompt: string,
	assignments: AgentAssignment[],
	memoryContext?: string,
	isCreative = false,
	projectContext?: string,
	onProgress?: (modelId: string, response: LLMRawResponse) => void
): Promise<LLMRawResponse[]> {
	const promises = assignments.map(async (assignment) => {
		try {
			const response = await generateResponse(
				assignment.model,
				userPrompt,
				assignment.strategy,
				isCreative,
				assignment.selfConsistencyN ?? 5,
				memoryContext,
				projectContext
			);
			if (onProgress) { onProgress(assignment.model.id, response); }
			return response;
		} catch (err: any) {
			const errResponse: LLMRawResponse = {
				modelId: assignment.model.id,
				displayName: assignment.model.displayName,
				answer: 'Error: ' + err.message,
				reasoning: 'Error generating response.',
				confidence: 0,
				processingTimeMs: 0,
				strategy: assignment.strategy,
				error: err.message,
			};
			if (onProgress) { onProgress(assignment.model.id, errResponse); }
			return errResponse;
		}
	});

	return Promise.all(promises);
}

export interface RelevanceCheck {
	relevant: boolean;
	reason: string;
}

/**
 * Pre-consensus gate: asks one model whether the user's question belongs to the
 * open project's domain. When no project context exists the gate is skipped by
 * the caller, and a failed check falls back to allowing the consensus.
 */
export async function checkRelevance(
	model: ModelConfig,
	userPrompt: string,
	projectContext: string
): Promise<RelevanceCheck> {
	const systemPrompt = `You decide whether a question is allowed in a consensus session that is strictly scoped to one project.

Project context:
${projectContext}

Rules:
- The question is allowed ONLY if it is directly about this project, its domain, its features or work that applies to it.
- Generic programming questions, general knowledge and any topic outside the project's domain are NOT allowed.

Respond ONLY in JSON:
{
  "relevant": true,
  "reason": "One short sentence saying why the question is or is not allowed"
}`;

	try {
		const completion = await fetchOpenRouter(model.openRouterId, [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt }
		]);
		const content = completion.choices[0]?.message?.content || '';
		const parsed = parseLLMResponse(content);
		return {
			relevant: parsed.relevant !== false,
			reason: parsed.answer || (parsed.relevant === false ? 'This question is not related to the open project.' : ''),
		};
	} catch (error: any) {
		console.error(`[Relevance] check failed for ${model.id}:`, error.message);
		return { relevant: true, reason: 'Relevance check failed, allowing consensus.' };
	}
}

export async function generateCritiques(
	model: ModelConfig,
	userPrompt: string,
	otherResponses: LLMResponse[]
): Promise<ModelCritique[]> {
	try {
		const systemPrompt = `You are a validator peer-reviewing other models. 
Compare your own logic against the provided answers.
Detect hallucinations, logic errors, or factual mistakes.
Output a JSON array of critiques:
[{
  "targetModel": "Model Name",
  "critique": "Your detailed evaluation",
  "agreementScore": 0.8,
  "contradictions": ["list any specific points of disagreement"],
  "keyDisagreement": "One sentence describing what you disagree on",
  "suggestedMiddleGround": "One sentence of what a consensus answer should say"
}]`;

		const peerData = otherResponses
			.map((r) => `${r.displayName}: ${r.answer}`)
			.join('\n\n');
		const userMsg = `Original Prompt: ${userPrompt}\n\nResponses to critique:\n${peerData}`;

		const completion = await fetchOpenRouter(model.openRouterId, [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userMsg }
		]);

		const content = completion.choices[0]?.message?.content || '';
		const critiques = parseCritiqueResponse(content);

		return critiques.map((c: any) => ({
			sourceModelId: model.id,
			targetModel: c.targetModel,
			critique: c.critique,
			agreementScore: c.agreementScore || 0.5,
			contradictions: c.contradictions || [],
			keyDisagreement: c.keyDisagreement || '',
			suggestedMiddleGround: c.suggestedMiddleGround || '',
		}));
	} catch (error: any) {
		console.error(`Critique error for ${model.id}:`, error.message);
		return [];
	}
}

export async function generateRevision(
	model: ModelConfig,
	userPrompt: string,
	originalAnswer: string,
	receivedCritiques: ModelCritique[],
	middleGrounds: string[]
): Promise<{ revisedAnswer: string; revisedReasoning: string; revisedConfidence: number }> {
	const critiqueLines = receivedCritiques
		.map((c) => `- Validator ${c.sourceModelId} (${Math.round(c.agreementScore * 100)}% agreement): "${c.critique}"`)
		.join('\n');

	const middleGroundLines = middleGrounds.length > 0
		? `\nSuggested middle ground positions:\n${middleGrounds.map((m) => `- ${m}`).join('\n')}`
		: '';

	const systemPrompt = `You are a validator in a decentralized AI consensus network.
Your original answer was critiqued by other validators. Revise your answer to move toward consensus.
If a critique correctly identifies a flaw, incorporate that correction.
Output your revised answer in JSON format:
{
  "answer": "Your revised answer",
  "reasoning": "Brief explanation of what changed and why",
  "confidence": 0.9
}`;

	const userMsg = `Original Prompt: ${userPrompt}

Your original answer was: "${originalAnswer}"

Received critiques:
${critiqueLines}
${middleGroundLines}

Revise your answer to move toward consensus.`;

	try {
		const completion = await fetchOpenRouter(model.openRouterId, [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userMsg }
		]);

		const content = completion.choices[0]?.message?.content || '';
		const parsed = parseLLMResponse(content);

		return {
			revisedAnswer: parsed.answer || originalAnswer,
			revisedReasoning: parsed.reasoning || 'Revised based on peer feedback.',
			revisedConfidence: parsed.confidence || 0.8,
		};
	} catch (error: any) {
		console.error(`Revision error for ${model.id}:`, error.message);
		return {
			revisedAnswer: originalAnswer,
			revisedReasoning: 'Revision failed, keeping original.',
			revisedConfidence: 0.5,
		};
	}
}

export interface RevisionResult {
	modelId: string;
	revisedAnswer: string;
	revisedReasoning: string;
	revisedConfidence: number;
}

export async function runCritiqueRound(
	userPrompt: string,
	currentResponses: LLMRawResponse[],
	onProgress?: (modelId: string, result: CritiqueResult) => void
): Promise<CritiqueResult[]> {
	const modelsToUse = currentResponses.map(
		(r) => LLM_MODELS.find((m) => m.id === r.modelId)
	).filter((m): m is ModelConfig => m !== undefined);

	const promises = modelsToUse.map(async (model) => {
		try {
			const otherResponses = currentResponses.filter((r) => r.modelId !== model.id);
			const critiques = await generateCritiques(model, userPrompt, otherResponses);

			const result: CritiqueResult = {
				sourceModelId: model.id,
				critiques,
				revisedConfidence: 0.8,
			};

			if (onProgress) { onProgress(model.id, result); }
			return result;
		} catch (err: any) {
			const result: CritiqueResult = {
				sourceModelId: model.id,
				critiques: [],
				revisedConfidence: 0.5,
			};
			if (onProgress) { onProgress(model.id, result); }
			return result;
		}
	});

	return Promise.all(promises);
}

export async function runRevisionRound(
	userPrompt: string,
	currentResponses: LLMRawResponse[],
	allCritiques: CritiqueResult[],
	middleGrounds: string[],
	onProgress?: (modelId: string, result: RevisionResult) => void
): Promise<RevisionResult[]> {
	const modelsToUse = currentResponses.map(
		(r) => LLM_MODELS.find((m) => m.id === r.modelId)
	).filter((m): m is ModelConfig => m !== undefined);

	const promises = modelsToUse.map(async (model) => {
		try {
			const originalResponse = currentResponses.find((r) => r.modelId === model.id);
			if (!originalResponse) {
				const fallback: RevisionResult = {
					modelId: model.id,
					revisedAnswer: '',
					revisedReasoning: 'No original response found.',
					revisedConfidence: 0.5,
				};
				if (onProgress) { onProgress(model.id, fallback); }
				return fallback;
			}

			const receivedCritiques: ModelCritique[] = [];
			for (const cr of allCritiques) {
				for (const c of cr.critiques) {
					if (c.targetModel === originalResponse.displayName) {
						receivedCritiques.push(c);
					}
				}
			}

			const revision = await generateRevision(
				model,
				userPrompt,
				originalResponse.answer,
				receivedCritiques,
				middleGrounds
			);

			const result: RevisionResult = {
				modelId: model.id,
				revisedAnswer: revision.revisedAnswer,
				revisedReasoning: revision.revisedReasoning,
				revisedConfidence: revision.revisedConfidence,
			};

			if (onProgress) { onProgress(model.id, result); }
			return result;
		} catch (err: any) {
			const result: RevisionResult = {
				modelId: model.id,
				revisedAnswer: currentResponses.find((r) => r.modelId === model.id)?.answer || '',
				revisedReasoning: 'Revision failed.',
				revisedConfidence: 0.5,
			};
			if (onProgress) { onProgress(model.id, result); }
			return result;
		}
	});

	return Promise.all(promises);
}

function parseLLMResponse(content: string) {
	try {
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		const jsonStr = jsonMatch ? jsonMatch[0] : content;
		const parsed = JSON.parse(jsonStr);

		const answer = parsed.answer !== undefined && parsed.answer !== null ? String(parsed.answer) : content;
		const reasoning = parsed.reasoning !== undefined && parsed.reasoning !== null ? String(parsed.reasoning) : 'No reasoning provided.';
		let confidence = 0.8;
		let relevant = true;

		if (parsed.confidence !== undefined && parsed.confidence !== null) {
			const confNum = Number(parsed.confidence);
			if (!isNaN(confNum)) {
				confidence = confNum;
			}
		}

		if (parsed.relevant !== undefined && parsed.relevant !== null) {
			relevant = String(parsed.relevant).toLowerCase() !== 'false';
		}

		if (confidence > 1) {
			if (confidence <= 100) {
				confidence = confidence / 100;
			} else {
				confidence = 1.0;
			}
		} else if (confidence < 0) {
			confidence = 0.0;
		}

		return { answer, reasoning, confidence, relevant };
	} catch {
		return {
			answer: content || '',
			reasoning: 'No reasoning provided.',
			confidence: 0.8,
			relevant: true,
		};
	}
}

function parseCritiqueResponse(content: string) {
	try {
		const jsonMatch = content.match(/\[[\s\S]*\]/);
		const jsonStr = jsonMatch ? jsonMatch[0] : content;
		return JSON.parse(jsonStr);
	} catch {
		return [];
	}
}
