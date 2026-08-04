/*---------------------------------------------------------------------------------------------
 *  LLM Consensus — Consensus Engine Core
 *  Ported from LLM_consensus/LLM-Consensus/backend/src/services/consensusEngine.ts
 *--------------------------------------------------------------------------------------------*/

import { LLMRawResponse, CritiqueResult } from './openRouterService.js';


const MAX_WEIGHT_FRACTION = 0.30;

export interface HallucinationResult {
	modelId: string;
	isHallucinating: boolean;
	details: string;
	severity: 'none' | 'mild' | 'moderate' | 'severe';
	score: number;
}

function cosineSimilarity(textA: string, textB: string): number {
	const tokenize = (text: string): Map<string, number> => {
		const words = text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, '')
			.split(/\s+/)
			.filter((w) => w.length > 2);

		const freq = new Map<string, number>();
		for (const word of words) {
			freq.set(word, (freq.get(word) || 0) + 1);
		}
		return freq;
	};

	const vecA = tokenize(textA);
	const vecB = tokenize(textB);

	const allWords = new Set([...vecA.keys(), ...vecB.keys()]);
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (const word of allWords) {
		const a = vecA.get(word) || 0;
		const b = vecB.get(word) || 0;
		dotProduct += a * b;
		normA += a * a;
		normB += b * b;
	}

	if (normA === 0 || normB === 0) { return 0; }
	return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function detectHallucinations(
	responses: LLMRawResponse[]
): HallucinationResult[] {
	const validResponses = responses.filter((r) => !r.error);

	if (validResponses.length === 0) {
		return responses.map((r) => ({
			modelId: r.modelId,
			isHallucinating: false,
			details: 'No valid responses to compare',
			severity: 'none',
			score: 0,
		}));
	}

	const avgConfidence =
		validResponses.reduce((sum, r) => sum + r.confidence, 0) /
		validResponses.length;

	const similarityMatrix: Map<string, number[]> = new Map();
	for (const resp of validResponses) {
		const sims: number[] = [];
		for (const other of validResponses) {
			if (other.modelId === resp.modelId) { continue; }
			const sim = cosineSimilarity(
				resp.answer + ' ' + resp.reasoning,
				other.answer + ' ' + other.reasoning
			);
			sims.push(sim);
		}
		similarityMatrix.set(resp.modelId, sims);
	}

	const avgGroupSimilarity = (modelId: string): number => {
		const sims = similarityMatrix.get(modelId) || [];
		if (sims.length === 0) { return 0; }
		return sims.reduce((a, b) => a + b, 0) / sims.length;
	};

	let totalGroupSim = 0;
	let groupCount = 0;
	for (const [, sims] of similarityMatrix) {
		for (const s of sims) {
			totalGroupSim += s;
			groupCount++;
		}
	}
	const overallAvgSim = groupCount > 0 ? totalGroupSim / groupCount : 0;

	return responses.map((resp) => {
		if (resp.error || resp.confidence === 0) {
			return {
				modelId: resp.modelId,
				isHallucinating: true,
				details: `API error or zero confidence: ${resp.error || 'zero confidence'}`,
				severity: 'severe',
				score: 1.0,
			};
		}

		const reasons: string[] = [];
		let hallucinationScore = 0;

		const confidenceDev = Math.abs(resp.confidence - avgConfidence);
		if (confidenceDev > 0.35) {
			reasons.push(
				`Confidence deviation ${(confidenceDev * 100).toFixed(0)}% from group mean`
			);
			hallucinationScore += 0.25;
		}

		const modelSim = avgGroupSimilarity(resp.modelId);
		const simDeviation = overallAvgSim - modelSim;
		if (simDeviation > 0.2) {
			reasons.push(
				`Semantic similarity ${(modelSim * 100).toFixed(0)}% vs group avg ${(overallAvgSim * 100).toFixed(0)}%`
			);
			hallucinationScore += simDeviation * 1.2;
		}

		if (resp.answer.trim().length < 50) {
			reasons.push('Answer is suspiciously short');
			hallucinationScore += 0.4;
		}

		if (resp.confidence < 0.2) {
			reasons.push(`Very low confidence: ${(resp.confidence * 100).toFixed(0)}%`);
			hallucinationScore += 0.3;
		}

		hallucinationScore = Math.min(1.0, hallucinationScore);

		let severity: HallucinationResult['severity'] = 'none';
		let isHallucinating = false;

		if (hallucinationScore >= 0.7) {
			severity = 'severe';
			isHallucinating = true;
		} else if (hallucinationScore >= 0.45) {
			severity = 'moderate';
			isHallucinating = true;
		} else if (hallucinationScore >= 0.25) {
			severity = 'mild';
			isHallucinating = false;
		}

		return {
			modelId: resp.modelId,
			isHallucinating,
			details: reasons.length > 0 ? reasons.join('; ') : 'No hallucination detected',
			severity,
			score: hallucinationScore,
		};
	});
}

export function buildSimilarityMatrix(
	responses: LLMRawResponse[]
): Record<string, Record<string, number>> {
	const matrix: Record<string, Record<string, number>> = {};

	for (const resp of responses) {
		matrix[resp.modelId] = {};
		for (const other of responses) {
			if (resp.modelId === other.modelId) {
				matrix[resp.modelId][other.modelId] = 1.0;
			} else {
				matrix[resp.modelId][other.modelId] = cosineSimilarity(
					resp.answer + ' ' + resp.reasoning,
					other.answer + ' ' + other.reasoning
				);
			}
		}
	}

	return matrix;
}

