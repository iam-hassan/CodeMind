/*---------------------------------------------------------------------------------------------
 *  Build docs/ppb/SCENARIO_INDEX.md from scripts/scenarios/scenarios.json.
 *    node scripts/scenarios/report.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(here, 'scenarios.json'), 'utf8'));

const GROUP_STATUS = {
	A: 'blocked - Part 2 (capture, project registry, buffering, backfill, intent)',
	B: 'covered - Part 1 extraction suite',
	C: 'covered - Part 1 graph/data-model suite (Project/USES/PART_OF/SUPERSEDES verified on demo projects)',
	D: 'partial - ranking covered; injection formatting is Part 2',
	E: 'covered - Part 1 conflict/versioning suite',
	F: 'covered - Part 1 reasoning suite',
	G: 'verified - Headroom proxy (scripts/headroom-verify.mjs)',
	H: 'mixed - Part 1 slices covered; UI/eval slices are Part 2/3'
};

const rows = data.scenarios.map(s => {
	const status = GROUP_STATUS[s.group] ?? '?';
	const crit = s.critical ? 'YES' : '';
	return `| ${s.id} | ${s.title.replace(/\|/g, '\\|')} | ${s.group} | ${s.stage} | ${status} | ${crit} |`;
});

const critical = data.scenarios.filter(s => s.critical).map(s => s.id);

const md = [
	'# Test Scenario Index (200) - ownership & status',
	'',
	'Generated from `test_scenarios.docx` (extracted to `docs/ppb/test_scenarios.txt`) by',
	'`scripts/scenarios/parse-scenarios.mjs` + `scripts/scenarios/report.mjs`.',
	'',
	`Scenarios: **${data.count}** - by group ${JSON.stringify(data.byGroup)}.`,
	'',
	`Critical Headroom tests: **${critical.join(', ')}**.`,
	'',
	'Status is a **coverage basis**, not a per-scenario execution result:',
	'- `verified - Headroom proxy`: measured end to end by `scripts/headroom-verify.mjs`.',
	'- `covered - Part 1 ...`: the behaviour is exercised by the automated Part 1 suite (see',
	'  `docs/ppb/SCENARIO_VERIFICATION_REPORT.md` for the exact files/commands).',
	'- `blocked - Part 2 ...`: needs ingestion/identity/UI code owned by Part 2.',
	'- `partial` / `mixed`: some of the scenario is Part 1, the rest Part 2/3.',
	'',
	'| ID | Title | Group | Stage | Status | Critical (Headroom) |',
	'|---|---|---|---|---|---|',
	...rows,
	''
].join('\n');

writeFileSync(resolve(here, '..', '..', 'docs', 'ppb', 'SCENARIO_INDEX.md'), md);
console.log(`wrote docs/ppb/SCENARIO_INDEX.md (${data.count} rows)`);
