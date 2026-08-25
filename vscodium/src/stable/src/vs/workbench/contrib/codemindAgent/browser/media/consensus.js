/*---------------------------------------------------------------------------------------------
 *  LLM Consensus — Vanilla JS Frontend
 *--------------------------------------------------------------------------------------------*/

(function () {
	const vscode = acquireVsCodeApi();

	const state = {
		phase: 'idle',
		responses: new Map(),
		faultyModels: [],
		hallucinations: []
	};

	/**
	 * Model labels can contain a provider name the user typed themselves, so every
	 * interpolation into markup goes through this first.
	 */
	function escapeHtml(value) {
		return String(value === undefined || value === null ? '' : value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	const els = {
		promptInput: document.getElementById('promptInput'),
		submitBtn: document.getElementById('submitBtn'),
		statusBanner: document.getElementById('statusBanner'),
		currentPhase: document.getElementById('currentPhase'),
		phaseMessage: document.getElementById('phaseMessage'),
		mainContent: document.getElementById('mainContent'),
		modelGrid: document.getElementById('modelGrid'),
		eventLog: document.getElementById('eventLog'),
		finalResult: document.getElementById('finalResult'),
		finalAnswer: document.getElementById('finalAnswer'),
		modelCheckboxes: document.getElementById('modelCheckboxes'),
		modelSelectionError: document.getElementById('modelSelectionError')
	};

	let selectedModels = [];
	let loadedModels = [];

	function renderModelCheckboxes(models) {
		loadedModels = models;
		
		const html = `
			<div class="custom-dropdown">
				<button class="dropdown-btn" id="dropdownBtn">
					Select models… <span class="arrow">▼</span>
				</button>
				<div class="dropdown-content hidden" id="dropdownContent">
					${models.map(m => `
						<label class="model-checkbox-label" title="${escapeHtml(m.specialty)}">
							<input type="checkbox" value="${escapeHtml(m.id)}" checked>
							${escapeHtml(m.displayName)}
						</label>
					`).join('')}
				</div>
			</div>
		`;
		
		els.modelCheckboxes.innerHTML = html;
		els.modelCheckboxes.classList.remove('model-checkboxes'); // Remove old grid style

		const dropdownBtn = document.getElementById('dropdownBtn');
		const dropdownContent = document.getElementById('dropdownContent');
		
		dropdownBtn.addEventListener('click', (e) => {
			e.preventDefault();
			dropdownContent.classList.toggle('hidden');
			e.stopPropagation();
		});
		
		document.addEventListener('click', (e) => {
			if (!els.modelCheckboxes.contains(e.target) && dropdownContent) {
				dropdownContent.classList.add('hidden');
			}
		});

		const checkboxes = els.modelCheckboxes.querySelectorAll('input[type="checkbox"]');
		checkboxes.forEach(cb => cb.addEventListener('change', validateSelection));
		
		// Enforce defaults to 5 if enough models exist
		if (checkboxes.length > 5) {
			let checkedCount = 0;
			checkboxes.forEach(cb => {
				if (checkedCount < 5) {
					cb.checked = true;
					checkedCount++;
				} else {
					cb.checked = false;
				}
			});
		}
		
		validateSelection();
	}

	function showModelLoading() {
		els.modelCheckboxes.innerHTML = '<div class="loading-models">Loading available models…</div>';
	}

	function validateSelection() {
		const checkboxes = els.modelCheckboxes.querySelectorAll('input[type="checkbox"]');
		selectedModels = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);
		const len = selectedModels.length;
		const isValid = (len === 3 || len === 5 || len === 7);

		if (len >= 7) {
			checkboxes.forEach(cb => {
				if (!cb.checked) cb.disabled = true;
			});
		} else {
			checkboxes.forEach(cb => cb.disabled = false);
		}

		const dropdownBtn = document.getElementById('dropdownBtn');
		if (dropdownBtn) {
			dropdownBtn.innerHTML = `${len} model${len !== 1 ? 's' : ''} selected <span class="arrow">▼</span>`;
		}

		if (isValid) {
			els.submitBtn.disabled = !els.promptInput.value.trim();
			els.modelSelectionError.classList.add('hidden');
		} else {
			els.submitBtn.disabled = true;
			els.modelSelectionError.textContent = "Please select 3, 5, or 7 models.";
			els.modelSelectionError.classList.remove('hidden');
		}
	}

	// The button holds a .btn-label span; set text through it so the markup survives.
	function setButtonLabel(text) {
		const label = els.submitBtn.querySelector('.btn-label');
		if (label) { label.textContent = text; } else { els.submitBtn.textContent = text; }
	}

	// Reflect a run's phase on the status banner (dot colour + heading + message).
	function setStatus(heading, message, tone) {
		els.currentPhase.textContent = heading;
		els.phaseMessage.textContent = message;
		els.statusBanner.classList.remove('is-done', 'is-error');
		if (tone === 'done') { els.statusBanner.classList.add('is-done'); }
		else if (tone === 'error') { els.statusBanner.classList.add('is-error'); }
	}

	els.promptInput.addEventListener('input', validateSelection);

	// Request models from the backend
	showModelLoading();
	vscode.postMessage({ type: 'fetch_models' });

	els.submitBtn.addEventListener('click', () => {
		const prompt = els.promptInput.value.trim();
		if (!prompt) return;

		els.submitBtn.disabled = true;
		setButtonLabel('Deliberating…');
		els.statusBanner.classList.remove('hidden');
		setStatus('Starting', 'Gathering independent answers from each model…', 'active');
		els.mainContent.classList.remove('hidden');
		els.finalResult.classList.add('hidden');
		els.modelGrid.innerHTML = '';
		els.eventLog.innerHTML = '';
		state.responses.clear();
		state.faultyModels = [];
		state.hallucinations = [];

		// Pre-create empty loading cards for all selected models so they appear instantly
		selectedModels.forEach(modelId => {
			const modelInfo = loadedModels.find(m => m.id === modelId);
			const displayName = modelInfo ? modelInfo.displayName : modelId;
			state.responses.set(modelId, { displayName: displayName, answer: '', reasoning: '', confidence: 0 });
			renderCard(modelId);
		});

		vscode.postMessage({
			type: 'start_consensus',
			payload: { prompt, selectedModels }
		});
	});

	function appendEvent(message, isError = false, isHtml = false, cssClass = '') {
		const el = document.createElement('div');
		el.className = 'event-item ' + (isError ? 'error ' : '') + cssClass;
		const time = new Date().toLocaleTimeString();
		
		const timeEl = `<span class="event-time">${time}</span>`;
		if (isHtml) {
			el.innerHTML = timeEl + message;
		} else {
			el.innerHTML = timeEl + message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}
		
		els.eventLog.insertBefore(el, els.eventLog.firstChild);
	}

	function renderCard(modelId) {
		let card = document.getElementById(`card-${modelId}`);
		if (!card) {
			card = document.createElement('div');
			card.id = `card-${modelId}`;
			card.className = 'model-card';
			card.innerHTML = `
				<div class="card-header">
					<h4 class="card-title"></h4>
					<span class="card-confidence"></span>
				</div>
				<div class="card-body">
					<div class="card-answer"></div>
					<div class="card-reasoning"></div>
				</div>
			`;
			els.modelGrid.appendChild(card);
		}
		
		const resp = state.responses.get(modelId);
		card.querySelector('.card-title').textContent = resp.displayName || modelId;
		card.querySelector('.card-confidence').textContent = resp.confidence ? `${(resp.confidence * 100).toFixed(0)}%` : '';
		card.querySelector('.card-answer').textContent = resp.answer || 'Thinking…';
		card.querySelector('.card-reasoning').textContent = resp.reasoning || '';
		
		if (state.faultyModels.includes(modelId) || state.hallucinations.some(h => h.modelId === modelId)) {
			card.classList.add('faulty');
		} else {
			card.classList.remove('faulty');
		}
	}

	window.addEventListener('message', event => {
		const message = event.data;
		switch (message.type) {
			case 'pbft_phase_change':
				setStatus(prettyPhase(message.payload.phase), message.payload.message, 'active');
				appendEvent(message.payload.message);
				break;

			case 'model_response':
			case 'model_revision':
				{
					const id = message.payload.modelId;
					const current = state.responses.get(id) || {};
					state.responses.set(id, { ...current, ...message.payload });
					renderCard(id);
				}
				break;

			case 'hallucination_detected':
				{
					state.hallucinations.push(message.payload);
					appendEvent(`[${message.payload.modelId}] Flagged for review: ${message.payload.details}`, true);
					renderCard(message.payload.modelId);
				}
				break;

			case 'round_complete':
				{
					state.faultyModels = message.payload.faultyNodes || [];
					for (const id of state.responses.keys()) {
						renderCard(id);
					}
					appendEvent(`Round ${message.payload.round} complete. Agreement ${(message.payload.consensusScore * 100).toFixed(0)}%.`);
				}
				break;

			case 'critique_result':
				{
					// Highlight the sender
					const sourceId = message.payload.sourceModelId;
					const senderCard = document.getElementById(`card-${sourceId}`);
					
					message.payload.critiques.forEach(critique => {
						const targetName = critique.targetModel;
						let targetId = targetName;
						
						// Try to resolve displayName to modelId
						for (const [id, resp] of state.responses.entries()) {
							if (resp.displayName === targetName || id === targetName) {
								targetId = id;
								break;
							}
						}
						
						// Create chat bubble
						const senderName = state.responses.get(sourceId)?.displayName || sourceId;
						const content = `<strong>${senderName}</strong> <span style="opacity: 0.7; font-size: 11px;">to ${targetName}</span><br/>${critique.critique || critique.feedback || ''}`;
						
						appendEvent(content, false, true, 'critique-bubble');
					});
				}
				break;

			case 'consensus_reached':
				{
					setStatus('Consensus reached', `The models agreed at ${(message.payload.consensusScore * 100).toFixed(0)}% confidence.`, 'done');
					els.submitBtn.disabled = false;
					setButtonLabel('Start deliberation');

					els.finalResult.classList.remove('hidden');
					// Render Answer and Reasoning
					let text = message.payload.finalAnswer || '';
					let reason = message.payload.finalReasoning || '';
					text = text.replace(/\n/g, '<br/>');
					reason = reason.replace(/\n/g, '<br/>');

					els.finalAnswer.innerHTML = `
						<div class="fa-section">
							<h4 class="fa-label">Answer</h4>
							<div class="fa-body">${text}</div>
						</div>
						<div class="fa-section fa-reasoning">
							<h4 class="fa-label">How they agreed</h4>
							<div class="fa-body">${reason}</div>
						</div>
					`;

					appendEvent('Deliberation complete. An agreed answer is ready.');
				}
				break;

			case 'consensus_blocked':
			case 'consensus_blocked':
				{
					const why = (message.payload && message.payload.message)
						? message.payload.message
						: 'That question is outside what this project covers, so the models did not run.';
					setStatus('Not started', why, 'error');
					els.submitBtn.disabled = false;
					setButtonLabel('Start deliberation');
					// No models ran, so hide the empty "Thinking…" cards and show a clean notice.
					els.mainContent.classList.add('hidden');
					els.finalResult.classList.remove('hidden');
					els.finalAnswer.innerHTML = `
						<div class="fa-notice">
							<div class="fa-notice-icon" aria-hidden="true">
								<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>
							</div>
							<div class="fa-notice-text">
								<h4>Kept to this project</h4>
								<p></p>
							</div>
						</div>
					`;
					const noticeText = els.finalAnswer.querySelector('.fa-notice-text p');
					if (noticeText) { noticeText.textContent = why; }
				}
				break;

			case 'consensus_blocked':
				els.currentPhase.textContent = 'BLOCKED';
				els.phaseMessage.textContent = message.payload.message || 'This question is not related to the open project.';
				els.submitBtn.disabled = false;
				els.submitBtn.textContent = 'Start Consensus';
				appendEvent('Blocked: ' + (message.payload.message || 'not related to the open project'), true);
				break;

			case 'error':
				setStatus('Something went wrong', String(message.payload || 'Unexpected error'), 'error');
				els.submitBtn.disabled = false;
				setButtonLabel('Start deliberation');
				appendEvent(`Error: ${message.payload}`, true);
				break;

			case 'models_loaded':
				renderModelCheckboxes(message.payload || []);
				break;
		}
	});

	// Turn an internal phase token into readable text; unknown tokens are title-cased.
	function prettyPhase(phase) {
		const map = {
			'planning': 'Planning',
			'relevance_check': 'Checking relevance',
			'pre_prepare': 'Collecting answers',
			'pre-prepare': 'Collecting answers',
			'prepare': 'Cross-checking',
			'commit': 'Converging',
			'reply': 'Finalizing',
			'forced_consensus': 'Reconciling',
			'critique': 'Critiquing'
		};
		const key = String(phase || '').toLowerCase();
		if (map[key]) { return map[key]; }
		return key ? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ') : 'Working';
	}
})();
