/*---------------------------------------------------------------------------------------------
 *  CodeMind — Phase 1 Part 1 (PPB) live demo
 *
 *  Runs the real Project Brain pipeline against the configured provider and prints every stage:
 *    ingest → extract (IF-2) → persist + embed + project → retrieve/rank (IF-6)
 *    → reason with citations (IF-9) → insufficient-evidence guard.
 *
 *  Prereqs: Docker stack up, workbench compiled to vscodium/vscode/out, and the env from
 *  docs/ppb/DEMO_RUNBOOK.md §2. Run with:  node scripts/demo-ppb.mjs
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const outBase = resolve(here, '..', 'vscodium', 'vscode', 'out', 'vs', 'workbench', 'contrib', 'codemindAgent', 'node', 'ppb');
const load = async (rel) => import(pathToFileURL(resolve(outBase, rel)).href);

const { loadPpbConfig, PPB_EMBEDDING_DIM } = await load('config.js');
const { createPgClient, applyPpbMigrations } = await load('storage/pg.js');
const { createNeo4jDriver } = await load('storage/neo4j.js');
const { GraphRepository } = await load('graph/graphRepo.js');
const { projectOutbox } = await load('graph/projector.js');
const { PpbSegmentSink } = await load('sink.js');
const { PpbExtractor } = await load('extraction/validate.js');
const { createExtractionClient } = await load('llm/client.js');
const { createEmbeddingClient } = await load('embeddings/embedder.js');
const { PpbRetriever } = await load('retrieval/retriever.js');
const { reason } = await load('reasoning/reasoner.js');
const { createDecision, recordEvent } = await load('decisions/decisionMemory.js');
const { findFacts } = await load('storage/read.js');

const config = loadPpbConfig();
if (!config.extractModel) {
	console.error('PPB_EXTRACT_MODEL is not set — see docs/ppb/DEMO_RUNBOOK.md §2.');
	process.exit(1);
}

const PROJECT = 'demo-project';
// Keep console output ASCII-safe so it renders on any Windows codepage.
const ascii = (value) => String(value).replace(/[\u2014\u2013]/g, '-').replace(/\u2192/g, '->');
const line = (title) => console.log(`\n${'='.repeat(72)}\n${ascii(title)}\n${'='.repeat(72)}`);
const show = (label, value) => console.log(`  ${ascii(label)} ${ascii(value)}`);

const client = createPgClient(config.pgUrl);
await client.connect();
const driver = createNeo4jDriver(config);
const repo = new GraphRepository(driver);
const embedding = createEmbeddingClient(config);

try {
	line('0. Reset schema and apply versioned migrations (IF-11)');
	await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
	await applyPpbMigrations(config);
	await client.query("INSERT INTO projects (id, name) VALUES ($1, 'Demo Project')", [PROJECT]);
	show('embedding model:', `${config.embedModel} (${PPB_EMBEDDING_DIM} dims)`);
	show('extraction model:', config.extractModel);

	line('1. Ingest a conversation turn (IF-1) → extract facts (IF-2) → store + embed + project');
	const extractor = new PpbExtractor({
		client: createExtractionClient(config.extractBaseUrl, config.extractModel, config.extractApiKey, config.extractTimeoutMs)
	});
	const sink = new PpbSegmentSink({ extractor, write: client, projector: repo, embedder: embedding });
	const turn = 'We use PostgreSQL for persistence. We chose Clerk for authentication and rejected Auth.js because it lacked the features we needed.';
	show('turn:', JSON.stringify(turn));
	const t0 = Date.now();
	await sink.ingest([{
		projectId: PROJECT, turnId: `turn-${Date.now()}`, role: 'user', text: turn,
		intent: 'architecture', timestamp: Date.now(),
		editorState: { cwd: '', openFiles: [], workspaceName: 'demo' }
	}]);
	show('pipeline:', `${Date.now() - t0} ms`);

	const facts = await findFacts(client, PROJECT, {});
	for (const fact of facts) {
		show(`[${fact.category}]`, `${fact.content}`);
	}

	line('2. Store a decision and a dated event (§10/§11), then project the outbox to Neo4j (§24)');
	const clerk = await createDecision(client, {
		projectId: PROJECT, decision: 'Use Clerk for authentication',
		reason: 'Best developer experience and prebuilt components',
		alternatives: 'Auth.js', rejectedAlternatives: ['Auth.js'], author: 'developer',
		decidedAt: '2026-01-01T00:00:00.000Z'
	});
	await recordEvent(client, { projectId: PROJECT, eventType: 'changed', description: 'Deployment moved to AWS', occurredAt: '2026-01-31T00:00:00.000Z' });
	const projection = await projectOutbox(client, repo);
	show('projected:', `${projection.projected} event(s), remaining ${projection.remaining}`);
	show('decision id:', clerk.id);

	line('3. Retrieval request (IF-5) → hybrid retrieval + seven-signal ranking (IF-6)');
	const retriever = new PpbRetriever({ read: client, graph: repo, embedding });
	const ranked = await retriever.retrieve({
		projectId: PROJECT, query: 'PostgreSQL persistence', intent: 'architecture',
		openFiles: [], recentTurns: [], maxResults: 5, maxTokenBudget: 2000
	});
	for (const [index, fact] of ranked.entries()) {
		show(`#${index + 1} (score ${fact.score.toFixed(3)})`, `[${fact.category}] ${fact.content}`);
	}

	line('4. Reasoning query (IF-8) → grounded answer with citations (IF-9)');
	for (const question of [
		'Why did we choose Clerk for authentication?',
		'What authentication libraries were evaluated but not selected?',
		'What database are we currently using?',
		'Show all deployment decisions made since the project started.'
	]) {
		const answer = await reason({ read: client, graph: repo }, { projectId: PROJECT, question });
		show('Q:', question);
		show('A:', `(${answer.status})`);
		console.log(ascii(answer.answer).split('\n').map(l => `      ${l}`).join('\n'));
		console.log('      citations:');
		for (const citation of answer.citations) {
			show('  -', `${citation.sourceType} ${citation.id}: ${citation.content}`);
		}
	}

	line('5. Insufficient-evidence guard (§17.9) — never fabricate');
	const unknown = await reason({ read: client, graph: repo }, { projectId: PROJECT, question: 'Why did we choose Stripe for payments?' });
	show('status:', unknown.status);
	show('answer:', unknown.answer);

	line('Demo complete');
} finally {
	const session = driver.session();
	try {
		await session.run('MATCH (n {projectId: $projectId}) DETACH DELETE n', { projectId: PROJECT });
	} finally {
		await session.close();
		await driver.close();
	}
	await client.end();
}
