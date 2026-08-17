/*---------------------------------------------------------------------------------------------
 *  Orchestration Trace panel — webview renderer.
 *  A passive display: the workbench posts `{type:'trace', payload}` for each pipeline turn
 *  (dev mode only) and `{type:'clear'}`. Cards are keyed by queryId so a buffer replay on
 *  open never duplicates a card already shown live. Ported from agent.js `traceCardHtml`.
 *--------------------------------------------------------------------------------------------*/
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const listEl = document.getElementById('traceList');
	const emptyEl = document.getElementById('emptyState');
	const clearBtn = document.getElementById('clearBtn');

	// queryId -> trace. Insertion order = arrival order; we render newest-first.
	const traces = new Map();
	// Query ids whose card the reader expanded — open state survives full re-renders.
	const expandedTraces = new Set();

	const BUG_ICON = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
	  <circle cx="8" cy="9" r="4" stroke="currentColor" stroke-width="1.5"/>
	  <circle cx="5.5" cy="4.5" r="1.5" stroke="currentColor" stroke-width="1.2"/>
	  <circle cx="10.5" cy="4.5" r="1.5" stroke="currentColor" stroke-width="1.2"/>
	  <line x1="4" y1="9" x2="2" y2="9" stroke="currentColor" stroke-width="1.2"/>
	  <line x1="12" y1="9" x2="14" y2="9" stroke="currentColor" stroke-width="1.2"/>
	</svg>`;

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

	// PORTED from agent.js traceCardHtml — identical markup so the card looks the same.
	function traceCardHtml(trace, queryId) {
		if (!trace) { return ''; }
		const layers = trace.layers || [];
		const totalMs = trace.totalDurationMs || 0;
		let borderColor = 'var(--vscode-testing-iconPassed)';
		if (totalMs >= 1500 || trace.timedOut) { borderColor = 'var(--vscode-errorForeground)'; }
		else if (totalMs >= 500) { borderColor = 'var(--vscode-editorWarning-foreground)'; }
		const dots = layers.map((l) => {
			let color = 'var(--vscode-testing-iconPassed)';
			if (l.status === 'timeout' || l.status === 'error') { color = 'var(--vscode-errorForeground)'; }
			else if (l.durationMs >= 200) { color = 'var(--vscode-editorWarning-foreground)'; }
			else if (l.status === 'skipped') { color = 'var(--vscode-descriptionForeground)'; }
			return `<span class="cm-layer-dot" style="background:${color}" title="${escapeAttr((l.layerName || '') + ': ' + l.status + ' ' + l.durationMs + 'ms')}"></span>`;
		}).join('');
		// Prefer the trace's own token totals; fall back to the headroom layer for older traces.
		let before = typeof trace.originalTokens === 'number' ? trace.originalTokens : NaN;
		let after = typeof trace.finalTokens === 'number' ? trace.finalTokens : NaN;
		if (isNaN(before) || isNaN(after)) {
			const headroom = layers.find(l => /headroom/i.test(l.layerName || ''));
			before = headroom ? parseInt(headroom.input, 10) : NaN;
			after = headroom ? parseInt(headroom.output, 10) : NaN;
		}
		let tokenInfo;
		if (!isNaN(before) && !isNaN(after) && before > 0) {
			const pct = Math.round((1 - after / before) * 100);
			tokenInfo = `${before}→${after} tok${pct > 0 ? ` (−${pct}%)` : ''}`;
		} else if (!isNaN(after) && after > 0) {
			tokenInfo = `${after} tok`;
		} else { tokenInfo = `${layers.length} layers`; }
		const rows = layers.map((layer, idx) => `
			<div class="cm-trace-layer">
				<div class="cm-trace-layer-header">
					<span class="cm-trace-layer-index">${idx + 1}</span>
					<span class="cm-trace-layer-name">${escapeHtml(layer.layerName || '')}</span>
					<span class="cm-trace-layer-status">${layer.status === 'pass' ? '✓' : layer.status === 'timeout' ? '⏱' : layer.status === 'error' ? '✗' : '—'} ${layer.durationMs || 0}ms</span>
				</div>
				<div class="cm-trace-io">
					<div class="cm-trace-io-label">INPUT <span style="opacity:0.5;">~${layer.inputTokenEstimate || 0} tok</span></div>
					<pre class="cm-trace-io-content">${escapeHtml(String(layer.input ?? ''))}</pre>
					<div class="cm-trace-io-label">OUTPUT <span style="opacity:0.5;">~${layer.outputTokenEstimate || 0} tok</span></div>
					<pre class="cm-trace-io-content">${escapeHtml(String(layer.output ?? ''))}</pre>
					${(layer.notes && layer.notes.length) ? `<div class="cm-trace-io-label">NOTES</div><pre class="cm-trace-io-content">${escapeHtml(layer.notes.join(', '))}</pre>` : ''}
				</div>
			</div>`).join('');
		const open = expandedTraces.has(queryId) ? ' open' : '';
		return `
			<details class="cm-trace-card" data-trace="${escapeAttr(queryId || '')}"${open} style="border-left-color:${borderColor};">
				<summary class="cm-trace-summary">
					<span style="font-size:10px;">${BUG_ICON}</span>
					<span>Orchestration · ${totalMs}ms · ${escapeHtml(trace.intent || '')}</span>
					<span style="display:flex;gap:2px;margin:0 8px;">${dots}</span>
					<span style="opacity:0.6;">${tokenInfo}</span>
				</summary>
				<div class="cm-trace-detail">${rows}</div>
			</details>`;
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

	// Open/close state must survive the next full re-render, so mirror each card's
	// toggle into expandedTraces (event delegation — cards are replaced on every render).
	listEl.addEventListener('toggle', (e) => {
		const card = e.target;
		if (!card || !card.classList || !card.classList.contains('cm-trace-card')) { return; }
		const qid = card.getAttribute('data-trace') || '';
		if (card.open) { expandedTraces.add(qid); } else { expandedTraces.delete(qid); }
	}, true);

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
			expandedTraces.clear();
			render();
		}
	});

	// Signal the host that the script is listening; it replays the buffer in response.
	render();
	vscode.postMessage({ type: 'ready' });
})();
