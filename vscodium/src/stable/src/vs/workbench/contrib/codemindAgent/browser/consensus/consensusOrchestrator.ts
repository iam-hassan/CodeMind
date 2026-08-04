/*---------------------------------------------------------------------------------------------
 *  LLM Consensus — Master Orchestrator (Minimal)
 *  Ported from LLM_consensus/LLM-Consensus/backend/src/orchestrator/masterOrchestrator.ts
 *--------------------------------------------------------------------------------------------*/

import {
	LLMRawResponse,
	querySelectedModels,
	runCritiqueRound,
	runRevisionRound,
	CritiqueResult,
} from './openRouterService.js';
import {
	runPBFTPhase,
	updateReputationScores,
	PBFTState,
} from './consensusEngine.js';
import { runForcedConsensus } from './forcedConsensus.js';
import { computePBFTConfig, ModelConfig } from './models.js';
import { routeTask, AgentAssignment } from './agentRouter.js';
import { Event } from '../../../../../base/common/event.js';
import { Emitter } from '../../../../../base/common/event.js';

export interface OrchestrationResult {
	sessionId: string;
	finalAnswer: string;
	finalReasoning?: string;
	consensusScore: number;
	roundsCompleted: number;
	participatingModels: string[];
	faultyModels: string[];
	weightedVotes: Record<string, number>;
	similarityMatrix: Record<string, Record<string, number>>;
	hallucinationDetails: Array<{
		modelId: string;
		isHallucinating: boolean;
		severity: string;
		details: string;
		score: number;
	}>;
	roundHistory: Array<{
		roundNumber: number;
		consensusScore: number;
		phase: string;
		faultyCount: number;
	}>;
	taskType?: string;
	droppedAgents?: string[];
}

export interface ConsensusEvent {
	type: string;
	sessionId: string;
	payload: any;
}

export class ConsensusOrchestrator {
	private _onDidEmitEvent = new Emitter<ConsensusEvent>();
	public readonly onDidEmitEvent: Event<ConsensusEvent> = this._onDidEmitEvent.event;

	private broadcastToSession(sessionId: string, event: ConsensusEvent) {
		this._onDidEmitEvent.fire(event);
	}

	async orchestrateConsensus(
		userPrompt: string,
		sessionId: string,
		selectedModels: ModelConfig[]
	): Promise<OrchestrationResult> {
		const pbftConfig = computePBFTConfig(selectedModels.length);
		console.log(`[Orchestrator] Starting consensus for session ${sessionId}`);

		this.broadcastToSession(sessionId, {
			type: 'pbft_phase_change',
			sessionId,
			payload: { phase: 'planning', message: 'Decomposing query and routing to optimal agent subset...' },
		});

		// Simplified routing: default to factual_qa strategy
		const routerResult = routeTask('factual_qa', selectedModels);
		const isCreative = false;

		this.broadcastToSession(sessionId, {
			type: 'task_spec',
			sessionId,
			payload: { taskType: 'factual_qa', difficulty: 1, agentCount: routerResult.assignments.length, subtasks: [] },
		});

		return await this.runConsensusPipeline(
			userPrompt, sessionId, routerResult.assignments,
			isCreative, undefined, routerResult.useDebateOnForcedConsensus,
			pbftConfig
		);
	}

