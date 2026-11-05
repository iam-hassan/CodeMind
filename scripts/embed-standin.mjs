/*---------------------------------------------------------------------------------------------
 *  CodeMind — local embeddings stand-in for the Project Brain (development only).
 *
 *  The configured providers expose no working `/embeddings` endpoint, so this serves an
 *  OpenAI-compatible `POST /v1/embeddings` with deterministic 2048-dim feature-hashing vectors
 *  (cosine similarity reflects token overlap). It exercises the retrieval/ranking/plumbing, but
 *  it is NOT a semantic embedding model: recall quality is only as good as shared words.
 *
 *  Start:  node scripts/embed-standin.mjs      (listens on 127.0.0.1:20129)
 *--------------------------------------------------------------------------------------------*/

import http from 'http';

const DIM = Number(process.env.PPB_EMBEDDING_DIM ?? 2048);
const PORT = Number(process.env.PPB_EMBED_STANDIN_PORT ?? 20129);

function hash(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function embed(text) {
	const v = new Float64Array(DIM);
	const tokens = String(text).toLowerCase().match(/[a-z0-9_]+/g) ?? [];
	for (const tok of tokens) {
		const h = hash(tok);
		v[h % DIM] += (h >>> 31) & 1 ? -1 : 1;
		const h2 = hash(tok + '#2');
		v[h2 % DIM] += ((h2 >>> 31) & 1 ? -1 : 1) * 0.5;
	}
	let norm = 0;
	for (let i = 0; i < DIM; i++) { norm += v[i] * v[i]; }
	norm = Math.sqrt(norm) || 1;
	return Array.from(v, (x) => x / norm);
}

const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		if (req.method !== 'POST' || !req.url.includes('/embeddings')) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'not found' }));
			return;
		}
		try {
			const payload = JSON.parse(body || '{}');
			const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
			const data = inputs.map((text, index) => ({ object: 'embedding', index, embedding: embed(text) }));
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ object: 'list', data, model: payload.model ?? 'local-hash-2048', usage: { prompt_tokens: 0, total_tokens: 0 } }));
		} catch (error) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: String(error) }));
		}
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`[embed-standin] listening on http://127.0.0.1:${PORT} (dim ${DIM}, dev stand-in — not semantic)`);
});