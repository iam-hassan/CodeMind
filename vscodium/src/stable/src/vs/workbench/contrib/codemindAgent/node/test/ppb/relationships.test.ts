/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Unit tests for Tier 2 extracted graph relationships (spec §6.4/§6.8). */

import assert from 'assert';
import type { ExtractedFact } from '../../ppb/extraction/types.js';
import { PROJECT_ENDPOINT } from '../../ppb/extraction/types.js';
import { parseExtractionPayloadFull } from '../../ppb/extraction/validate.js';
import { resolveRelationships } from '../../ppb/storage/write.js';

function fact(content: string): ExtractedFact {
	return {
		id: content, category: 'technology_stack', content, confidence: 0.9, importance: 0.7,
		sourceRef: 'projectA:turn-1', author: 'developer', extractedAt: '2026-01-01T00:00:00.000Z'
	};
}

suite('PPB extracted graph relationships (Tier 2, spec §6.4/§6.8)', () => {

	test('resolveRelationships grounds entity names to fact ids and the project sentinel', () => {
		const facts = [fact('The project uses PostgreSQL as its database'), fact('The project is deployed on AWS RDS')];
		const resolved = resolveRelationships('projectA', [
			{ relationshipType: 'DEPENDS_ON', fromName: 'PostgreSQL', toName: 'AWS RDS' },
			{ relationshipType: 'USES', fromName: PROJECT_ENDPOINT, toName: 'PostgreSQL' }
		], facts, ['id-pg', 'id-aws']);
		assert.deepStrictEqual(resolved, [
			{ fromId: 'id-pg', toId: 'id-aws', relationshipType: 'DEPENDS_ON' },
			{ fromId: 'projectA', toId: 'id-pg', relationshipType: 'USES' }
		]);
	});

	test('ungrounded, self-referential and duplicate relationships are dropped', () => {
		const resolved = resolveRelationships('projectA', [
			{ relationshipType: 'DEPENDS_ON', fromName: 'PostgreSQL', toName: 'MongoDB' },
			{ relationshipType: 'USES', fromName: 'PostgreSQL', toName: 'PostgreSQL' },
			{ relationshipType: 'USES', fromName: 'PostgreSQL', toName: 'PostgreSQL' }
		], [fact('PostgreSQL')], ['id-pg']);
		assert.deepStrictEqual(resolved, []);
	});

	test('parseExtractionPayloadFull parses valid relationships and drops malformed ones', () => {
		const text = JSON.stringify({
			facts: [{ category: 'technology_stack', content: 'PostgreSQL' }],
			relationships: [
				{ type: 'DEPENDS_ON', from: 'PostgreSQL', to: 'AWS RDS' },
				{ type: 'NOT_A_TYPE', from: 'x', to: 'y' },
				{ type: 'USES', from: '', to: 'y' }
			]
		});
		const parsed = parseExtractionPayloadFull(text);
		assert.strictEqual(parsed.drafts.length, 1);
		assert.deepStrictEqual(parsed.relationships, [{ relationshipType: 'DEPENDS_ON', fromName: 'PostgreSQL', toName: 'AWS RDS' }]);
	});

	test('an absent relationships array yields an empty list (backwards compatible)', () => {
		const parsed = parseExtractionPayloadFull(JSON.stringify({ facts: [] }));
		assert.deepStrictEqual(parsed.relationships, []);
	});
});
