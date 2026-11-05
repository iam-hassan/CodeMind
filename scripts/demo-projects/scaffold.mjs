/*---------------------------------------------------------------------------------------------
 *  Write the Group H demo projects to disk under demo-projects/.
 *    node scripts/demo-projects/scaffold.mjs
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { PROJECTS } from './projects.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', 'demo-projects');

let files = 0;
for (const project of PROJECTS) {
	const base = join(root, project.id);
	for (const [rel, content] of Object.entries(project.files)) {
		const full = join(base, ...rel.split('/'));
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, 'utf8');
		files++;
	}
	console.log(`scaffolded ${project.id} -> ${base}`);
}

console.log(`\n${PROJECTS.length} projects, ${files} files under ${root}`);
if (!existsSync(root)) { process.exit(1); }
