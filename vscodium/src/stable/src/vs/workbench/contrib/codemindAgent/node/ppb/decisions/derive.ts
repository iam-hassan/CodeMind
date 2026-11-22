/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Decision / event derivation for the ingestion sink (P1-T12 bridge, spec §10/§11).
 *
 * The extraction contract (§7.5) carries only category/content/confidence/importance — it has no
 * explicit "decision" or "event" field. So the Decision-and-Event memory (§10/§11) would stay
 * empty on the live path and §10/§11/§17 reasoning ("why did we choose X", "which alternatives
 * were rejected", "when did the migration happen") could never be answered from a real
 * conversation. This module recognises the decision-shaped and change-shaped statements the
 * extractor already emits and projects them into the §10/§11 record shapes.
 *
 * It is deliberately conservative: a fact becomes a Decision only when its category is a
 * decision-bearing one, it is not phrased as a change/rejection, and it either names the choice with
 * an explicit verb or is a concise statement of what the project uses/does; it becomes an Event only
 * when the statement describes a change of state. Pure functions — no IO — so the boundary stays
 * testable.
 */

import type { EventType, MemoryCategory } from '../ontology.js';
import type { ExtractedFact } from '../extraction/types.js';
import type { DecisionInput, EventInput } from './decisionMemory.js';

/** Categories whose facts can name a concrete project choice (§7.4/§10.2). */
const DECISION_CATEGORIES: ReadonlySet<MemoryCategory> = new Set<MemoryCategory>([
	'technology_stack',
	'architecture_patterns'
]);

/** An explicit choice/commitment verb — the signal that a fact states a decision, not just a fact. */
const CHOICE_VERB = /\b(use|uses|using|choose|chose|chosen|adopt(?:ed|s)?|pick(?:ed)?|build|builds|built|implement(?:ed|s)?|select(?:ed|s)?|decid(?:e|ed)|migrat(?:e|ed|ing|ion)|switch(?:ed|ing)?|replac(?:e|ed|ing)|persist(?:s|ed)?|store[ds]?|host(?:ed|s)?|deploy(?:ed|s)?|opt(?:ed|s)?\s+for|standardis(?:e|ed)|standardiz(?:e|ed))\b/i;

/**
 * Change/rejection phrasing (§11): "no longer", "rejected", "instead of". Those describe a transition
 * or a discarded option, so they become Events, not a current Decision. Without this the extractor's
 * "The project no longer uses Redis" would be recorded as an accepted decision.
 */
const CHANGE_OR_REJECTION = /\b(reject(?:ed|s)?|not selected|decided against|ruled out|no longer|instead of|rather than|deprecated|abandon(?:ed)?)\b/i;

/** The "why" clause that follows a reason connective (§10.2 `reason`). */
const REASON_CLAUSE = /\b(?:because|since|so that|due to|in order to)\b\s+([^.;]+(?:\.[^.;]+)?)/i;

/** Alternatives named as "instead of X" (§10.2 `alternatives`). */
const INSTEAD_OF = /\b(?:instead of|rather than)\s+([^.;,]+(?:,[^.;]+)*)/i;

/** Named things that were explicitly rejected (§10.3 rejected alternatives). */
const REJECTED = /\b(?:rejected|not selected|decided against|ruled out)\b\s+([A-Za-z0-9][A-Za-z0-9 ._+-]{0,40})/gi;

/** Change-of-state signals → §6.3 / §11 event types, most specific first. */
const EVENT_PATTERNS: ReadonlyArray<{ readonly type: EventType; readonly pattern: RegExp }> = [
	{ type: 'rejected', pattern: /\b(rejected|not selected|decided against|ruled out|no longer use[sd]?)\b/i },
	{ type: 'migrated', pattern: /\b(migrat(?:e|ed|ing|ion)|moved? to|switch(?:ed|ing)? to|now uses?|now builds?|now store[sd]?)\b/i },
	{ type: 'changed', pattern: /\b(instead of|rather than|replac(?:e|ed|ing)|switch(?:ed|ing)?|chang(?:e|ed|ing)|drop(?:ped|ping)?|return(?:ed|ing)? to)\b/i },
	{ type: 'added', pattern: /\b(added|introduc(?:e|ed|ing)|now support(?:s|ed)?|newly)\b/i }
];

function firstRejected(content: string): string[] {
	const names: string[] = [];
	REJECTED.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = REJECTED.exec(content)) !== null) {
		// Trim trailing connectives the greedy noun-phrase capture may include.
		const name = match[1].replace(/\b(because|since|due to|for|as|and|which|that|it)\b.*$/i, '').trim();
		if (name.length >= 2) {
			names.push(name);
		}
		if (names.length >= 8) {
			break;
		}
	}
	return [...new Set(names)];
}

/** Derive a §10 decision from a fact, or `undefined` when the fact does not state a choice. */
export function deriveDecision(fact: ExtractedFact): DecisionInput | undefined {
	const content = fact.content.trim();
	if (content.length === 0 || !DECISION_CATEGORIES.has(fact.category)) {
		return undefined;
	}
	// A transition/rejection is a §11 Event, not a standing decision.
	if (CHANGE_OR_REJECTION.test(content)) {
		return undefined;
	}
	// The extractor often emits a concise noun phrase ("Clerk for authentication", "PostgreSQL with
	// pgvector for persistence") with no verb at all. For a decision-bearing category such a
	// statement is the choice, so accept it; a long statement still needs an explicit choice verb.
	const explicitChoice = CHOICE_VERB.test(content);
	const concise = content.length <= 140;
	if (!explicitChoice && !concise) {
		return undefined;
	}
	const reasonMatch = REASON_CLAUSE.exec(content);
	const insteadMatch = INSTEAD_OF.exec(content);
	const rejected = firstRejected(content);
	return {
		projectId: '', // filled by the caller (the fact carries no project id)
		decision: content,
		reason: reasonMatch ? reasonMatch[1].trim().slice(0, 300) : undefined,
		alternatives: insteadMatch ? insteadMatch[1].trim().slice(0, 200) : (rejected.length > 0 ? rejected.join(', ') : undefined),
		author: fact.author,
		sourceRef: fact.sourceRef,
		decidedAt: fact.extractedAt,
		rejectedAlternatives: rejected.length > 0 ? rejected : undefined
	};
}

/** Derive a §11 event from a fact, or `undefined` when the statement describes no state change. */
export function deriveEvent(fact: ExtractedFact, occurredAt: string): EventInput | undefined {
	const content = fact.content.trim();
	if (content.length === 0) {
		return undefined;
	}
	const match = EVENT_PATTERNS.find(entry => entry.pattern.test(content));
	if (!match) {
		return undefined;
	}
	return {
		projectId: '', // filled by the caller
		eventType: match.type,
		description: content,
		occurredAt,
		sourceRef: fact.sourceRef
	};
}
