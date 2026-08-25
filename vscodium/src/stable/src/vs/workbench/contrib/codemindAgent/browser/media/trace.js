/*---------------------------------------------------------------------------------------------
 *  Orchestration Trace panel — webview renderer (SIMPLIFIED for Headroom).
 *  A passive display: the workbench posts `{type:'trace', payload}` for each pipeline turn
 *  (dev mode only) and `{type:'clear'}`. The panel shows ONLY the two things that matter for
 *  Headroom: what went IN this turn, and whether the local Headroom proxy actually
 *  OPTIMIZED (compressed) the request. Cards are keyed by queryId so a buffer replay on open
 *  never duplicates a card already shown live.
 *--------------------------------------------------------------------------------------------*/
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const listEl = document.getElementById('traceList');
	const emptyEl = document.getElementById('emptyState');
	const clearBtn = document.getElementById('clearBtn');

	// queryId -> trace. Insertion order = arrival order; we render newest-first.
	const traces = new Map();

	function escapeHtml(text) {
		if (text == null) { return ''; }
		return String(text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}
	const escapeAttr = escapeHtml;

	// Map the Headroom proxy-in-path outcome to a card state:
	//   ok   (green)  = proxy routed the turn AND saved tokens
	//   warn (yellow) = proxy routed the turn but saved nothing this turn
	//   down (red)    = proxy not running → request went to the gateway uncompressed
	//   unknown(grey) = no Headroom data on this trace
	function outcomeState(hp) {
		if (!hp) { return { cls: 'unknown', label: 'No Headroom data' }; }
		if (!hp.proxyActive) { return { cls: 'down', label: 'Proxy not running' }; }
		if (hp.optimized) { return { cls: 'ok', label: 'Optimized' }; }
		return { cls: 'warn', label: 'Active · no savings' };
	}

	// The whole card: INPUT (what the developer asked) + OPTIMIZATION (whether the local
	// Headroom proxy compressed the request, with the per-turn token delta when known).
	function traceCardHtml(trace, queryId) {
		if (!trace) { return ''; }
		const hp = trace.headroomProxy || null;
		const st = outcomeState(hp);
		const input = (hp && hp.input) ? hp.input : '(input unavailable)';

		let tokensHtml = '';
		if (hp && hp.proxyActive && typeof hp.beforeTokens === 'number' && typeof hp.afterTokens === 'number') {
			const saved = hp.savedTokens || 0;
			const pct = (hp.beforeTokens > 0) ? Math.round((saved / hp.beforeTokens) * 100) : 0;
			tokensHtml = `<div class="cm-hr-tokens">${hp.beforeTokens} → ${hp.afterTokens} tok`
				+ `<span class="cm-hr-saved"> · saved ${saved}${pct > 0 ? ' (' + pct + '%)' : ''}</span></div>`;
		}
		const reason = (hp && hp.reason) ? hp.reason : '';
		const upstream = (hp && hp.upstream) ? `<div class="cm-hr-meta">upstream: ${escapeHtml(hp.upstream)}</div>` : '';

		return `
			<div class="cm-hr-card cm-hr-${st.cls}" data-trace="${escapeAttr(queryId || '')}">
				<div class="cm-hr-head">
					<span class="cm-hr-dot"></span>
					<span class="cm-hr-title">Headroom · ${escapeHtml(st.label)}</span>
					<span class="cm-hr-time">${trace.totalDurationMs || 0}ms</span>
				</div>
				<div class="cm-hr-section">
					<div class="cm-hr-label">INPUT</div>
					<pre class="cm-hr-pre">${escapeHtml(input)}</pre>
				</div>
				<div class="cm-hr-section">
					<div class="cm-hr-label">OPTIMIZATION</div>
					${tokensHtml}
					<div class="cm-hr-reason">${escapeHtml(reason)}</div>
					${upstream}
				</div>
			</div>`;
	}

	function render() {
		const keys = [...traces.keys()];
		if (keys.length === 0) {
			listEl.innerHTML = '';
			emptyEl.classList.remove('hidden');
			return;
		}
		emptyEl.classList.add('hidden');
		// Newest first: reverse the insertion order.
		listEl.innerHTML = keys.reverse()
			.map((qid) => traceCardHtml(traces.get(qid), qid))
			.join('');
	}

	clearBtn.addEventListener('click', () => {
		vscode.postMessage({ type: 'clear' });
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message) { return; }
		if (message.type === 'trace') {
			const trace = message.payload;
			if (!trace) { return; }
			// Key by queryId so a buffer replay updates the existing card in place rather
			// than appending a duplicate of one already shown live.
			const qid = trace.queryId != null ? String(trace.queryId) : String(traces.size);
			traces.set(qid, trace);
			render();
		} else if (message.type === 'clear') {
			traces.clear();
			render();
		}
	});

	// Signal the host that the script is listening; it replays the buffer in response.
	render();
	vscode.postMessage({ type: 'ready' });
})();
