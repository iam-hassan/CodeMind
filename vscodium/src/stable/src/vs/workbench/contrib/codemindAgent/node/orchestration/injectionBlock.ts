/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { RetrievedFact } from './retrievalRequest.js';
import { filterToProject } from './projectRegistry.js';
import { recordCrossProjectLeaks } from './segmentQueue.js';

export interface InjectionAudit {
	injectedFacts: number;
	droppedFacts: number;
	estimatedTokens: number;
}

export function formatInjectionBlock(
	facts: RetrievedFact[],
	projectId: string,
	budgetTokens: number
): { block: string; audit: InjectionAudit } {
	const safeFacts = filterToProject(facts, projectId);
	const leaked = facts.length - safeFacts.length;
	if (leaked > 0) {
		recordCrossProjectLeaks(leaked);
	}

	if (safeFacts.length === 0) {
		return { block: '', audit: { injectedFacts: 0, droppedFacts: facts.length, estimatedTokens: 0 } };
	}

	// Sort by score descending
	safeFacts.sort((a, b) => b.score - a.score);

	let currentTokens = 0;
	let block = '[PPB CONTEXT]\n';
	let injected = 0;

	for (const fact of safeFacts) {
		// Tokens roughly chars / 4
		const line = `• ${fact.category.charAt(0).toUpperCase() + fact.category.slice(1)}: ${fact.content} (score ${fact.score.toFixed(2)})\n`;
		const tokens = Math.ceil(line.length / 4);

		if (currentTokens + tokens > budgetTokens) {
			break; // Drop this and all remaining (since they are lower scored)
		}

		block += line;
		currentTokens += tokens;
		injected++;
	}

	if (injected === 0) {
		return { block: '', audit: { injectedFacts: 0, droppedFacts: facts.length, estimatedTokens: 0 } };
	}

	return {
		block,
		audit: {
			injectedFacts: injected,
			droppedFacts: facts.length - injected,
			estimatedTokens: currentTokens
		}
	};
}
