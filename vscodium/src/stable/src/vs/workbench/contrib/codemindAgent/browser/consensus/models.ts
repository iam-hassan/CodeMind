/*---------------------------------------------------------------------------------------------
 *  LLM Consensus — Model Configuration
 *  Ported from LLM_consensus/LLM-Consensus/backend/src/config/models.ts
 *--------------------------------------------------------------------------------------------*/

export interface ModelConfig {
	id: string;
	displayName: string;
	openRouterId: string;
	specialty: string;
	baseReputationScore: number;
}

// Hardcoded fallback models (used if API fetch fails)
export const LLM_MODELS: ModelConfig[] = [
	{
		id: 'nemotron-ultra',
		displayName: 'Nemotron 3 Ultra 550B',
		openRouterId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
		specialty: 'Ultra-Scale Reasoning',
		baseReputationScore: 1.1,
	},
	{
		id: 'nemotron-super',
		displayName: 'Nemotron 3 Super 120B',
		openRouterId: 'nvidia/nemotron-3-super-120b-a12b:free',
		specialty: 'Complex Reasoning',
		baseReputationScore: 1.0,
	},
	{
		id: 'nemotron-nano',
		displayName: 'Nemotron 3 Nano 30B',
		openRouterId: 'nvidia/nemotron-3-nano-30b-a3b:free',
		specialty: 'Fast Instructions',
		baseReputationScore: 1.0,
	},
	{
		id: 'nemotron-omni',
		displayName: 'Nemotron 3 Nano Omni',
		openRouterId: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
		specialty: 'Multimodal Reasoning',
		baseReputationScore: 1.0,
	},
	{
		id: 'gemma-4-31b',
		displayName: 'Gemma 4 31B',
		openRouterId: 'google/gemma-4-31b-it:free',
		specialty: 'Broad Knowledge',
		baseReputationScore: 1.0,
	},
	{
		id: 'gemma-4-26b',
		displayName: 'Gemma 4 26B A4B',
		openRouterId: 'google/gemma-4-26b-a4b-it:free',
		specialty: 'General Knowledge',
		baseReputationScore: 1.0,
	},
	{
		id: 'gpt-oss-20',
		displayName: 'GPT-OSS 20B',
		openRouterId: 'openai/gpt-oss-20b:free',
		specialty: 'General Knowledge',
		baseReputationScore: 1.0,
	},
];

// PBFT dynamic computation based on user selection
export function computePBFTConfig(selectedModelCount: number) {
	// n >= 3f + 1 => f <= (n - 1) / 3
	const maxFaultyNodes = Math.floor((selectedModelCount - 1) / 3);
	// We need 2f + 1 nodes to agree out of totalNodes
	const consensusThreshold = (2 * maxFaultyNodes + 1) / selectedModelCount;
	return {
		totalNodes: selectedModelCount,
		maxFaultyNodes,
		consensusThreshold,
		maxRounds: 5,
		forcedConsensusRound: 4,
	};
}

export const OPENROUTER_CONFIG = {
	baseUrl: 'https://openrouter.ai/api/v1',
	apiKey: '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',
	siteUrl: 'http://localhost:3000',
	siteName: 'CodeMind Consensus',
};

/**
 * Fetch free models from the OpenRouter API.
 * Filters for models where pricing.prompt === "0" and pricing.completion === "0".
 * Falls back to LLM_MODELS if the fetch fails.
 */
export async function fetchFreeModels(): Promise<ModelConfig[]> {
	try {
		const response = await fetch(`${OPENROUTER_CONFIG.baseUrl}/models`);
		if (!response.ok) {
			console.warn('[Models] Failed to fetch from OpenRouter, using fallback');
			return LLM_MODELS;
		}
		const json: any = await response.json();
		const data: any[] = json.data || [];

		const freeModels = data.filter((m: any) => {
			const prompt = String(m.pricing?.prompt ?? '1');
			const completion = String(m.pricing?.completion ?? '1');
			const isFree = prompt === '0' && completion === '0';
			const isRouter = m.id === 'openrouter/free';
			// Only text-output models
			const outputMods: string[] = m.architecture?.output_modalities ?? [];
			const hasTextOutput = outputMods.includes('text');
			// Exclude audio-only output like Lyria
			const isAudioOnly = outputMods.includes('audio') && !outputMods.includes('text');
			return isFree && !isRouter && hasTextOutput && !isAudioOnly;
		});

		if (freeModels.length === 0) {
			console.warn('[Models] No free models found from API, using fallback');
			return LLM_MODELS;
		}

		return freeModels.map((m: any) => ({
			id: m.id.replace(/[/:]/g, '-'),
			displayName: (m.name || m.id).replace(/\s*\(free\)\s*$/i, ''),
			openRouterId: m.id,
			specialty: m.architecture?.modality || 'General',
			baseReputationScore: 1.0,
		}));
	} catch (err) {
		console.warn('[Models] Error fetching models:', err);
		return LLM_MODELS;
	}
}
