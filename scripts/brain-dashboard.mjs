/*---------------------------------------------------------------------------------------------
 *  CodeMind — Project Brain dashboard (development)
 *
 *  A local read-only view of what the Persistent Project Brain is actually storing and how a
 *  message flowed through the layers:
 *    - projects: registered workspaces (~/.codemind/projects.json) merged with the DB
 *    - PostgreSQL: memories, decisions, events, conflicts, embeddings, outbox, telemetry
 *    - Neo4j: the knowledge graph (scoped to the selected project)
 *    - ppb_telemetry: one row per layer pass (capture/retrieve/inject/extract/persist/embed/project)
 *
 *  Run:  node scripts/brain-dashboard.mjs     then open http://127.0.0.1:20200
 *  Optional env: BRAIN_DASHBOARD_PORT, PPB_PG_URL, PPB_NEO4J_URL, PPB_NEO4J_USER/PASSWORD
 *--------------------------------------------------------------------------------------------*/

import http from 'http';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { readFile, rm, readdir } from 'fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '..', 'vscodium', 'vscode', 'package.json'));
const { Client } = require('pg');
const neo4j = require('neo4j-driver');

const PORT = Number(process.env.BRAIN_DASHBOARD_PORT ?? 20200);
const PG_URL = process.env.PPB_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/codemind_ppb';
const NEO4J_URL = process.env.PPB_NEO4J_URL ?? 'bolt://localhost:57687';
const NEO4J_USER = process.env.PPB_NEO4J_USER ?? 'neo4j';
const NEO4J_PASSWORD = process.env.PPB_NEO4J_PASSWORD ?? 'codemindppb';
const REGISTRY_FILE = join(os.homedir(), '.codemind', 'projects.json');

const LAYERS = [
	{ id: 'capture', label: '1. Chat capture', part: 'Part 2', store: 'queue', what: 'Captures the turn, redacts PII, buffers, pre-filters chatter' },
	{ id: 'extract', label: '2. Extraction', part: 'Part 1', store: '—', what: 'LLM reads the turn and emits typed facts' },
	{ id: 'persist', label: '3. Storage', part: 'Part 1', store: 'PostgreSQL', what: 'Writes facts, decisions, events, versions, embeddings' },
	{ id: 'embed', label: '3b. Embedding', part: 'Part 1', store: 'pgvector', what: 'Generates a vector per fact for semantic search' },
	{ id: 'project', label: '4. Graph projection', part: 'Part 1', store: 'Neo4j', what: 'Drains the outbox into the knowledge graph' },
	{ id: 'retrieve', label: '5. Retrieval', part: 'Part 1', store: '—', what: 'Vector + graph expansion → candidate memories' },
	{ id: 'inject', label: '6. Injection', part: 'Part 2', store: '—', what: 'Formats ranked memories into the prompt block' },
	{ id: 'inference', label: '7. Inference', part: 'SDK', store: '—', what: 'The model answers / edits with that context' }
];

async function readRegistry() {
	try {
		const parsed = JSON.parse(await readFile(REGISTRY_FILE, 'utf8'));
		const projects = parsed?.projects && typeof parsed.projects === 'object' ? parsed.projects : {};
		return Object.values(projects).map((rec) => ({
			projectId: rec?.identity?.projectId ?? null,
			name: rec?.identity?.workspaceName ?? rec?.identity?.repoPath ?? null,
			repoPath: rec?.identity?.repoPath ?? null,
		})).filter((p) => p.projectId);
	} catch {
		return [];
	}
}