export interface PBFTState {
	phase: 'pre_prepare' | 'prepare' | 'commit' | 'finalized';
	validNodes: string[];
	faultyNodes: string[];
	consensusScore: number;
	agreementMatrix: Record<string, Record<string, number>>;
	similarityMatrix: Record<string, Record<string, number>>;
	hallucinationResults: HallucinationResult[];
	pbftValid: boolean;
	thresholdMet: boolean;
}

export function runPBFTPhase(
	responses: LLMRawResponse[],
	critiqueResults: CritiqueResult[],
	reputationScores: Record<string, number>,
	roundNum: number,
	pbftConfig: { consensusThreshold: number; maxFaultyNodes: number; totalNodes: number },
	compositeScores?: Map<string, number>
): PBFTState {
	const hallucinationResults = detectHallucinations(responses);

	const faultyNodes = hallucinationResults
		.filter((h) => h.isHallucinating)
		.map((h) => h.modelId);

	const validNodes = responses
		.filter((r) => !faultyNodes.includes(r.modelId))
		.map((r) => r.modelId);

	const n = responses.length;
	const f = faultyNodes.length;
	const pbftValid = n >= 3 * f + 1;

	const agreementMatrix: Record<string, Record<string, number>> = {};
	for (const resp of responses) {
		agreementMatrix[resp.modelId] = {};
	}

	for (const critiqueResult of critiqueResults) {
		for (const c of critiqueResult.critiques) {
			const targetModel = responses.find(
				(r) => r.displayName === c.targetModel
			);
			if (targetModel) {
				agreementMatrix[critiqueResult.sourceModelId][targetModel.modelId] =
					c.agreementScore;
			}
		}
	}

	const similarityMatrix = buildSimilarityMatrix(responses);

	for (const resp of responses) {
		agreementMatrix[resp.modelId][resp.modelId] = 1.0;
	}

	for (const resp of responses) {
		for (const other of responses) {
			if (agreementMatrix[resp.modelId]?.[other.modelId] === undefined) {
				agreementMatrix[resp.modelId][other.modelId] =
					similarityMatrix[resp.modelId]?.[other.modelId] ?? 0;
			}
		}
	}

	const modelIds = responses.map((r) => r.modelId);
	for (let i = 0; i < modelIds.length; i++) {
		for (let j = i + 1; j < modelIds.length; j++) {
			const a = agreementMatrix[modelIds[i]]?.[modelIds[j]] ?? 0;
			const b = agreementMatrix[modelIds[j]]?.[modelIds[i]] ?? 0;
			const avg = (a + b) / 2;
			agreementMatrix[modelIds[i]][modelIds[j]] = avg;
			agreementMatrix[modelIds[j]][modelIds[i]] = avg;
		}
	}

	let totalWeight = 0;
	let weightedAgreement = 0;

	const rawWeights = new Map<string, number>();
	for (const nodeId of validNodes) {
		const reputation = reputationScores[nodeId] || 1.0;
		const nodeResponse = responses.find((r) => r.modelId === nodeId);
		if (!nodeResponse) { continue; }
		const composite = compositeScores?.get(nodeId) ?? 0.85;
		rawWeights.set(nodeId, reputation * nodeResponse.confidence * composite);
	}

	const totalRaw = [...rawWeights.values()].reduce((a, b) => a + b, 0);

	for (const nodeId of validNodes) {
		const nodeResponse = responses.find((r) => r.modelId === nodeId);
		if (!nodeResponse) { continue; }

		let w = rawWeights.get(nodeId) ?? 0;
		if (totalRaw > 0) {
			w = Math.min(w, totalRaw * MAX_WEIGHT_FRACTION);
		}

		const peerAgreements = validNodes
			.filter((id) => id !== nodeId)
			.map((peerId) => agreementMatrix[nodeId]?.[peerId] ?? similarityMatrix[nodeId]?.[peerId] ?? 0);

		const avgPeerAgreement =
			peerAgreements.length > 0
				? peerAgreements.reduce((a, b) => a + b, 0) / peerAgreements.length
				: 0;

		weightedAgreement += avgPeerAgreement * w;
		totalWeight += w;
	}

	const consensusScore =
		totalWeight > 0
			? Math.min(1, weightedAgreement / totalWeight)
			: 0;

	const thresholdMet = consensusScore >= pbftConfig.consensusThreshold;

	let phase: PBFTState['phase'] = 'pre_prepare';
	if (pbftValid) { phase = 'prepare'; }
	if (pbftValid && consensusScore > 0.4) { phase = 'commit'; }
	if (pbftValid && thresholdMet) { phase = 'finalized'; }

	return {
		phase,
		validNodes,
		faultyNodes,
		consensusScore,
		agreementMatrix,
		similarityMatrix,
		hallucinationResults,
		pbftValid,
		thresholdMet,
	};
}

export function updateReputationScores(
	currentScores: Record<string, number>,
	hallucinationResults: HallucinationResult[],
	agreementMatrix: Record<string, Record<string, number>>
): Record<string, number> {
	const updated = { ...currentScores };

	for (const result of hallucinationResults) {
		const current = updated[result.modelId] ?? 1.0;

		if (result.isHallucinating) {
			const penalty = result.severity === 'severe' ? 0.25 : 0.1;
			updated[result.modelId] = Math.max(0.1, current - penalty);
		} else {
			const boost = 0.03;
			updated[result.modelId] = Math.min(1.5, current + boost);
		}
	}

	return updated;
}
