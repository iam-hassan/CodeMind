/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Published internal API surface (P1-T14, spec §18).
 *
 * The machine-readable form of `docs/ppb/if-contracts.md`: Parts 2 and 3 integrate against this
 * descriptor and the typed repository/service modules it names, never against Part 1's storage
 * internals (§18.1). Contract drift is caught by `node/test/ppb/apiContract.test.ts` (§23.13).
 */

import { PPB_MIGRATIONS } from './storage/migrations/index.js';
import { WEIGHT_PROFILE_VERSION } from './retrieval/weightProfile.js';

export const PPB_API_VERSION = '1.0.0';

export type PpbInterfaceStatus = 'implemented' | 'published';

export interface PpbInterfaceDescriptor {
	/** IF-1 … IF-12 (§18.3). */
	readonly id: string;
	readonly producer: string;
	readonly consumer: string;
	readonly purpose: string;
	/** Documented payload fields; an empty list means "to be finalized during implementation". */
	readonly payload: readonly string[];
	readonly status: PpbInterfaceStatus;
}

/**
 * IF-1 … IF-12. Payload field lists mirror the concrete shapes actually produced/consumed by the
 * implementation modules named in `docs/ppb/if-contracts.md`; nothing is invented beyond §18.5.
 */
export const PPB_INTERFACES: readonly PpbInterfaceDescriptor[] = [
	{
		id: 'IF-1', producer: 'Part 2', consumer: 'Part 1', purpose: 'Normalized conversation segment for extraction.',
		payload: ['projectId', 'turnId', 'role', 'text', 'intent', 'timestamp', 'editorState'], status: 'implemented'
	},
	{
		id: 'IF-2', producer: 'Part 1', consumer: 'Part 1 / Part 3', purpose: 'Extracted fact set with §7.5 metadata.',
		payload: ['id', 'category', 'content', 'confidence', 'importance', 'sourceRef', 'author', 'extractedAt'], status: 'implemented'
	},
	{
		id: 'IF-3', producer: 'Part 1', consumer: 'Part 2 → Part 3', purpose: 'Conflict confirmation request.',
		payload: ['projectId', 'existing', 'incoming', 'category', 'severity', 'question'], status: 'implemented'
	},
	{
		id: 'IF-4', producer: 'Part 3 → Part 2', consumer: 'Part 1', purpose: 'Confirmation response outcome.',
		payload: ['outcome', 'projectId', 'existingId', 'incoming'], status: 'implemented'
	},
	{
		id: 'IF-5', producer: 'Part 2', consumer: 'Part 1', purpose: 'Retrieval request.',
		payload: ['projectId', 'query', 'intent', 'openFiles', 'recentTurns', 'maxResults', 'maxTokenBudget'], status: 'implemented'
	},
	{
		id: 'IF-6', producer: 'Part 1', consumer: 'Part 2', purpose: 'Ranked memory list with signals behind the score.',
		payload: ['id', 'content', 'score', 'category', 'sourceRef', 'projectId'], status: 'implemented'
	},
	{
		id: 'IF-7', producer: 'Part 2', consumer: 'Part 1', purpose: 'Editor and classified-intent signals.',
		payload: ['openFiles', 'intent', 'projectModule', 'currentTask'], status: 'implemented'
	},
	{
		id: 'IF-8', producer: 'Part 2 / Part 3', consumer: 'Part 1', purpose: 'Natural-language historical reasoning query.',
		payload: ['projectId', 'question'], status: 'implemented'
	},
	{
		id: 'IF-9', producer: 'Part 1', consumer: 'Part 3 / Part 2', purpose: 'Grounded reasoning answer with citations.',
		payload: ['projectId', 'question', 'status', 'answer', 'citations', 'plan'], status: 'implemented'
	},
	{
		id: 'IF-10', producer: 'Part 1 / Part 2', consumer: 'Part 3', purpose: 'Structured stage telemetry.',
		payload: ['stage', 'durationMs', 'payload'], status: 'published'
	},
	{
		id: 'IF-11', producer: 'Part 1', consumer: 'Parts 2 and 3', purpose: 'Versioned schema, migrations and repository interfaces.',
		payload: ['migrations', 'schemaVersion', 'repositories', 'weightProfile'], status: 'implemented'
	},
	{
		id: 'IF-12', producer: 'Part 1', consumer: 'Part 1 retrieval / Part 3 policy', purpose: 'Ranked-result cache read/write.',
		payload: ['key', 'value'], status: 'published'
	}
];

export interface PpbApiDescriptor {
	readonly version: string;
	readonly schemaVersion: string;
	readonly weightProfileVersion: string;
	readonly interfaces: readonly PpbInterfaceDescriptor[];
}

/** Machine-readable description Parts 2/3 can assert against without reading Part 1 source. */
export function describePpbApi(): PpbApiDescriptor {
	const schemaVersion = PPB_MIGRATIONS.length > 0 ? PPB_MIGRATIONS[PPB_MIGRATIONS.length - 1].version : '0';
	return {
		version: PPB_API_VERSION,
		schemaVersion,
		weightProfileVersion: WEIGHT_PROFILE_VERSION,
		interfaces: PPB_INTERFACES
	};
}