/*---------------------------------------------------------------------------------------------
 *  Inspect what the real pipeline stored in PostgreSQL and Neo4j.
 *    node scripts/demo-projects/inspect.mjs
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const outBase = resolve(here, '..', '..', 'vscodium', 'vscode', 'out', 'vs', 'workbench', 'contrib', 'codemindAgent', 'node', 'ppb');
const load = (rel) => import(pathToFileURL(resolve(outBase, rel)).href);
const { loadPpbConfig } = await load('config.js');
const { createPgClient } = await load('storage/pg.js');
const { createNeo4jDriver } = await load('storage/neo4j.js');

const config = loadPpbConfig();
const client = createPgClient(config.pgUrl);
await client.connect();
const driver = createNeo4jDriver(config);
const line = (t) => console.log(`\n=== ${t} ===`);

try {
	line('PostgreSQL - row counts');
	for (const r of (await client.query(`SELECT (SELECT count(*) FROM memories) memories, (SELECT count(*) FROM decisions) decisions, (SELECT count(*) FROM events) events, (SELECT count(*) FROM embeddings) embeddings, (SELECT count(*) FROM memory_versions) versions, (SELECT count(*) FROM conflict_reports) conflicts`)).rows) {
		console.log(r);
	}
	line('PostgreSQL - memories by project / category / status');
	console.table((await client.query(`SELECT project_id, category, status, count(*) n FROM memories GROUP BY 1,2,3 ORDER BY 1,2,3`)).rows);
	line('PostgreSQL - decisions & events');
	console.table((await client.query(`SELECT p.id project_id, (SELECT count(*) FROM decisions d WHERE d.project_id=p.id) decisions, (SELECT count(*) FROM events e WHERE e.project_id=p.id) events FROM projects p ORDER BY 1`)).rows);
	line('PostgreSQL - taskflow database facts (migration result)');
	console.table((await client.query(`SELECT status, content, superseded_by FROM memories WHERE project_id='taskflow' AND content ILIKE '%postgres%' OR (project_id='taskflow' AND content ILIKE '%mysql%') ORDER BY status`)).rows);

	const session = driver.session();
	try {
		line('Neo4j - nodes by label');
		console.table((await session.run(`MATCH (n) WHERE n.projectId IS NOT NULL RETURN labels(n)[0] AS node_label, count(*) AS total ORDER BY node_label`)).records.map(r => r.toObject()));
		line('Neo4j - relationships by type');
		console.table((await session.run(`MATCH (a)-[r]->(b) WHERE a.projectId IS NOT NULL RETURN type(r) AS relationship, count(*) AS total ORDER BY relationship`)).records.map(r => r.toObject()));
		line('Neo4j - Project nodes');
		const projects = await session.run(`MATCH (p:Project) RETURN count(p) AS total`);
		console.log('Project nodes:', projects.records[0].get('total').toNumber ? projects.records[0].get('total').toNumber() : projects.records[0].get('total'));
		line('Neo4j - taskflow rejected alternatives');
		console.table((await session.run(`MATCH (d:Decision {projectId:'taskflow'})-[:REJECTED]->(t) RETURN d.decision AS decision, t.name AS rejected`)).records.map(r => r.toObject()));
	} finally { await session.close(); }
} finally {
	await driver.close();
	await client.end();
}
