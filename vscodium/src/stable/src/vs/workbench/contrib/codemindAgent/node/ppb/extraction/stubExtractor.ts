/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConversationSegment } from '../../orchestration/segmentQueue.js';
import type { ExtractionResult, Extractor } from './types.js';

/**
 * M2 stub extractor (spec §21 M2).
 *
 * Returns an empty fact set for every segment, so the ingestion path can be exercised
 * end-to-end without the real extraction engine and without any storage. Replaced by the real
 * extractor at T04/T05 (M3); kept afterwards as the graceful-degradation fallback.
 */
export class StubExtractor implements Extractor {

	async extract(segment: ConversationSegment): Promise<ExtractionResult> {
		return { segmentId: segment.turnId, facts: [] };
	}
}