async function pgData(project) {
	const client = new Client({ connectionString: PG_URL });
	await client.connect();
	try {
		const q = async (text, params) => (await client.query(text, params)).rows;
		const one = async (text, params) => Number((await q(text, params))[0]?.n ?? 0);

		const dbProjects = await q('SELECT id, name, created_at FROM projects ORDER BY created_at DESC');

		// Global counts.
		const counts = {
			memories: await one('SELECT count(*)::int n FROM memories'),
			decisions: await one('SELECT count(*)::int n FROM decisions'),
			events: await one('SELECT count(*)::int n FROM events'),
			conflicts: await one('SELECT count(*)::int n FROM conflict_reports'),
			versions: await one('SELECT count(*)::int n FROM memory_versions'),
			embeddings: await one('SELECT count(*)::int n FROM embeddings'),
			outbox_pending: await one('SELECT count(*)::int n FROM neo4j_outbox WHERE processed_at IS NULL'),
			telemetry: await one('SELECT count(*)::int n FROM ppb_telemetry'),
		};

		// Selected project's counts (the "did it store" checklist).
		let projectCounts = null;
		if (project) {
			projectCounts = {
				memories: await one('SELECT count(*)::int n FROM memories WHERE project_id=$1', [project]),
				decisions: await one('SELECT count(*)::int n FROM decisions WHERE project_id=$1', [project]),
				events: await one('SELECT count(*)::int n FROM events WHERE project_id=$1', [project]),
				conflicts: await one('SELECT count(*)::int n FROM conflict_reports WHERE project_id=$1', [project]),
				embeddings: await one('SELECT count(*)::int n FROM embeddings e JOIN memories m ON m.id=e.owner_id WHERE m.project_id=$1', [project]),
				telemetry: await one('SELECT count(*)::int n FROM ppb_telemetry WHERE project_id=$1', [project]),
			};
		}

		const w = project ? 'WHERE project_id=$1' : '';
		const p = project ? [project] : [];
		const memories = await q(`SELECT project_id, category, content, status, importance, extracted_at FROM memories ${w} ORDER BY extracted_at DESC LIMIT 300`, p);
		const decisions = await q(`SELECT project_id, decision, reason, alternatives, status, decided_at FROM decisions ${w} ORDER BY decided_at DESC LIMIT 100`, p);
		const events = await q(`SELECT project_id, event_type, description, occurred_at FROM events ${w} ORDER BY occurred_at DESC LIMIT 100`, p);
		const conflicts = await q(`SELECT project_id, category, severity, question, status, resolution, created_at FROM conflict_reports ${w} ORDER BY created_at DESC LIMIT 100`, p);
		const outbox = await q('SELECT id, event_type, created_at FROM neo4j_outbox WHERE processed_at IS NULL ORDER BY created_at DESC LIMIT 50');
		const telemetry = await q(`SELECT project_id, stage, duration_ms, payload, recorded_at FROM ppb_telemetry ${w} ORDER BY recorded_at DESC LIMIT 200`, p);
		const memoryCounts = await q('SELECT project_id, count(*)::int AS n FROM memories GROUP BY project_id');
		const embeddingCounts = await q('SELECT m.project_id, count(*)::int AS n FROM embeddings e JOIN memories m ON m.id=e.owner_id GROUP BY m.project_id');

		return { dbProjects, counts, projectCounts, memories, decisions, events, conflicts, outbox, telemetry, memoryCounts, embeddingCounts };
	} finally {
		await client.end();
	}
}

async function neo4jData(project) {
	const driver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
	const session = driver.session();
	try {
		const nodeQuery = project
			? 'MATCH (n {projectId: $project}) RETURN elementId(n) AS eid, labels(n) AS labels, n.id AS id, n.projectId AS projectId, n.name AS name, n.title AS title'
			: 'MATCH (n) RETURN elementId(n) AS eid, labels(n) AS labels, n.id AS id, n.projectId AS projectId, n.name AS name, n.title AS title';
		const relQuery = project
			? 'MATCH (a {projectId: $project})-[r]->(b {projectId: $project}) RETURN elementId(a) AS from, elementId(b) AS to, type(r) AS type'
			: 'MATCH (a)-[r]->(b) RETURN elementId(a) AS from, elementId(b) AS to, type(r) AS type';
		const params = project ? { project } : {};
		const nodes = (await session.run(nodeQuery, params)).records.map((r) => ({
			eid: String(r.get('eid')), labels: r.get('labels'),
			id: r.get('id') === null ? null : String(r.get('id')),
			projectId: r.get('projectId') === null ? null : String(r.get('projectId')),
			name: r.get('name') === null ? null : String(r.get('name')),
			title: r.get('title') === null ? null : String(r.get('title')),
		}));
		const rels = (await session.run(relQuery, params)).records.map((r) => ({ from: String(r.get('from')), to: String(r.get('to')), type: r.get('type') }));
		const labelCounts = {};
		for (const n of nodes) { const l = (n.labels && n.labels[0]) || 'Node'; labelCounts[l] = (labelCounts[l] || 0) + 1; }
		return { nodes, rels, labelCounts };
	} finally {
		await session.close();
		await driver.close();
	}
}

