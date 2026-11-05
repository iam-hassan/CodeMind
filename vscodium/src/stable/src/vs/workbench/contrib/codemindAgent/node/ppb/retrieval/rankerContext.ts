/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The editor/intent context consumed by the ranking engine (IF-7, spec §16.2). */
export interface RankingContextCarrier {
	/** Classified developer intent (IF-7). */
	readonly intent?: string;
	/** Currently open files (IF-7). */
	readonly openFiles?: readonly string[];
	/** The current task/query text (IF-7). */
	readonly currentTask?: string;
	/** The project module currently in focus (IF-7). */
	readonly projectModule?: string;
}