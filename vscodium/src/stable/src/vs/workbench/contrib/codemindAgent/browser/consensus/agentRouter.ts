/*---------------------------------------------------------------------------------------------
 *  LLM Consensus — Agent Router
 *  Ported from LLM_consensus/LLM-Consensus/backend/src/planner/agentRouter.ts
 *--------------------------------------------------------------------------------------------*/

import { ModelConfig } from './models.js';

export type TaskType = 'factual_qa' | 'reasoning' | 'math' | 'code' | 'creative' | 'multi_step';

export type PromptStrategy =
	| 'cot'
	| 'self_consistency'
	| 'react'
	| 'tot'
	| 'pot'
	| 'chain_of_verification';

export interface AgentAssignment {
	model: ModelConfig;
	strategy: PromptStrategy;
	selfConsistencyN?: number;
}

export interface RouterResult {
	assignments: AgentAssignment[];
	useDebateOnForcedConsensus: boolean;
}

const SELF_CONSISTENCY_N = 3;

export function routeTask(taskType: TaskType, selectedModels: ModelConfig[]): RouterResult {
	const allModels = selectedModels;

	switch (taskType) {
		case 'factual_qa':
		case 'multi_step': {
			const assignments: AgentAssignment[] = allModels.map((model) => ({
				model,
				strategy: 'react' as PromptStrategy,
			}));
			return { assignments, useDebateOnForcedConsensus: false };
		}

		case 'reasoning': {
			const assignments: AgentAssignment[] = allModels.map((model, i) => {
				if (i < 4) {
					return { model, strategy: 'self_consistency' as PromptStrategy, selfConsistencyN: SELF_CONSISTENCY_N };
				}
				return { model, strategy: 'tot' as PromptStrategy };
			});
			return { assignments, useDebateOnForcedConsensus: true };
		}

		case 'math': {
			const assignments: AgentAssignment[] = allModels.map((model, i) => {
				if (i < 3) { return { model, strategy: 'pot' as PromptStrategy }; }
				if (i < 6) { return { model, strategy: 'self_consistency' as PromptStrategy, selfConsistencyN: SELF_CONSISTENCY_N }; }
				return { model, strategy: 'cot' as PromptStrategy };
			});
			return { assignments, useDebateOnForcedConsensus: true };
		}

		case 'code': {
			const assignments: AgentAssignment[] = allModels.map((model) => ({
				model,
				strategy: 'react' as PromptStrategy,
			}));
			return { assignments, useDebateOnForcedConsensus: false };
		}

		case 'creative': {
			const assignments: AgentAssignment[] = allModels.map((model) => ({
				model,
				strategy: 'cot' as PromptStrategy,
			}));
			return { assignments, useDebateOnForcedConsensus: false };
		}

		default: {
			const assignments: AgentAssignment[] = allModels.map((model) => ({
				model,
				strategy: 'cot' as PromptStrategy,
			}));
			return { assignments, useDebateOnForcedConsensus: false };
		}
	}
}