function mergeProjects(dbProjects, registry, memoryCounts, embeddingCounts) {
	const memOf = new Map((memoryCounts ?? []).map((r) => [r.project_id, r.n]));
	const embOf = new Map((embeddingCounts ?? []).map((r) => [r.project_id, r.n]));
	const map = new Map();
	for (const p of registry) { map.set(p.projectId, { id: p.projectId, name: p.name || p.projectId, repoPath: p.repoPath, source: 'registry' }); }
	for (const p of dbProjects) {
		const cur = map.get(p.id);
		if (cur) { cur.source = 'both'; cur.dbName = p.name; }
		else { map.set(p.id, { id: p.id, name: p.name || p.id, source: 'db' }); }
	}
	for (const p of map.values()) { p.memories = memOf.get(p.id) ?? 0; p.embeddings = embOf.get(p.id) ?? 0; }
	return [...map.values()].sort((a, b) => (b.memories - a.memories) || String(a.name).localeCompare(String(b.name)));
}

const CLAUDE_DIR = join(os.homedir(), '.claude');

/** Remove the Claude Agent SDK's persisted session .jsonl files and todo files. */
async function resetSdkRuntime(project) {
	const removed = {};
	if (project) {
		const repoPath = (await readRegistry()).find((p) => p.projectId === project)?.repoPath;
		if (repoPath) {
			const enc = repoPath.replace(/[:\\/]/g, '-').toLowerCase();
			const dir = join(CLAUDE_DIR, 'projects');
			try {
				for (const entry of await readdir(dir, { withFileTypes: true })) {
					if (entry.isDirectory() && entry.name.toLowerCase() === enc) {
						const workspace = join(dir, entry.name);
						// Delete only the .jsonl session files, not the workspace directory itself.
						for (const file of await readdir(workspace)) {
							if (file.endsWith('.jsonl')) {
								try { await rm(join(workspace, file), { force: true }); } catch { /* ignore */ }
							}
						}
						removed.sessions = true;
					}
				}
			} catch { /* no projects dir */ }
		}
		// Todos for project-specific sessions are left; they're harmless orphans after transcript deletion.
	} else {
		// Reset all: delete .jsonl files from every workspace directory, but keep directory structure.
		const projDir = join(CLAUDE_DIR, 'projects');
		try {
			for (const entry of await readdir(projDir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					for (const file of await readdir(join(projDir, entry.name))) {
						if (file.endsWith('.jsonl')) {
							try { await rm(join(projDir, entry.name, file), { force: true }); } catch { /* ignore */ }
						}
					}
				}
			}
			removed.sessions = true;
		} catch { /* no projects dir */ }
		// Also clear all todo files on "reset all".
		try {
			const todosDir = join(CLAUDE_DIR, 'todos');
			for (const file of await readdir(todosDir)) {
				try { await rm(join(todosDir, file), { force: true }); } catch { /* ignore */ }
			}
			removed.todos = true;
		} catch { /* no todos dir */ }
	}
	return removed;
}

