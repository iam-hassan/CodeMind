/*---------------------------------------------------------------------------------------------
 *  CodeMind — Headroom verification (test_scenarios.docx Group G)
 *
 *  Drives the LOCAL Headroom proxy exactly like the engine's Layer-6 "proxy-in-path" does:
 *    POST http://localhost:7878/v1/messages      (Anthropic shape)
 *    X-Headroom-Upstream: <selected gateway>     (optional; defaults to ANTHROPIC_TARGET_API_URL)
 *
 *  It buries must-keep facts deep inside a large injection block, asks the model to answer from
 *  that context, and checks that the proxy served the request and the facts survived compression
 *  (if they were compressed away, the model would answer wrong).
 *
 *  Prereqs: `headroom proxy --port 7878` running, and an upstream key.
 *    node scripts/headroom-verify.mjs
 *--------------------------------------------------------------------------------------------*/

const PROXY = process.env.HEADROOM_BASE_URL ?? 'http://localhost:7878';
const UPSTREAM = process.env.HEADROOM_UPSTREAM ?? 'https://api.hcnsec.cn';
const MODEL = process.env.HEADROOM_MODEL ?? 'sensenova-6.8-flash-lite';
const KEY = process.env.PPB_EXTRACT_API_KEY ?? process.env.HEADROOM_API_KEY ?? '';

if (!KEY) {
	console.error('Set PPB_EXTRACT_API_KEY (or HEADROOM_API_KEY) to the gateway key.');
	process.exit(1);
}

function filler(n, tag) {
	return Array.from({ length: n }, (_, i) =>
		`${tag} note ${i}: the module handlers were reviewed for clarity, consistency and naming conventions across the codebase.`).join('\n');
}

const FACT_DB = 'PostgreSQL 15 hosted on AWS RDS and connection pooled via PgBouncer';
const FACT_CONSTRAINT = 'No paid services allowed';
const FACT_AUTH = 'Clerk was chosen for authentication because of built-in social OAuth';
const FACT_REJECT = 'Auth.js was evaluated and rejected because it lacked the features we needed';

const injectionBlock = [
	'=== CONSTRAINTS ===',
	`${FACT_CONSTRAINT}. Must support UTF-8 throughout.`,
	'=== TECH STACK ===',
	`Database: ${FACT_DB}. Cache: Redis. Frontend: Next.js 14.`,
	'=== DECISIONS ===',
	`${FACT_AUTH}. ${FACT_REJECT}.`,
	'=== VERBOSE CONTEXT ===',
	filler(120, 'auth'),
	filler(120, 'billing'),
	filler(120, 'ui')
].join('\n');

const question = 'Answer in one short line, using only the project context above: which database and hosting do we use, what auth did we choose, and name one constraint?';

console.log('=== Headroom verification (proxy-in-path, Anthropic route) ===');
console.log('proxy    :', PROXY);
console.log('upstream :', UPSTREAM);
console.log('model    :', MODEL);
console.log('context  :', injectionBlock.length, 'chars (~', Math.ceil(injectionBlock.length / 4), 'tokens est.)');

async function stats() {
	try { const r = await fetch(`${PROXY}/stats`); return r.ok ? r.json() : null; } catch { return null; }
}

const before = await stats();
console.log('\nstats before:', before ? JSON.stringify(before.requests) + ' ' + JSON.stringify(before.tokens) : '(unavailable)');

const body = {
	model: MODEL,
	max_tokens: 150,
	temperature: 0,
	system: injectionBlock,
	messages: [{ role: 'user', content: question }]
};

let response, payload, elapsed;
try {
	const t0 = Date.now();
	response = await fetch(`${PROXY}/v1/messages`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': KEY,
			'authorization': `Bearer ${KEY}`,
			'anthropic-version': '2023-06-01',
			'X-Headroom-Upstream': UPSTREAM
		},
		body: JSON.stringify(body)
	});
	elapsed = Date.now() - t0;
	payload = await response.json();
} catch (error) {
	console.error('request FAILED:', error?.message ?? error);
	process.exit(1);
}

const answer = Array.isArray(payload?.content)
	? payload.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
	: (payload?.choices?.[0]?.message?.content ?? JSON.stringify(payload).slice(0, 500));
console.log(`\nupstream via proxy: HTTP ${response.status} in ${elapsed} ms`);
console.log('answer:', JSON.stringify(answer));

const after = await stats();
console.log('\nstats after :', after ? JSON.stringify(after.requests) + ' ' + JSON.stringify(after.tokens) : '(unavailable)');
if (before && after) {
	console.log('requests delta :', after.requests.total - before.requests.total);
	console.log('tokens saved   :', after.tokens.saved - before.tokens.saved, '(input', after.tokens.input - before.tokens.input, ', savings', after.tokens.savings_percent + '%)');
}

const a = answer.toLowerCase();
const checks = [
	['database (PostgreSQL)', /postgres/],
	['hosting (RDS)', /rds/],
	['auth (Clerk)', /clerk/],
	['constraint', /paid/]
];
console.log('\n--- preservation through the model ---');
let pass = 0;
for (const [label, re] of checks) {
	const ok = re.test(a);
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
	if (ok) pass++;
}
console.log(`\npreservation: ${pass}/${checks.length}`);
console.log(response.ok ? 'RESULT: proxy served the request' : 'RESULT: proxy request failed');
process.exit(response.ok ? 0 : 1);
