/*---------------------------------------------------------------------------------------------
 *  Group H walkthrough — real projects, real pipeline, real databases.
 *
 *  For every project in projects.mjs this script:
 *    1. drives the REAL extraction engine over the scenario's conversation turns,
 *    2. persists facts to PostgreSQL, embeds them, and projects the outbox to Neo4j,
 *    3. records decisions/events through the real write path,
 *    4. runs the TaskFlow migration conflict through detection + versioning (S-168),
 *    5. runs real retrieval and reasoning,
 *    6. then INSPECTS PostgreSQL and Neo4j and prints what is actually stored.
 *
 *  Requires: Docker stack up, workbench compiled, and the provider env (DEMO_RUNBOOK section 2).
 *    node scripts/demo-projects/run.mjs
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';
import { writeFileSync } from 'fs';
import { PROJECTS } from './projects.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outBase = resolve(here, '..', '..', 'vscodium', 'vscode', 'out', 'vs', 'workbench', 'contrib', 'codemindAgent', 'node', 'ppb');
const load = (rel) => import(pathToFileURL(resolve(outBase, rel)).href);

const { loadPpbConfig, PPB_EMBEDDING_DIM } = await load('config.js');
const { createPgClient, applyPpbMigrations } = await load('storage/pg.js');
const { createNeo4jDriver } = await load('storage/neo4j.js');
const { GraphRepository } = await load('graph/graphRepo.js');
const { projectOutbox } = await load('graph/projector.js');
const { PpbSegmentSink } = await load('sink.js');
const { PpbExtractor } = await load('extraction/validate.js');
const { createExtractionClient } = await load('llm/client.js');
const { createEmbeddingClient } = await load('embeddings/embedder.js');
const { upsertEmbedding } = await load('embeddings/vectorStore.js');
const { PpbRetriever } = await load('retrieval/retriever.js');
const { reason } = await load('reasoning/reasoner.js');
const { createDecision, recordEvent, listDecisions, listEvents } = await load('decisions/decisionMemory.js');
const { persistFacts } = await load('storage/write.js');
const { findFacts, getFact } = await load('storage/read.js');
const { detectConflict, persistConflictReport } = await load('conflict/detector.js');
const { applyConfirmation } = await load('versioning/versionStore.js');

const config = loadPpbConfig();
if (!config.extractModel) {
	console.error('PPB_EXTRACT_MODEL is not set - see docs/ppb/DEMO_RUNBOOK.md section 2.');
	process.exit(1);
}

const line = (t) => console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`);
const show = (l, v) => console.log(`  ${l} ${v}`);

const client = createPgClient(config.pgUrl);
await client.connect();
const driver = createNeo4jDriver(config);
const repo = new GraphRepository(driver);
const embedding = createEmbeddingClient(config);

function segment(projectId, text, turnId) {
	return { projectId, turnId, role: 'user', text, intent: 'architecture', timestamp: Date.now(), editorState: { cwd: '', openFiles: [], workspaceName: '' } };
}

async function embedFact(id, content) {
	const [vector] = await embedding.embed([content]);
	await upsertEmbedding(client, { ownerKind: 'fact', ownerId: id, embedding: vector, embeddedText: content });
}

const report = { embeddingDim: PPB_EMBEDDING_DIM, extractModel: config.extractModel, projects: {} };

try {
	line('0. Reset schema, apply migrations, register the demo projects');
	await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
	await applyPpbMigrations(config);
	for (const project of PROJECTS) {
		await client.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [project.id, project.name]);
	}
	// Clear any stale graph nodes from a previous run (PostgreSQL was reset above; Neo4j was not).
	const clear = driver.session();
	try {
		await clear.run('MATCH (n) WHERE n.projectId IN $ids DETACH DELETE n', { ids: PROJECTS.map(p => p.id) });
	} finally { await clear.close(); }
	console.log(`  registered: ${PROJECTS.map(p => p.id).join(', ')}`);

	// --- ingest every project's conversation turns through the REAL extraction engine --------
	line('1. Ingest each project through the real extraction engine (IF-1 -> IF-2 -> store/embed/project)');
	const extractor = new PpbExtractor({
		client: createExtractionClient(config.extractBaseUrl, config.extractModel, config.extractApiKey, config.extractTimeoutMs),
		log: (m) => console.log(`     [sink] ${m}`)
	});

	for (const project of PROJECTS) {
		const sink = new PpbSegmentSink({ extractor, write: client, projector: repo, embedder: embedding, log: (m) => console.log(`     [sink:${project.id}] ${m}`) });
		console.log(`\n  -- ${project.id}`);
		await sink.ingest([segment(project.id, project.setup, `${project.id}-setup`)]);
		for (const [i, turn] of project.extraTurns.entries()) {
			await sink.ingest([segment(project.id, turn, `${project.id}-turn-${i + 1}`)]);
		}

		for (const d of project.decisions) {
			await createDecision(client, { projectId: project.id, ...d });
		}
		for (const e of project.events) {
			await recordEvent(client, { projectId: project.id, ...e });
		}

		let facts = await findFacts(client, project.id, {});
		if (facts.length === 0) {
			// Provider gave nothing for this turn - still exercise the real write path so the
			// project has at least the canonical stack fact. Marked so it is not hidden.
			const fallback = {
				category: 'technology_stack', content: project.setup, confidence: 0.7, importance: 0.7,
				sourceRef: `${project.id}:setup`, author: 'developer', extractedAt: new Date().toISOString()
			};
			const written = await persistFacts(client, project.id, [fallback]);
			await embedFact(written.results[0].factId, fallback.content);
			facts = await findFacts(client, project.id, {});
			console.log(`     extraction returned 0 -> persisted canonical fallback fact`);
		}
		console.log(`  ${project.id}: ${facts.length} fact(s)`);
	}

	await projectOutbox(client, repo);

	// --- S-168: real conflict + versioning on TaskFlow (PostgreSQL -> MySQL) ------------------
	line('2. S-168: conflict detection + versioning (TaskFlow migrates PostgreSQL -> MySQL)');
	const taskflow = PROJECTS.find(p => p.id === 'taskflow');
	let pgFact = (await findFacts(client, 'taskflow', { category: 'technology_stack' })).find(f => /postgres/i.test(f.content));
	if (!pgFact) {
		const content = 'The project uses PostgreSQL as its primary database';
		const written = await persistFacts(client, 'taskflow', [{ category: 'technology_stack', content, confidence: 0.9, importance: 0.8, sourceRef: 'taskflow:setup', author: 'developer', extractedAt: '2026-01-02T00:00:00.000Z' }]);
		await embedFact(written.results[0].factId, content);
		pgFact = await getFact(client, 'taskflow', written.results[0].factId);
	}
	show('existing memory:', `${pgFact.id} :: ${pgFact.content}`);

	const incoming = {
		id: '11111111-1111-4111-8111-111111111111',
		category: 'technology_stack',
		content: taskflow.migration.incomingContent,
		confidence: 0.95, importance: 0.9,
		sourceRef: 'taskflow:week4', author: 'developer', extractedAt: taskflow.migration.occurredAt
	};
	const conflict = detectConflict(pgFact, incoming, {});
	if (!conflict) {
		console.log('  WARNING: detector did not flag a conflict for the migration prompt.');
	} else {
		const reportId = await persistConflictReport(client, conflict);
		show('IF-3 conflict report:', `${reportId} (severity=${conflict.severity})`);
		const resolved = await applyConfirmation(client, 'taskflow', pgFact.id, incoming, 'accept_migration', { reason: 'client requires MySQL' });
		show('IF-4 outcome:', `accept_migration -> active=${resolved.activeId}`);
		await recordEvent(client, { projectId: 'taskflow', eventType: 'migrated', description: taskflow.migration.eventDescription, occurredAt: taskflow.migration.occurredAt, sourceRef: 'taskflow:week4' });
		await projectOutbox(client, repo);
		const oldAfter = await getFact(client, 'taskflow', pgFact.id);
		const newAfter = await getFact(client, 'taskflow', resolved.incomingId);
		show('old memory status:', oldAfter?.status);
		show('new memory status:', newAfter?.status);
	}

	// --- real retrieval + reasoning -----------------------------------------------------------
	line('3. Real retrieval (IF-5 -> IF-6) per project');
	const retriever = new PpbRetriever({ read: client, graph: repo, embedding });
	for (const project of PROJECTS) {
		const ranked = await retriever.retrieve({ projectId: project.id, query: project.setup.slice(0, 80), intent: 'architecture', openFiles: [], recentTurns: [], maxResults: 5, maxTokenBudget: 2000 });
		console.log(`  ${project.id}: ${ranked.length} ranked memory(ies)`);
		for (const r of ranked.slice(0, 3)) { show('   #', `${r.score.toFixed(3)} [${r.category}] ${r.content}`); }
	}

	line('4. Real reasoning (IF-8 -> IF-9)');
	const qa = [
		['taskflow', 'Why did we choose Prisma?'],
		['taskflow', 'When did we migrate from PostgreSQL to MySQL?'],
		['blogplatform', 'What database are we currently using?'],
		['realestate-api', 'What API standard applies to every endpoint?'],
		['mobileapp-bff', 'What query language does the backend use?']
	];
	for (const [pid, question] of qa) {
		const answer = await reason({ read: client, graph: repo }, { projectId: pid, question });
		console.log(`\n  Q[${pid}]: ${question}`);
		console.log(`  A (${answer.status}): ${answer.answer.split('\n').join('\n     ')}`);
		console.log(`  citations: ${answer.citations.map(c => `${c.sourceType}:${c.id}`).join(', ') || '(none)'}`);
	}

	// --- S-174: isolation ---------------------------------------------------------------------
	line('5. S-174: cross-project isolation');
	const blog = await reason({ read: client, graph: repo }, { projectId: 'blogplatform', question: 'What database are we currently using?' });
	const flow = await reason({ read: client, graph: repo }, { projectId: 'taskflow', question: 'What database are we currently using?' });
	console.log(`  blogplatform mentions postgres: ${/postgres/i.test(blog.answer)}`);
	console.log(`  blogplatform mentions mysql   : ${/mysql/i.test(blog.answer)}`);
	console.log(`  taskflow mentions mysql       : ${/mysql/i.test(flow.answer)}`);

	// --- INSPECT POSTGRESQL -------------------------------------------------------------------
	line('6. POSTGRESQL: what is actually stored');
	const pgMemories = await client.query(`SELECT project_id, category, status, count(*) AS n FROM memories GROUP BY project_id, category, status ORDER BY project_id, category, status`);
	console.log('  memories by project/category/status:');
	for (const r of pgMemories.rows) { show('   ', `${r.project_id} | ${r.category} | ${r.status} | ${r.n}`); }
	const pgCounts = await client.query(`SELECT (SELECT count(*) FROM memories) AS memories, (SELECT count(*) FROM decisions) AS decisions, (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM embeddings) AS embeddings, (SELECT count(*) FROM memory_versions) AS versions, (SELECT count(*) FROM conflict_reports) AS conflicts, (SELECT count(*) FROM neo4j_outbox WHERE processed_at IS NULL) AS outbox_pending`);
	show('totals:', JSON.stringify(pgCounts.rows[0]));
	const statuses = await client.query(`SELECT project_id, content, status, superseded_by FROM memories WHERE project_id='taskflow' AND category='technology_stack' ORDER BY status`);
	console.log('  taskflow technology_stack after migration:');
	for (const r of statuses.rows) { show('   ', `[${r.status}] ${r.content}${r.superseded_by ? ' -> ' + r.superseded_by : ''}`); }

	// --- INSPECT NEO4J ------------------------------------------------------------------------
	line('7. NEO4J: what is actually stored');
	const session = driver.session();
	try {
		const nodeCounts = await session.run(`MATCH (n) WHERE n.projectId IS NOT NULL RETURN n.projectId AS project, labels(n)[0] AS label, count(*) AS n ORDER BY project, label`);
		console.log('  nodes by project/label:');
		for (const rec of nodeCounts.records) { show('   ', `${rec.get('project')} | ${rec.get('label')} | ${rec.get('n')}`); }
		const relCounts = await session.run(`MATCH (a)-[r]->(b) WHERE a.projectId IS NOT NULL RETURN a.projectId AS project, type(r) AS rel, count(*) AS n ORDER BY project, rel`);
		console.log('  relationships by project/type:');
		for (const rec of relCounts.records) { show('   ', `${rec.get('project')} | ${rec.get('rel')} | ${rec.get('n')}`); }
		const sample = await session.run(`MATCH (n) WHERE n.projectId IS NOT NULL RETURN n.projectId AS project, labels(n)[0] AS label, coalesce(n.name, n.decision, n.description, n.id) AS label_text LIMIT 12`);
		console.log('  sample nodes:');
		for (const rec of sample.records) { show('   ', `${rec.get('project')} | ${rec.get('label')} | ${String(rec.get('label_text')).slice(0, 70)}`); }
	} finally { await session.close(); }

	// --- report -------------------------------------------------------------------------------
	report.projects = Object.fromEntries(await Promise.all(PROJECTS.map(async p => [p.id, {
		facts: (await findFacts(client, p.id, {})).length,
		decisions: (await listDecisions(client, p.id)).length,
		events: (await listEvents(client, p.id)).length
	}])));
	report.totals = pgCounts.rows[0];
	writeFileSync(resolve(here, 'run-report.json'), JSON.stringify(report, null, 2));
	line('Done - data remains in PostgreSQL and Neo4j for inspection');
} finally {
	await driver.close();
	await client.end();
}