async function resetData(project) {
	const deleted = {};
	const client = new Client({ connectionString: PG_URL });
	await client.connect();
	try {
		const p = project ? [project] : [];
		const w = project ? 'WHERE project_id=$1' : '';
		const del = async (name, sql) => { const r = await client.query(sql, p); deleted[name] = r.rowCount; };
		// FKs first: conflicts reference memories; embeddings/versions are cleaned explicitly.
		await del('conflicts', `DELETE FROM conflict_reports ${w}`);
		await del('versions', project
			? 'DELETE FROM memory_versions WHERE memory_id::text IN (SELECT id::text FROM memories WHERE project_id=$1)'
			: 'DELETE FROM memory_versions');
		await del('embeddings', project
			? 'DELETE FROM embeddings WHERE owner_id::text IN (SELECT id::text FROM memories WHERE project_id=$1)'
			: 'DELETE FROM embeddings');
		await del('decisions', `DELETE FROM decisions ${w}`);
		await del('events', `DELETE FROM events ${w}`);
		await del('relationships', `DELETE FROM graph_relationships ${w}`);
		await del('memories', `DELETE FROM memories ${w}`);
		await del('telemetry', `DELETE FROM ppb_telemetry ${w}`);
		if (!project) {
			await del('outbox', 'DELETE FROM neo4j_outbox');
			await del('projects', 'DELETE FROM projects');
		}
	} finally {
		await client.end();
	}
	// Also clear the agent's own session runtime, so "reset" removes everything the developer
	// sees as memory (the SDK keeps transcripts/todos/file-history under ~/.claude).
	deleted.sdk = await resetSdkRuntime(project);
	const driver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
	const session = driver.session();
	try {
		const r = await session.run(project ? 'MATCH (n {projectId:$p}) DETACH DELETE n' : 'MATCH (n) DETACH DELETE n', project ? { p: project } : {});
		deleted.graphNodes = r.summary.counters.updates().nodesDeleted;
		return deleted;
	} finally {
		await session.close();
		await driver.close();
	}
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname === '/' || url.pathname.startsWith('/index')) {
			const html = await readFile(join(here, 'brain-dashboard.html'), 'utf8');
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(html);
			return;
		}
		if (url.pathname === '/api/reset' && req.method === 'POST') {
			let body = '';
			req.on('data', (c) => (body += c));
			await new Promise((resolve) => req.on('end', resolve));
			let parsed = {};
			try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
			const wantsAll = parsed.all === true;
			const project = typeof parsed.project === 'string' ? parsed.project.trim() : '';
			// Safety: never wipe everything unless the caller explicitly asked for it.
			if (!wantsAll && !project) {
				res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify({ ok: false, error: 'Send {"project":"<id>"} or {"all":true}.' }));
				return;
			}
			const deleted = await resetData(wantsAll ? null : project);
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: true, scope: wantsAll ? 'all' : project, deleted }));
			return;
		}
		if (url.pathname.startsWith('/api/data')) {
			const project = (url.searchParams.get('project') || '').trim() || null;
			const [pg, graph, registry] = await Promise.allSettled([pgData(project), neo4jData(project), readRegistry()]);
			const pgVal = pg.status === 'fulfilled' ? pg.value : { error: String(pg.reason) };
			const registryVal = registry.status === 'fulfilled' ? registry.value : [];
			const projects = mergeProjects(pgVal.dbProjects ?? [], registryVal, pgVal.memoryCounts, pgVal.embeddingCounts);
			const body = JSON.stringify({
				selected: project,
				projects,
				registry: registryVal,
				layers: LAYERS,
				pg: pgVal,
				neo4j: graph.status === 'fulfilled' ? graph.value : { error: String(graph.reason) },
				generatedAt: new Date().toISOString(),
			});
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(body);
			return;
		}
		res.writeHead(404);
		res.end('not found');
	} catch (error) {
		res.writeHead(500, { 'Content-Type': 'text/plain' });
		res.end(String(error));
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`CodeMind Project Brain dashboard: http://127.0.0.1:${PORT}`);
	console.log(`  PostgreSQL: ${PG_URL}`);
	console.log(`  Neo4j:      ${NEO4J_URL}`);
});