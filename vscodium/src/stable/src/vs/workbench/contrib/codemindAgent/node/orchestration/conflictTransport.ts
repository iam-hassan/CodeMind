/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export interface ConflictReport {
	path: string;
	conflictCount: number;
	resolution: 'kept_local' | 'kept_remote' | 'merged';
}
