/*---------------------------------------------------------------------------------------------
 *  LLM Consensus — Forced Consensus Engine
 *  Ported from LLM_consensus/LLM-Consensus/backend/src/services/forcedConsensus.ts
 *--------------------------------------------------------------------------------------------*/

import { LLMRawResponse, generateResponse } from './openRouterService.js';
import { PBFTState } from './consensusEngine.js';
import { LLM_MODELS, ModelConfig } from './models.js';

export interface ForcedConsensusResult {
	finalAnswer: string;
	consensusScore: number;
	weightedVotes: Record<string, number>;
	faultyModels: string[];
}

export async function runForcedConsensus(
	userPrompt: string,
	currentResponses: LLMRawResponse[],
	finalPBFTState: PBFTState,
	reputationScores: Record<string, number>,
	roundsCompleted: number,
	bestRoundAnswer?: string,
	bestRoundNumber?: number,
	bestRoundScore?: number,
	bestRoundMiddleGrounds?: string[],
	participants?: ModelConfig[]
): Promise<ForcedConsensusResult> {
	console.log('[Forced Consensus] Synthesizing final answer from weighted votes');

	const weightedVotes: Record<string, number> = {};
	let totalValidWeight = 0;

	for (const resp of currentResponses) {
		if (finalPBFTState.faultyNodes.includes(resp.modelId)) {
			weightedVotes[resp.modelId] = 0;
			continue;
		}
		const reputation = reputationScores[resp.modelId] || 1.0;
		const weight = resp.confidence * reputation;
		weightedVotes[resp.modelId] = weight;
		totalValidWeight += weight;
	}

	if (totalValidWeight > 0) {
		for (const modelId in weightedVotes) {
			weightedVotes[modelId] = weightedVotes[modelId] / totalValidWeight;
		}
	}

	const peakInfo = bestRoundNumber !== undefined && bestRoundScore !== undefined
		? `Peak: Round ${bestRoundNumber} at ${(bestRoundScore * 100).toFixed(1)}%`
		: '';

	let synthesizedAnswer = '';

	if (bestRoundMiddleGrounds && bestRoundMiddleGrounds.length > 0) {
		const middleGroundList = bestRoundMiddleGrounds.map((m, i) => `${i + 1}. ${m}`).join('\n');
		const synthesisPrompt = `Multiple AI validators debated this question: "${userPrompt}"

They proposed these middle ground positions:
${middleGroundList}

Write one final consensus answer that incorporates all these positions.
Be concise, balanced, and factual. Do not say "forced consensus" or mention the process.
Output only your answer, nothing else.`;

		try {
			// Synthesize with one of the models the user actually chose. Falling straight to
			// the built-in catalogue would send this call to OpenRouter even for a run made
			// up entirely of GUI-configured providers.
			const healthy = (participants ?? []).filter(
				m => !finalPBFTState.faultyNodes.includes(m.id)
			);
			const pool = healthy.length ? healthy : (participants ?? []);
			const synthesisModel = pool.find(m => m.id.includes('gpt-oss'))
				?? pool[0]
				?? LLM_MODELS.find(m => m.id.includes('gpt-oss'))
				?? LLM_MODELS[0];
			const result = await generateResponse(synthesisModel, synthesisPrompt);
			synthesizedAnswer = result.answer;
		} catch (err: any) {
			console.error('[Forced Consensus] Synthesis model failed, falling back:', err.message);
		}
	}

	const finalAnswerBase = synthesizedAnswer || bestRoundAnswer || '';
	const finalAnswer = finalAnswerBase
		? `[FORCED CONSENSUS SYNTHESIS (Threshold not met naturally. ${peakInfo})]\n\n${finalAnswerBase}`
		: 'Error: No valid models remaining to synthesize a forced consensus.';

	return {
		finalAnswer,
		consensusScore: finalPBFTState.consensusScore,
		weightedVotes,
		faultyModels: finalPBFTState.faultyNodes,
	};
}
