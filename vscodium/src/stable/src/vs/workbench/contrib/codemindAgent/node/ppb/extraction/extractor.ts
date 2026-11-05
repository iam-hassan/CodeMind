/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extraction prompt and structured-output schema (P1-T04, spec §7.4/§7.5/§7.6).
 *
 * The schema covers exactly the six knowledge categories (§7.4, preserve exactly) and the
 * per-fact fields the extraction model must supply. Every fact reaches storage only after the
 * schema validator in `validate.ts` accepts it (§7.7).
 */

import type { ConversationSegment } from '../../orchestration/segmentQueue.js';
import type { LlmClient } from '../llm/client.js';
import { GRAPH_RELATIONSHIP_TYPES, MEMORY_CATEGORIES } from '../ontology.js';

/** The six categories, verbatim (spec §7.4). */
export const EXTRACTION_CATEGORIES = MEMORY_CATEGORIES;

/** JSON Schema for `{ facts: [...] }` — the structured-output contract (spec §7.3). */
export const EXTRACTION_JSON_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['facts'],
	properties: {
		facts: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['category', 'content'],
				properties: {
					category: { type: 'string', enum: [...EXTRACTION_CATEGORIES] },
					content: { type: 'string', minLength: 1 },
					confidence: { type: 'number', minimum: 0, maximum: 1 },
					importance: { type: 'number', minimum: 0, maximum: 1 },
					author: { type: 'string' }
				}
			}
		},
		relationships: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['type', 'from', 'to'],
				properties: {
					type: { type: 'string', enum: [...GRAPH_RELATIONSHIP_TYPES] },
					from: { type: 'string', minLength: 1 },
					to: { type: 'string', minLength: 1 }
				}
			}
		}
	}
} as const;

export const EXTRACTION_SYSTEM_PROMPT = [
	'You extract durable engineering knowledge from one developer conversation turn.',
	'Classify every genuine engineering statement into exactly one of these six categories:',
	...EXTRACTION_CATEGORIES.map(category => `- ${category}`),
	'',
	'Rules:',
	'- Discard greetings, small talk and non-technical discussion: return {"facts": []}.',
	'- Capture the developer\'s durable objectives and requirements: what the project should build or do, and any explicit requirement. A "build/fix/add X" instruction states a durable goal when it describes the product, so record it. Use "architecture_patterns" for what the system is/does, "business_rules" for required behaviour, "developer_preferences" for stated wants or style.',
	'  Example: "Build an angry bird game in html with realistic game mechanics and graphics" -> {"category":"architecture_patterns","content":"The project is an Angry Birds game in HTML with realistic game mechanics and graphics","importance":0.8}.',
	'- Capture changes of direction: when the developer replaces or abandons a plan, record the new direction using replacement wording, e.g. "The project now builds a Flappy Bird game instead of Angry Birds".',
	'- Do NOT record routine commands that add no durable knowledge ("Continue", "run the tests", "what does this do?"): return {"facts": []}.',
	'- Never invent knowledge that the turn does not state.',
	'- One fact per distinct statement; keep each content string self-contained.',
	'- confidence and importance are numbers in [0,1]; omit them if you cannot judge them.',
	'- author is "developer" when the developer stated it, otherwise "assistant".',
	'',
	'Additionally, when the turn implies a relationship BETWEEN the things you extracted, add it to',
	'`relationships` as {"type": <relationship>, "from": <name>, "to": <name>} where the names match',
	'a fact you emitted (use "@@project" for the project itself). Valid relationship types:',
	...GRAPH_RELATIONSHIP_TYPES.map(type => `- ${type}`),
	'Only state relationships the turn actually implies; omit the array when there are none.',
	'',
	'Respond with JSON only, matching this schema exactly:',
	JSON.stringify(EXTRACTION_JSON_SCHEMA)
].join('\n');

/** The user message — the normalized segment text only; Part 1 never persists it (§7.11). */
export function buildExtractionUserPrompt(segment: ConversationSegment): string {
	return [
		`Project: ${segment.projectId}`,
		`Turn: ${segment.turnId} (${segment.role})`,
		`Intent hint: ${segment.intent}`,
		'',
		segment.text
	].join('\n');
}

/** One model call for one segment (T04). Throws `LlmClientError` on transport failure. */
export async function callExtractionModel(client: LlmClient, segment: ConversationSegment): Promise<string> {
	const result = await client.chat({
		system: EXTRACTION_SYSTEM_PROMPT,
		user: buildExtractionUserPrompt(segment),
		temperature: 0
	});
	return result.text;
}
