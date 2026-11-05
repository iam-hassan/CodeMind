/*---------------------------------------------------------------------------------------------
 *  Parse test_scenarios.docx (extracted to docs/ppb/test_scenarios.txt) into scenarios.json.
 *
 *  The .docx is a zip; its text was extracted to docs/ppb/test_scenarios.txt. This script turns
 *  that flat text into a structured list so coverage/status can be tracked and reported.
 *
 *    node scripts/scenarios/parse-scenarios.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', 'docs', 'ppb', 'test_scenarios.txt');
const out = resolve(here, 'scenarios.json');

const lines = readFileSync(src, 'utf8').split(/\r?\n/);

const GROUP_OWNER = {
	A: 'Part 2 (ingestion/identity)',
	B: 'Part 1 (extraction)',
	C: 'Part 1 (graph/data model)',
	D: 'Mixed (ranking=Part 1, injection=Part 2)',
	E: 'Part 1 (conflict/versioning)',
	F: 'Part 1 (reasoning)',
	G: 'Headroom (Part 2 / headroom-ai proxy)',
	H: 'Mixed (E2E across all parts)'
};

const SECTION_LABELS = ['Input Prompt', 'Context / State', 'Expected Output', 'Headroom Check'];

const scenarios = [];
let group = '?';
let current = null;
let section = null;

function flush() {
	if (!current) { return; }
	for (const key of ['input', 'context', 'expected', 'headroomCheck']) {
		current[key] = current[key].join('\n').trim();
	}
	current.note = current.note.join('\n').trim();
	current.critical = /CRITICAL/i.test(current.headroomCheck);
	current.owner = GROUP_OWNER[current.group] ?? '?';
	scenarios.push(current);
	current = null;
	section = null;
}

for (const raw of lines) {
	const line = raw.replace(/\s+$/, '');

	const groupHeader = line.match(/^[A-Z]\.\s+Group ([A-H]):/);
	if (groupHeader) { flush(); group = groupHeader[1]; continue; }

	const header = line.match(/^(S-\d{3})\s{2,}(.+)$/);
	if (header) {
		flush();
		current = { id: header[1], title: header[2].trim(), group, stage: '', difficulty: '', input: [], context: [], expected: [], headroomCheck: [], note: [] };
		continue;
	}

	if (!current) { continue; }

	const stage = line.match(/^Stage:\s*(.+?)\s*\|\s*Difficulty:\s*(.+)$/);
	if (stage) { current.stage = stage[1].trim(); current.difficulty = stage[2].trim(); continue; }

	if (SECTION_LABELS.includes(line.trim())) { section = line.trim(); continue; }

	if (/^Note:/i.test(line)) { current.note.push(line); continue; }

	const key = section === 'Input Prompt' ? 'input'
		: section === 'Context / State' ? 'context'
		: section === 'Expected Output' ? 'expected'
		: section === 'Headroom Check' ? 'headroomCheck'
		: null;
	if (key) { current[key].push(line); }
}

flush();

const byGroup = {};
for (const s of scenarios) { byGroup[s.group] = (byGroup[s.group] ?? 0) + 1; }

writeFileSync(out, JSON.stringify({ count: scenarios.length, byGroup, scenarios }, null, 2));
console.log(`parsed ${scenarios.length} scenarios -> ${out}`);
console.log('by group:', JSON.stringify(byGroup));
const missing = scenarios.filter(s => !s.stage || !s.input || !s.expected);
console.log('incomplete:', missing.length, missing.map(s => s.id).join(', '));
