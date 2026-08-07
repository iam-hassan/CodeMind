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
					Select Models... <span class="arrow">▼</span>
				</button>
				<div class="dropdown-content hidden" id="dropdownContent">
					${models.map(m => `
						<label class="model-checkbox-label" title="${m.specialty}">
							<input type="checkbox" value="${m.id}" checked>
							${m.displayName}
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
		els.modelCheckboxes.innerHTML = '<div class="loading-models">Loading free models from OpenRouter...</div>';
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
			els.modelSelectionError.textContent = "Please select exactly 3, 5, or 7 models.";
			els.modelSelectionError.classList.remove('hidden');
		}
	}

	els.promptInput.addEventListener('input', validateSelection);

	// Request models from the backend
	showModelLoading();
	vscode.postMessage({ type: 'fetch_models' });

	els.submitBtn.addEventListener('click', () => {
		const prompt = els.promptInput.value.trim();
		if (!prompt) return;

		els.submitBtn.disabled = true;
		els.submitBtn.textContent = 'Running...';
		els.statusBanner.classList.remove('hidden');
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
		card.querySelector('.card-answer').textContent = resp.answer || 'Thinking...';
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
				els.currentPhase.textContent = `Phase: ${message.payload.phase.toUpperCase()}`;
				els.phaseMessage.textContent = message.payload.message;
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
					appendEvent(`[${message.payload.modelId}] Hallucination Detected: ${message.payload.details}`, true);
					renderCard(message.payload.modelId);
				}
				break;

			case 'round_complete':
				{
					state.faultyModels = message.payload.faultyNodes || [];
					for (const id of state.responses.keys()) {
						renderCard(id);
					}
					appendEvent(`Round ${message.payload.round} Complete. Score: ${(message.payload.consensusScore * 100).toFixed(1)}%`);
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
					els.currentPhase.textContent = 'CONSENSUS REACHED';
					els.phaseMessage.textContent = `Final Score: ${(message.payload.consensusScore * 100).toFixed(1)}%`;
					els.submitBtn.disabled = false;
					els.submitBtn.textContent = 'Start Consensus';
					
					els.finalResult.classList.remove('hidden');
					// Render Answer and Reasoning
					let text = message.payload.finalAnswer || '';
					let reason = message.payload.finalReasoning || '';
					text = text.replace(/\n/g, '<br/>');
					reason = reason.replace(/\n/g, '<br/>');
					
					els.finalAnswer.innerHTML = `
						<div style="margin-bottom: 10px;">
							<h4 style="margin: 0 0 5px 0; color: var(--vscode-terminal-ansiGreen);">Final Answer</h4>
							<div>${text}</div>
						</div>
						<div style="padding-top: 10px; border-top: 1px solid var(--cm-border);">
							<h4 style="margin: 0 0 5px 0; color: var(--vscode-descriptionForeground);">Consensus Reasoning</h4>
							<div style="font-size: 0.9em; opacity: 0.9;">${reason}</div>
						</div>
					`;
					
					appendEvent('Consensus process completed successfully.');
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
				els.submitBtn.disabled = false;
				els.submitBtn.textContent = 'Start Consensus';
				appendEvent(`Error: ${message.payload}`, true);
				break;

			case 'models_loaded':
				renderModelCheckboxes(message.payload || []);
				break;
		}
	});
})();