	private async runConsensusPipeline(
		userPrompt: string,
		sessionId: string,
		assignments: AgentAssignment[],
		isCreative: boolean,
		memoryContext?: string,
		useDebateOnForcedConsensus?: boolean,
		pbftConfig?: { consensusThreshold: number; maxFaultyNodes: number; totalNodes: number; maxRounds: number; forcedConsensusRound: number; }
	): Promise<OrchestrationResult> {
		if (!pbftConfig) { throw new Error('pbftConfig is required'); }
		let reputationScores: Record<string, number> = {};
		for (const a of assignments) {
			reputationScores[a.model.id] = a.model.baseReputationScore;
		}

		let currentResponses: LLMRawResponse[] = [];
		let finalPBFTState: PBFTState | null = null;
		const roundHistory: OrchestrationResult['roundHistory'] = [];
		let roundsCompleted = 0;
		const droppedAgents: string[] = [];

		let bestRoundScore = 0;
		let bestRoundNumber = 0;
		let bestRoundTopAnswer = '';
		let bestRoundMiddleGrounds: string[] = [];

		this.broadcastToSession(sessionId, {
			type: 'pbft_phase_change',
			sessionId,
			payload: {
				phase: 'pre_prepare',
				message: `Sending prompt to ${assignments.length} LLM validators (${assignments.map(a => a.strategy).join(', ')})...`,
			},
		});

		currentResponses = await querySelectedModels(
			userPrompt,
			assignments,
			memoryContext,
			isCreative,
			(modelId, response) => {
				this.broadcastToSession(sessionId, {
					type: 'model_response',
					sessionId,
					payload: {
						roundNumber: 1,
						modelId,
						displayName: response.displayName,
						answer: response.answer,
						reasoning: response.reasoning,
						confidence: response.confidence,
						strategy: response.strategy,
						processingTimeMs: response.processingTimeMs,
						error: response.error,
					},
				});
			}
		);

		for (let roundNum = 1; roundNum <= pbftConfig.maxRounds; roundNum++) {
			roundsCompleted = roundNum;
			console.log(`[Orchestrator] Round ${roundNum} - PBFT Analysis`);

			this.broadcastToSession(sessionId, {
				type: 'pbft_phase_change',
				sessionId,
				payload: { phase: 'prepare', round: roundNum, message: `Round ${roundNum}: Models critiquing each other...` },
			});

			let critiqueResults: CritiqueResult[] = [];
			if (currentResponses.length > 0) {
				critiqueResults = await runCritiqueRound(
					userPrompt,
					currentResponses.filter((r) => !droppedAgents.includes(r.modelId)),
					(modelId, result) => {
						this.broadcastToSession(sessionId, {
							type: 'critique_result',
							sessionId,
							payload: { roundNumber: roundNum, sourceModelId: modelId, critiques: result.critiques, revisedConfidence: result.revisedConfidence },
						});
					}
				);
			}

			if (roundNum < pbftConfig.forcedConsensusRound) {
				this.broadcastToSession(sessionId, {
					type: 'pbft_phase_change',
					sessionId,
					payload: { phase: 'prepare', round: roundNum, message: `Round ${roundNum}: Models revising based on feedback...` },
				});

				const middleGrounds: string[] = [];
				for (const cr of critiqueResults) {
					for (const c of cr.critiques) {
						if (c.suggestedMiddleGround?.trim()) { middleGrounds.push(c.suggestedMiddleGround); }
					}
				}

				const revisionResults = await runRevisionRound(
					userPrompt,
					currentResponses,
					critiqueResults,
					middleGrounds,
					(modelId, result) => {
						this.broadcastToSession(sessionId, {
							type: 'model_revision',
							sessionId,
							payload: { roundNumber: roundNum, modelId, revisedAnswer: result.revisedAnswer.slice(0, 200), revisedConfidence: result.revisedConfidence },
						});
					}
				);

				for (const rev of revisionResults) {
					const resp = currentResponses.find((r) => r.modelId === rev.modelId);
					if (resp) {
						resp.answer = rev.revisedAnswer;
						resp.reasoning = rev.revisedReasoning;
						resp.confidence = rev.revisedConfidence;
					}
				}
			}

			this.broadcastToSession(sessionId, {
				type: 'pbft_phase_change',
				sessionId,
				payload: { phase: 'commit', round: roundNum, message: `Round ${roundNum}: Running PBFT consensus validation...` },
			});

			finalPBFTState = runPBFTPhase(
				currentResponses,
				critiqueResults,
				reputationScores,
				roundNum,
				pbftConfig
			);

			for (const h of finalPBFTState.hallucinationResults) {
				if (h.isHallucinating) {
					this.broadcastToSession(sessionId, {
						type: 'hallucination_detected',
						sessionId,
						payload: { modelId: h.modelId, severity: h.severity, score: h.score, details: h.details, round: roundNum },
					});
				}
			}

			reputationScores = updateReputationScores(reputationScores, finalPBFTState.hallucinationResults, finalPBFTState.agreementMatrix);

			roundHistory.push({
				roundNumber: roundNum,
				consensusScore: finalPBFTState.consensusScore,
				phase: finalPBFTState.phase,
				faultyCount: finalPBFTState.faultyNodes.length,
			});

			if (finalPBFTState && finalPBFTState.consensusScore > bestRoundScore) {
				bestRoundScore = finalPBFTState.consensusScore;
				bestRoundNumber = roundNum;
				const validForBest = currentResponses.filter((r) => !finalPBFTState!.faultyNodes.includes(r.modelId));
				const sortedForBest = validForBest.sort((a, b) => {
					const repA = reputationScores[a.modelId] || 1;
					const repB = reputationScores[b.modelId] || 1;
					return b.confidence * repB - a.confidence * repA;
				});
				bestRoundTopAnswer = sortedForBest[0]?.answer || '';
				bestRoundMiddleGrounds = [];
				for (const cr of critiqueResults) {
					for (const c of cr.critiques) {
						if (c.suggestedMiddleGround?.trim()) { bestRoundMiddleGrounds.push(c.suggestedMiddleGround); }
					}
				}
			}

			this.broadcastToSession(sessionId, {
				type: 'round_complete',
				sessionId,
				payload: {
					round: roundNum,
					consensusScore: finalPBFTState.consensusScore,
					phase: finalPBFTState.phase,
					validNodes: finalPBFTState.validNodes,
					faultyNodes: finalPBFTState.faultyNodes,
					pbftValid: finalPBFTState.pbftValid,
					thresholdMet: finalPBFTState.thresholdMet,
					similarityMatrix: finalPBFTState.similarityMatrix,
					agreementMatrix: finalPBFTState.agreementMatrix,
					droppedAgents,
				},
			});

			if (finalPBFTState.thresholdMet && finalPBFTState.pbftValid) {
				console.log(`[Orchestrator] Consensus reached in round ${roundNum}`);
				break;
			}

			if (roundNum >= pbftConfig.forcedConsensusRound) {
				console.log(`[Orchestrator] Activating forced consensus at round ${roundNum}`);
				break;
			}
		}

		let finalAnswer = '';
		let finalReasoning = '';
		let finalConsensusScore = finalPBFTState?.consensusScore || 0;
		let finalWeightedVotes: Record<string, number> = {};
		let finalFaultyModels: string[] = finalPBFTState?.faultyNodes || [];

		if (!finalPBFTState?.thresholdMet) {
			this.broadcastToSession(sessionId, {
				type: 'pbft_phase_change',
				sessionId,
				payload: { phase: 'forced_consensus', message: 'Activating forced consensus mechanism...' },
			});

			const forcedResult = await runForcedConsensus(
				userPrompt,
				currentResponses,
				finalPBFTState!,
				reputationScores,
				roundsCompleted,
				bestRoundTopAnswer,
				bestRoundNumber,
				bestRoundScore,
				bestRoundMiddleGrounds
			);

			finalAnswer = forcedResult.finalAnswer;
			finalConsensusScore = forcedResult.consensusScore;
			finalWeightedVotes = forcedResult.weightedVotes;
			finalFaultyModels = forcedResult.faultyModels;
		} else {
			const validResponses = currentResponses.filter((r) => !finalPBFTState!.faultyNodes.includes(r.modelId));
			const sorted = validResponses.sort((a, b) => {
				const repA = reputationScores[a.modelId] || 1;
				const repB = reputationScores[b.modelId] || 1;
				return b.confidence * repB - a.confidence * repA;
			});
			const bestResponse = sorted[0] || currentResponses[0];
			finalAnswer = bestResponse?.answer || '';
			finalReasoning = bestResponse?.reasoning || 'No reasoning provided.';
			finalWeightedVotes = {};
			for (const r of currentResponses) {
				finalWeightedVotes[r.modelId] = (reputationScores[r.modelId] || 1) * r.confidence;
			}
		}

		this.broadcastToSession(sessionId, {
			type: 'consensus_reached',
			sessionId,
			payload: { finalAnswer, finalReasoning, consensusScore: finalConsensusScore, roundsCompleted, faultyModels: finalFaultyModels, participatingModels: currentResponses.map((r) => r.modelId), droppedAgents },
		});

		return {
			sessionId, finalAnswer, finalReasoning, consensusScore: finalConsensusScore,
			roundsCompleted, participatingModels: currentResponses.map((r) => r.modelId),
			faultyModels: finalFaultyModels, weightedVotes: finalWeightedVotes,
			similarityMatrix: finalPBFTState?.similarityMatrix || {},
			hallucinationDetails: (finalPBFTState?.hallucinationResults || []).map((h) => ({
				modelId: h.modelId, isHallucinating: h.isHallucinating, severity: h.severity, details: h.details, score: h.score,
			})),
			roundHistory,
			droppedAgents,
		};
	}
}
