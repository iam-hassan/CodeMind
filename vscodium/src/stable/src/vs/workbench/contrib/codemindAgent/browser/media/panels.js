// CodeMind Agent — Panel module (Step 7)
// Renders the Settings, MCP, Memory, Skills, and Tasks panels as webview
// overlays, plus the commit review sheet. Panels are appended to the body and
// dismissed via a close button.
//
// The workbench owns all state: settings live in `codemind.*` configuration and
// MCP servers in `codemind.mcpServers`, both pushed here as `settingsData` /
// `mcpData` messages. This module never persists anything itself — it renders
// what it is given and posts changes back so configuration stays the single
// source of truth (localStorage would silently diverge from the settings UI).

(function () {

	/** Latest settings pushed by the workbench. */
	let settings = {};
	/** Latest MCP servers pushed by the workbench, with live status attached. */
	let mcpServers = [];
	/** Which panel is on screen, or undefined when the host is hidden. */
	let activePanel;
	/** What the endpoint last said it serves, so every model picker can offer it. */
	let endpointModels = [];

	/** Models the engine accepts. Aliases resolve to the current generation. */
	const MODEL_OPTIONS = [
		{ value: 'claude-opus-5', label: 'Claude Opus 5' },
		{ value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
		{ value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
		{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
		{ value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
		{ value: 'claude-fable-5', label: 'Claude Fable 5' },
		{ value: 'opus', label: 'opus (latest Opus)' },
		{ value: 'sonnet', label: 'sonnet (latest Sonnet)' },
		{ value: 'haiku', label: 'haiku (latest Haiku)' },
		{ value: 'best', label: 'best (most capable available)' },
		{ value: 'opusplan', label: 'opusplan (Opus to plan, Sonnet to work)' },
		{ value: 'opus[1m]', label: 'opus[1m] (Opus, 1M-token context)' },
		{ value: 'sonnet[1m]', label: 'sonnet[1m] (Sonnet, 1M-token context)' },
	];

	/**
	 * Advisor candidates: the Opus- and Sonnet-class entries only. Haiku is never a
	 * useful advisor, and the plan-mode and 1M aliases mean nothing for a single
	 * consulting call.
	 */
	const ADVISOR_OPTIONS = MODEL_OPTIONS.filter(m => /^(claude-)?(opus|sonnet)/.test(m.value) && !m.value.endsWith('[1m]') && m.value !== 'opusplan');

	/**
	 * Every model a picker may offer: the built-in list, whatever the endpoint last
	 * reported, and the configured model itself. A custom endpoint's own model name
	 * must never be missing from the list that can put it back.
	 */
	function modelOptions() {
		const seen = new Set();
		const out = [];
		for (const option of MODEL_OPTIONS.concat(endpointModels)) {
			if (!option || !option.value || seen.has(option.value)) { continue; }
			seen.add(option.value);
			out.push(option);
		}
		if (settings.model && !seen.has(settings.model)) { out.push({ value: settings.model, label: settings.model }); }
		return out;
	}

	const OUTPUT_STYLE_OPTIONS = [
		{ value: 'default', label: 'Default — concise engineering answers' },
		{ value: 'explanatory', label: 'Explanatory — adds the reasoning' },
		{ value: 'concise', label: 'Concise — shortest correct answer' },
		{ value: 'learning', label: 'Learning — teaches as it works' },
	];

	/** Reasoning depth. Models without the chosen level fall back to their closest. */
	const EFFORT_OPTIONS = [
		{ value: 'auto', label: 'Auto — let the model decide' },
		{ value: 'low', label: 'Low — fastest, minimal thinking' },
		{ value: 'medium', label: 'Medium — balanced' },
		{ value: 'high', label: 'High — deep reasoning' },
		{ value: 'xhigh', label: 'Extra high — newer models only' },
		{ value: 'max', label: 'Max — think as long as it can' },
	];

	/** Settings files the engine may load. `project` is what turns CLAUDE.md on. */
	const SETTING_SOURCES = [
		{ value: 'user', label: 'User (~/.claude/settings.json)' },
		{ value: 'project', label: 'Project (.claude/settings.json, CLAUDE.md, hooks, skills)' },
		{ value: 'local', label: 'Local (.claude/settings.local.json)' },
	];

	const PANEL_CONTENT = {
		/**
		 * Section 8: this panel owns model *configuration* — the endpoint, the key, the
		 * lookup that says what that endpoint serves, the fallback, the advisor — but not
		 * model *selection*. Which model answers the next turn is chosen in the input bar,
		 * one click from the composer, and nowhere else; the Model group here says so.
		 */
		settings: () => `
			<h2>Settings</h2>
			<div class="setting-group">
				<label for="settingsBaseUrl">Endpoint URL</label>
				<input type="text" id="settingsBaseUrl" placeholder="https://api.anthropic.com" autocomplete="off" spellcheck="false">
				<div class="setting-hint">Any Anthropic-compatible endpoint — a gateway or a self-hosted proxy. Leave empty for the official API. Do not include <code>/v1</code>.</div>
			</div>
			<div class="setting-group">
				<label for="settingsApiKey">API Key</label>
				<div class="api-key-row">
					<input type="password" id="settingsApiKey" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">
					<button class="btn btn-secondary" id="settingsApiKeyTest">Validate</button>
					<button class="btn btn-primary" id="settingsApiKeySave">Save</button>
				</div>
				<div class="setting-hint" id="settingsApiKeyHint">Stored securely via VS Code Secret Storage. Validate tests it against the endpoint above.</div>
			</div>
			<div class="setting-group">
				<label>Model</label>
				<div class="setting-note">Select the active model from the input bar.</div>
				<button class="btn btn-secondary" id="settingsFetchModels">Fetch models</button>
				<div class="setting-hint" id="settingsModelHint">Optional — asks the endpoint what it serves and adds whatever it lists to that picker.</div>
			</div>
			<div class="setting-group">
				<label for="settingsFallbackModel">Fallback Model</label>
				<select id="settingsFallbackModel">
					<option value="">None</option>
					${modelOptions().map(m => `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label)}</option>`).join('')}
				</select>
				<div class="setting-hint">Used when the active model is overloaded.</div>
			</div>
			<div class="setting-group">
				<label>Permission Mode</label>
				<div class="radio-group">
					<label><input type="radio" name="permMode" value="default"> Default (ask)</label>
					<label><input type="radio" name="permMode" value="acceptEdits"> Accept edits</label>
					<label><input type="radio" name="permMode" value="bypassPermissions"> Bypass permissions</label>
					<label><input type="radio" name="permMode" value="plan"> Plan mode</label>
				</div>
			</div>
			<div class="setting-group">
				<label for="settingsOutputStyle">Output Style</label>
				<select id="settingsOutputStyle">
					${OUTPUT_STYLE_OPTIONS.map(s => `<option value="${escapeHtml(s.value)}">${escapeHtml(s.label)}</option>`).join('')}
				</select>
			</div>
			<div class="setting-group">
				<label for="settingsEffort">Effort</label>
				<select id="settingsEffort">
					${EFFORT_OPTIONS.map(e => `<option value="${escapeHtml(e.value)}">${escapeHtml(e.label)}</option>`).join('')}
				</select>
				<div class="setting-hint">How much reasoning each turn gets.</div>
			</div>
			<div class="setting-group">
				<label>Speed</label>
				<div class="toggle-rows">
					<label class="toggle-row"><input type="checkbox" id="settingsFastMode"> <span>Fast mode — quicker output from the same model</span></label>
				</div>
				<div class="setting-hint">Ignored by models that do not offer it.</div>
			</div>
			<div class="setting-group">
				<label>Delegation</label>
				<div class="toggle-rows">
					<label class="toggle-row"><input type="checkbox" id="settingsCoordinatorMode"> <span>Coordinator mode — orchestrate workers instead of editing directly</span></label>
				</div>
				<div class="setting-hint">The agent spawns subagents, keeps them going, and synthesizes what they report. Same as /coordinator.</div>
			</div>
			<div class="setting-group">
				<label for="settingsAdvisorModel">Advisor Model</label>
				<select id="settingsAdvisorModel">
					<option value="">None</option>
					${ADVISOR_OPTIONS.map(m => `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label)}</option>`).join('')}
				</select>
				<div class="setting-hint">A second model the agent may consult on hard turns.</div>
			</div>
			<div class="setting-group">
				<label for="settingsMaxTurns">Max Turns</label>
				<input type="number" id="settingsMaxTurns" min="1" max="500" value="40">
				<div class="setting-hint">Tool round trips allowed in a single request.</div>
			</div>
			<div class="setting-group">
				<label for="settingsMaxThinkingTokens">Max Thinking Tokens</label>
				<input type="number" id="settingsMaxThinkingTokens" min="0" max="100000" step="1000" value="0">
				<div class="setting-hint">0 = model default. Overrides Effort when set.</div>
			</div>
			<div class="setting-group">
				<label>Sandbox</label>
				<div class="toggle-rows">
					<label class="toggle-row"><input type="checkbox" id="settingsSandboxEnabled"> <span>Run commands with restricted filesystem and network access</span></label>
					<label class="toggle-row"><input type="checkbox" id="settingsSandboxAutoAllow"> <span>Skip the prompt for commands that run sandboxed</span></label>
					<label class="toggle-row"><input type="checkbox" id="settingsSandboxFallback"> <span>Allow commands that cannot be sandboxed to run outside it</span></label>
				</div>
				<label for="settingsSandboxExcluded">Always outside the sandbox (one per line)</label>
				<textarea id="settingsSandboxExcluded" rows="2" placeholder="docker&#10;npm run dev"></textarea>
			</div>
			<div class="setting-group">
				<label>Settings Files</label>
				<div class="toggle-rows">
					${SETTING_SOURCES.map(s => `<label class="toggle-row"><input type="checkbox" class="settings-source" value="${escapeHtml(s.value)}"> <span>${escapeHtml(s.label)}</span></label>`).join('')}
				</div>
				<div class="setting-hint">Turning all three off runs the agent in isolation — no CLAUDE.md, hooks or skills.</div>
			</div>
			<div class="setting-group">
				<label for="settingsSystemPrompt">Custom System Prompt</label>
				<textarea id="settingsSystemPrompt" rows="4" placeholder="Optional. Appended to the engine's default system prompt."></textarea>
			</div>
			<div class="setting-group">
				<label>Panel</label>
				<div class="toggle-rows">
					<label class="toggle-row"><input type="checkbox" id="settingsVimMode"> <span>Vim mode in the chat input</span></label>
					<label class="toggle-row"><input type="checkbox" id="settingsVoiceMode"> <span>Show the voice input button</span></label>
					<label class="toggle-row"><input type="checkbox" id="settingsShowOnStartup"> <span>Open this panel on every launch</span></label>
					<label class="toggle-row"><input type="checkbox" id="settingsAutoCompact"> <span>Compact the conversation automatically when the context window fills</span></label>
				</div>
			</div>
			<div class="setting-group">
				<label>MCP Servers</label>
				<button class="btn btn-secondary" id="settingsOpenMcp">Open MCP panel →</button>
			</div>
		`,

		mcp: () => `
			<h2>MCP Servers</h2>
			<div class="mcp-toolbar">
				<button class="btn btn-primary" id="mcpAddBtn">+ Add Server</button>
				<button class="btn btn-secondary" id="mcpReconnectBtn">↻ Reconnect all</button>
			</div>
			<div class="mcp-list" id="mcpList">
				<div class="mcp-empty">No MCP servers configured.</div>
			</div>
			<div class="mcp-add-form hidden" id="mcpAddForm">
				<div class="setting-group">
					<label for="mcpAddName">Name</label>
					<input type="text" id="mcpAddName" placeholder="e.g. github">
				</div>
				<div class="setting-group">
					<label for="mcpAddType">Type</label>
					<select id="mcpAddType">
						<option value="stdio">stdio</option>
						<option value="http">http</option>
						<option value="sse">sse</option>
					</select>
				</div>
				<div class="setting-group mcp-stdio-only">
					<label for="mcpAddCommand">Command</label>
					<input type="text" id="mcpAddCommand" placeholder="e.g. node">
				</div>
				<div class="setting-group mcp-stdio-only">
					<label for="mcpAddArgs">Args (one per line)</label>
					<textarea id="mcpAddArgs" rows="3" placeholder="path/to/server.js"></textarea>
				</div>
				<div class="setting-group mcp-stdio-only">
					<label for="mcpAddEnv">Env (KEY=value, one per line)</label>
					<textarea id="mcpAddEnv" rows="3" placeholder="GITHUB_TOKEN=…"></textarea>
				</div>
				<div class="setting-group mcp-http-only hidden">
					<label for="mcpAddUrl">URL</label>
					<input type="text" id="mcpAddUrl" placeholder="https://example.com/mcp">
				</div>
				<div class="modal-actions">
					<button class="btn btn-secondary" id="mcpAddCancel">Cancel</button>
					<button class="btn btn-primary" id="mcpAddSave">Save</button>
				</div>
			</div>
		`,

		memory: () => `
			<h2>Memory</h2>
			<div class="memory-toolbar">
				<button class="btn btn-primary" data-create="memory">+ New memory file</button>
				<button class="btn btn-secondary" data-refresh="memory">↻ Refresh</button>
			</div>
			<div class="panel-rows" id="memoryList">
				<div class="panel-empty">Loading…</div>
			</div>
			<div class="setting-hint" style="margin-top:14px;">Memory files are injected into the agent's context when relevant. Click a row to open it.</div>
		`,

		skills: () => `
			<h2>Skills</h2>
			<div class="memory-toolbar">
				<button class="btn btn-primary" data-create="skills">+ New skill</button>
				<button class="btn btn-secondary" data-refresh="skills">↻ Refresh</button>
			</div>
			<div class="panel-rows" id="skillsList">
				<div class="panel-empty">Loading…</div>
			</div>
			<div class="setting-hint" style="margin-top:14px;">Skills come from <code>.claude/skills/&lt;name&gt;/SKILL.md</code> at the user and project level. Untick one to keep the agent away from it.</div>
		`,

		tasks: () => `
			<h2>Tasks</h2>
			<div class="tasks-toolbar">
				<button class="btn btn-secondary" data-refresh="tasks">↻ Refresh</button>
			</div>
			<div class="panel-rows" id="tasksList">
				<div class="panel-empty">Loading…</div>
			</div>
			<div class="setting-hint" style="margin-top:14px;">The agent's todo list for the current session. Click a status to cycle it.</div>
		`,
	};

	/** Container ids keyed by the panel that owns them. */
	const DATA_PANEL_LISTS = {
		memory: 'memoryList',
		skills: 'skillsList',
		tasks: 'tasksList',
	};

	const PANEL_TITLES = {
		settings: 'Settings',
		mcp: 'MCP Servers',
		memory: 'Memory',
		skills: 'Skills',
		tasks: 'Tasks',
	};

	/** Statuses `/tasks` cycles through when a row's badge is clicked. */
	const TASK_STATUS_CYCLE = ['pending', 'in_progress', 'completed'];

	function ensurePanelHost() {
		let host = document.getElementById('codemind-panel-host');
		if (host) { return host; }
		host = document.createElement('div');
		host.id = 'codemind-panel-host';
		host.className = 'panel-host hidden';
		host.innerHTML = `
			<div class="panel-overlay"></div>
			<div class="panel-window" role="dialog" aria-modal="true">
				<div class="panel-header">
					<h2 id="panelTitle"></h2>
					<button class="icon-btn panel-close" id="panelClose" aria-label="Close panel">
						<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>
				<div class="panel-body" id="panelBody"></div>
			</div>
		`;
		document.body.appendChild(host);
		const overlay = host.querySelector('.panel-overlay');
		const close = host.querySelector('#panelClose');
		overlay.addEventListener('click', closePanel);
		close.addEventListener('click', closePanel);
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && !host.classList.contains('hidden')) { closePanel(); }
		});
		return host;
	}

	function closePanel() {
		const host = document.getElementById('codemind-panel-host');
		if (host) { host.classList.add('hidden'); }
		activePanel = undefined;
	}

	function openPanel(panelId) {
		const builder = PANEL_CONTENT[panelId];
		if (!builder) { return; }
		const host = ensurePanelHost();
		document.getElementById('panelTitle').textContent = PANEL_TITLES[panelId] || panelId;
		const body = document.getElementById('panelBody');
		body.innerHTML = builder();
		host.classList.remove('hidden');
		activePanel = panelId;
		// Wire per-panel handlers, then ask the workbench for current state.
		wireSettings(panelId, body);
		wireMcp(panelId, body);
		wireDataPanel(panelId, body);
	}

	/**
	 * Memory / skills / tasks are populated by the workbench. Ask for the data on
	 * open and re-ask when Refresh is clicked; `renderPanelData` fills the rows
	 * when the reply arrives.
	 */
	function wireDataPanel(panelId, body) {
		if (!DATA_PANEL_LISTS[panelId]) { return; }
		const refresh = body.querySelector(`[data-refresh="${panelId}"]`);
		const create = body.querySelector(`[data-create="${panelId}"]`);
		const request = () => vscode.postMessage({ type: 'requestPanelData', payload: { panelId } });
		if (refresh) { refresh.addEventListener('click', request); }
		if (create) { create.addEventListener('click', () => promptCreate(panelId)); }
		request();
	}

	/**
	 * Ask for a name and a scope, then have the workbench scaffold the file. A
	 * prompt-style sheet is used rather than window.prompt, which webviews block.
	 */
	function promptCreate(panelId) {
		const isSkill = panelId === 'skills';
		showSheet({
			title: isSkill ? 'New skill' : 'New memory file',
			className: 'create-sheet',
			body: `
				<div class="form-group">
					<label for="createName">Name</label>
					<input type="text" id="createName" placeholder="${isSkill ? 'e.g. deploy-checklist' : 'e.g. build-commands'}" spellcheck="false">
				</div>
				<div class="form-group">
					<label>Scope</label>
					<div class="radio-group">
						<label><input type="radio" name="createScope" value="project" checked> This project</label>
						<label><input type="radio" name="createScope" value="user"> My profile</label>
					</div>
				</div>
			`,
			confirmLabel: 'Create',
			onConfirm: (sheet) => {
				const name = sheet.querySelector('#createName').value.trim();
				if (!name) { return false; }
				const scope = sheet.querySelector('input[name="createScope"]:checked')?.value || 'project';
				vscode.postMessage({
					type: isSkill ? 'createSkill' : 'createMemoryFile',
					payload: { scope, name },
				});
				return true;
			},
			onOpen: (sheet) => sheet.querySelector('#createName').focus(),
		});
	}

	/** Fill a data panel's rows. Called from agent.js when `panelData` arrives. */
	function renderPanelData(panelId, items) {
		const listId = DATA_PANEL_LISTS[panelId];
		if (!listId) { return; }
		const list = document.getElementById(listId);
		if (!list) { return; }
		if (!items || !items.length) {
			list.innerHTML = `<div class="panel-empty">${panelId === 'tasks' ? 'No tasks yet — the agent adds them as it works.' : 'Nothing found.'}</div>`;
			return;
		}
		list.innerHTML = items.map((item, i) => `
			<div class="panel-row${item.path ? ' panel-row-openable' : ''}" data-idx="${i}">
				${typeof item.enabled === 'boolean'
				? `<input type="checkbox" class="panel-row-toggle" data-idx="${i}" ${item.enabled ? 'checked' : ''} title="Let the agent use this" aria-label="Enable ${escapeHtml(item.label)}">`
				: ''}
				<div class="panel-row-main">
					<div class="panel-row-label">
						${escapeHtml(item.label)}
						${item.loaded ? '<span class="panel-row-badge" title="Loaded into every request">auto</span>' : ''}
					</div>
					${item.detail ? `<div class="panel-row-detail">${escapeHtml(item.detail)}</div>` : ''}
					${item.tools && item.tools.length ? `<div class="panel-row-tools">${item.tools.map(t => `<span class="tool-chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
					${item.size !== undefined || item.mtime !== undefined ? `<div class="panel-row-meta">${formatMeta(item)}</div>` : ''}
				</div>
				${item.status ? `<button class="panel-row-status status-${escapeHtml(item.status)}" data-cycle="${i}" title="Cycle status">${escapeHtml(item.status.replace('_', ' '))}</button>` : ''}
				${item.deletable ? `<button class="icon-btn panel-row-delete" data-del="${i}" title="Delete" aria-label="Delete ${escapeHtml(item.label)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>` : ''}
			</div>
		`).join('');

		// Opening a row must not fire when a control inside it was clicked.
		list.querySelectorAll('.panel-row-openable').forEach(row => row.addEventListener('click', (e) => {
			if (e.target.closest('button, input')) { return; }
			const item = items[Number(row.dataset.idx)];
			if (item && item.path) { vscode.postMessage({ type: 'openFile', payload: { path: item.path } }); }
		}));
		list.querySelectorAll('.panel-row-toggle').forEach(box => box.addEventListener('change', (e) => {
			const item = items[Number(e.currentTarget.dataset.idx)];
			if (item) { vscode.postMessage({ type: 'setSkillEnabled', payload: { name: item.label, enabled: e.currentTarget.checked } }); }
		}));
		list.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', (e) => {
			const item = items[Number(e.currentTarget.dataset.del)];
			if (item && item.path) { vscode.postMessage({ type: 'deleteFile', payload: { path: item.path, panelId } }); }
		}));
		list.querySelectorAll('[data-cycle]').forEach(btn => btn.addEventListener('click', (e) => {
			const idx = Number(e.currentTarget.dataset.cycle);
			const item = items[idx];
			if (!item) { return; }
			const next = TASK_STATUS_CYCLE[(TASK_STATUS_CYCLE.indexOf(item.status) + 1) % TASK_STATUS_CYCLE.length];
			vscode.postMessage({ type: 'updateTaskStatus', payload: { index: item.index !== undefined ? item.index : idx, status: next } });
		}));
	}

	/** "2.4 KB · edited 12/03/2026" for a file row. */
	function formatMeta(item) {
		const parts = [];
		if (typeof item.size === 'number') {
			parts.push(item.size < 1024 ? `${item.size} B` : `${(item.size / 1024).toFixed(1)} KB`);
		}
		if (typeof item.mtime === 'number') {
			parts.push(`edited ${new Date(item.mtime).toLocaleDateString()}`);
		}
		return escapeHtml(parts.join(' · '));
	}

	// ---------- Settings ----------

	function wireSettings(panelId, body) {
		if (panelId !== 'settings') { return; }
		const apiKeyInput = body.querySelector('#settingsApiKey');
		const apiKeySave = body.querySelector('#settingsApiKeySave');
		const apiKeyTest = body.querySelector('#settingsApiKeyTest');
		const baseUrlInput = body.querySelector('#settingsBaseUrl');
		const fetchModels = body.querySelector('#settingsFetchModels');
		const openMcpBtn = body.querySelector('#settingsOpenMcp');

		// Paint whatever was last pushed so the form is never blank, then ask for
		// the authoritative values in case configuration changed elsewhere.
		applySettings(settings);
		vscode.postMessage({ type: 'requestSettings' });

		const persist = () => {
			settings = readSettingsForm(body);
			vscode.postMessage({ type: 'settingsUpdate', payload: settings });
		};

		apiKeySave.addEventListener('click', () => {
			const key = apiKeyInput.value.trim();
			if (key) {
				vscode.postMessage({ type: 'setApiKey', payload: key });
				apiKeyInput.value = '';
				setApiKeyHint('Saved to Secret Storage. Validate checks it against the endpoint above.');
			} else {
				// Silence here reads as a broken button; there is genuinely nothing to save.
				setApiKeyHint('Type a key first — Save stores whatever is in the field.');
			}
		});
		apiKeyTest.addEventListener('click', () => {
			// The URL in the form, not the saved one: the point of Validate is to check a
			// key and endpoint pair before either is committed. An empty field means the
			// saved key — the field is cleared on save, so that is the common case.
			setApiKeyHint(apiKeyInput.value.trim() ? 'Checking the key in the field…' : 'Checking the saved key…');
			vscode.postMessage({
				type: 'validateApiKey',
				payload: { key: apiKeyInput.value.trim() || undefined, baseUrl: baseUrlInput.value.trim() },
			});
		});
		if (fetchModels) {
			fetchModels.addEventListener('click', () => {
				setModelHint('Asking the endpoint…');
				vscode.postMessage({
					type: 'fetchEndpointModels',
					// An unsaved key still counts, so a brand-new endpoint can be listed in
					// one step; the workbench falls back to secret storage when it is empty.
					payload: { key: apiKeyInput.value.trim() || undefined, baseUrl: baseUrlInput.value.trim() },
				});
			});
		}
		// The endpoint is a text field: save it when the user leaves it or presses
		// Enter, not on every keystroke, so a half-typed URL is never pushed.
		baseUrlInput.addEventListener('change', persist);
		baseUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { persist(); } });
		body.querySelectorAll('#settingsFallbackModel, #settingsOutputStyle, #settingsEffort, #settingsFastMode, #settingsCoordinatorMode, #settingsAdvisorModel, #settingsMaxTurns, #settingsMaxThinkingTokens, #settingsSystemPrompt, #settingsSandboxEnabled, #settingsSandboxAutoAllow, #settingsSandboxFallback, #settingsSandboxExcluded, #settingsVimMode, #settingsVoiceMode, #settingsShowOnStartup, #settingsAutoCompact')
			.forEach(el => el.addEventListener('change', persist));
		body.querySelectorAll('input[name="permMode"], .settings-source').forEach(r => r.addEventListener('change', persist));
		if (openMcpBtn) { openMcpBtn.addEventListener('click', () => openPanel('mcp')); }
	}

	/** One line in the Model group: what the last endpoint lookup found. */
	function setModelHint(text) {
		const hint = document.getElementById('settingsModelHint');
		if (hint) { hint.textContent = text; }
	}

	/** One line under the API key row: what the last Save or Validate did. */
	function setApiKeyHint(text) {
		const hint = document.getElementById('settingsApiKeyHint');
		if (hint) { hint.textContent = text; }
	}

	/**
	 * Add the endpoint's own models to the pickers that offer models, keeping the
	 * built-in list — the endpoint's answer is authoritative about what it serves, but a
	 * gateway that lists nothing should not empty a working dropdown.
	 *
	 * Since Section 8 this panel has no model select of its own to fill; what a lookup is
	 * for is the input bar's picker and the fallback list, both of which read
	 * `endpointModels` when they are next drawn.
	 */
	function applyEndpointModels(payload) {
		const data = payload || {};
		if (data.error) {
			setModelHint(`Could not list models: ${data.error}`);
			return;
		}
		const models = Array.isArray(data.models) ? data.models : [];
		// Remember them: a lookup done once should still be there for the input bar's
		// inline picker and for the next time the form is opened.
		const remembered = new Set(endpointModels.map(m => m.value));
		for (const model of models) {
			if (!model || !model.value || remembered.has(model.value)) { continue; }
			remembered.add(model.value);
			endpointModels.push({ value: model.value, label: model.displayName || model.value });
		}
		setModelHint(models.length
			? `${models.length} model${models.length === 1 ? '' : 's'} from ${data.endpoint || 'the endpoint'}. Pick one from the input bar.`
			: `${data.endpoint || 'The endpoint'} listed no Anthropic-compatible models.`);
	}

	/** Read the settings form into the payload shape the workbench expects. */
	function readSettingsForm(body) {
		return {
			// Trailing slashes off: the engine builds `${base}/v1/...` from this.
			baseUrl: body.querySelector('#settingsBaseUrl').value.trim().replace(/\/+$/, ''),
			// Section 8: there is no model select in this form. Carrying the configured
			// model through unchanged keeps the workbench's echo consistent with what it
			// already has — the form must not be able to change which model is active, and
			// dropping the key would leave the panel's own copy of the settings short one
			// field until the next echo arrives.
			model: settings.model,
			fallbackModel: body.querySelector('#settingsFallbackModel').value,
			outputStyle: body.querySelector('#settingsOutputStyle').value,
			effort: body.querySelector('#settingsEffort').value,
			fastMode: body.querySelector('#settingsFastMode').checked,
			coordinatorMode: body.querySelector('#settingsCoordinatorMode').checked,
			advisorModel: body.querySelector('#settingsAdvisorModel').value,
			maxTurns: Number(body.querySelector('#settingsMaxTurns').value) || 40,
			maxThinkingTokens: Number(body.querySelector('#settingsMaxThinkingTokens').value) || 0,
			systemPrompt: body.querySelector('#settingsSystemPrompt').value,
			permissionMode: body.querySelector('input[name="permMode"]:checked')?.value || 'default',
			sandbox: {
				enabled: body.querySelector('#settingsSandboxEnabled').checked,
				autoAllowBashIfSandboxed: body.querySelector('#settingsSandboxAutoAllow').checked,
				allowUnsandboxedCommands: body.querySelector('#settingsSandboxFallback').checked,
				excludedCommands: body.querySelector('#settingsSandboxExcluded').value
					.split('\n').map(line => line.trim()).filter(Boolean),
			},
			settingSources: Array.from(body.querySelectorAll('.settings-source'))
				.filter(box => box.checked).map(box => box.value),
			vimMode: body.querySelector('#settingsVimMode').checked,
			voiceMode: body.querySelector('#settingsVoiceMode').checked,
			showOnStartup: body.querySelector('#settingsShowOnStartup').checked,
			autoCompact: body.querySelector('#settingsAutoCompact').checked,
		};
	}

	/**
	 * Store the workbench's settings and, when the settings panel is on screen,
	 * push them into the form. Called from agent.js on every `settingsData`.
	 */
	function applySettings(payload) {
		settings = payload || {};
		if (activePanel !== 'settings') { return; }
		const body = document.getElementById('panelBody');
		// The endpoint field is in every version of this form, so it is what "the settings
		// form is on screen" is asked about. (It used to be the model select, which
		// Section 8 removed.)
		if (!body || !body.querySelector('#settingsBaseUrl')) { return; }

		// Never overwrite a URL the user is in the middle of typing: this runs on every
		// settings echo, including the one the user's own edit triggered.
		const baseUrlInput = body.querySelector('#settingsBaseUrl');
		if (baseUrlInput && document.activeElement !== baseUrlInput) {
			baseUrlInput.value = settings.baseUrl || '';
		}
		// Same '' handling as the advisor below: an empty value means "no fallback".
		const fallback = settings.fallbackModel || '';
		if (fallback) {
			setSelectValue(body.querySelector('#settingsFallbackModel'), fallback, MODEL_OPTIONS.map(m => m.value));
		} else {
			body.querySelector('#settingsFallbackModel').value = '';
		}
		// Styles the workbench found in `.claude/output-styles/` ride along with the
		// settings payload; without an option for each, the select could not show one.
		const styleValues = Array.isArray(settings.outputStyleOptions) && settings.outputStyleOptions.length
			? settings.outputStyleOptions
			: OUTPUT_STYLE_OPTIONS.map(s => s.value);
		syncExtraOptions(body.querySelector('#settingsOutputStyle'), styleValues, settings.outputStyle || 'default', name => `${name} — from .claude/output-styles`);
		setSelectValue(body.querySelector('#settingsOutputStyle'), settings.outputStyle || 'default', styleValues);
		setSelectValue(body.querySelector('#settingsEffort'), settings.effort || 'auto', EFFORT_OPTIONS.map(e => e.value));
		body.querySelector('#settingsFastMode').checked = settings.fastMode === true;
		body.querySelector('#settingsCoordinatorMode').checked = settings.coordinatorMode === true;
		// '' is the real "no advisor" value, and setSelectValue treats a falsy value
		// as "nothing to apply", so select the None option directly.
		const advisor = settings.advisorModel || '';
		if (advisor) {
			setSelectValue(body.querySelector('#settingsAdvisorModel'), advisor, ADVISOR_OPTIONS.map(m => m.value));
		} else {
			body.querySelector('#settingsAdvisorModel').value = '';
		}
		body.querySelector('#settingsMaxTurns').value = settings.maxTurns !== undefined ? settings.maxTurns : 40;
		body.querySelector('#settingsMaxThinkingTokens').value = settings.maxThinkingTokens !== undefined ? settings.maxThinkingTokens : 0;
		body.querySelector('#settingsSystemPrompt').value = settings.systemPrompt || '';
		const mode = settings.permissionMode || 'default';
		const radio = body.querySelector(`input[name="permMode"][value="${mode}"]`);
		if (radio) { radio.checked = true; }
		const sandbox = settings.sandbox || {};
		body.querySelector('#settingsSandboxEnabled').checked = sandbox.enabled === true;
		body.querySelector('#settingsSandboxAutoAllow').checked = sandbox.autoAllowBashIfSandboxed === true;
		body.querySelector('#settingsSandboxFallback').checked = sandbox.allowUnsandboxedCommands === true;
		body.querySelector('#settingsSandboxExcluded').value = (sandbox.excludedCommands || []).join('\n');
		// No `settingSources` key at all means the engine default (all three on);
		// an empty array is a real choice — isolation mode — so it must stay empty.
		const sources = Array.isArray(settings.settingSources) ? settings.settingSources : SETTING_SOURCES.map(s => s.value);
		body.querySelectorAll('.settings-source').forEach(box => { box.checked = sources.includes(box.value); });
		body.querySelector('#settingsVimMode').checked = settings.vimMode === true;
		body.querySelector('#settingsVoiceMode').checked = settings.voiceMode === true;
		body.querySelector('#settingsShowOnStartup').checked = settings.showOnStartup !== false;
		// Defaults on, like the registered setting. The engine's environment can veto
		// auto-compaction outright, in which case the workbench echoes this back as
		// false and the box snaps off again — that is the veto, not a lost write.
		body.querySelector('#settingsAutoCompact').checked = settings.autoCompact !== false;
	}

	/**
	 * Select `value`, adding an option for it first when the user configured a
	 * model the list does not know about — otherwise the select would silently
	 * show something other than what is in effect.
	 */
	function setSelectValue(select, value, known) {
		if (!select || !value) { return; }
		// The option may already be there from an earlier repaint: `applySettings`
		// runs on every settings change, and appending blindly would stack duplicates.
		if (!known.includes(value) && !Array.from(select.options).some(option => option.value === value)) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = `${value} (from settings)`;
			select.appendChild(option);
		}
		select.value = value;
	}

	/**
	 * Make `select` offer exactly `values`, keeping the options the markup declared
	 * and labelling the ones it did not with `label(value)`. `keep` is the value in
	 * effect: its option survives even when it is no longer in `values`, so a style
	 * file deleted while the panel is open does not blank the dropdown.
	 */
	function syncExtraOptions(select, values, keep, label) {
		if (!select) { return; }
		for (const option of Array.from(select.options)) {
			if (option.dataset.extra === '1' && !values.includes(option.value) && option.value !== keep) {
				option.remove();
			}
		}
		for (const value of values) {
			if (Array.from(select.options).some(option => option.value === value)) { continue; }
			const option = document.createElement('option');
			option.value = value;
			option.textContent = label(value);
			option.dataset.extra = '1';
			select.appendChild(option);
		}
	}

	// ---------- MCP ----------

	function wireMcp(panelId, body) {
		if (panelId !== 'mcp') { return; }
		const addBtn = body.querySelector('#mcpAddBtn');
		const addForm = body.querySelector('#mcpAddForm');
		const cancelBtn = body.querySelector('#mcpAddCancel');
		const saveBtn = body.querySelector('#mcpAddSave');
		const reconnectBtn = body.querySelector('#mcpReconnectBtn');
		const typeSelect = body.querySelector('#mcpAddType');
		const stdioOnly = body.querySelectorAll('.mcp-stdio-only');
		const httpOnly = body.querySelectorAll('.mcp-http-only');
		if (!addBtn) { return; }

		// Same two-step as settings: cached list first, then the live one carrying
		// each server's connection status and contributed tools.
		renderMcp(mcpServers);
		vscode.postMessage({ type: 'requestMcpServers' });

		addBtn.addEventListener('click', () => addForm.classList.remove('hidden'));
		cancelBtn.addEventListener('click', () => addForm.classList.add('hidden'));
		reconnectBtn.addEventListener('click', () => vscode.postMessage({ type: 'mcpReconnect' }));
		typeSelect.addEventListener('change', () => {
			const isHttp = typeSelect.value !== 'stdio';
			stdioOnly.forEach(el => el.classList.toggle('hidden', isHttp));
			httpOnly.forEach(el => el.classList.toggle('hidden', !isHttp));
		});
		saveBtn.addEventListener('click', () => {
			const type = typeSelect.value;
			const name = body.querySelector('#mcpAddName').value.trim();
			if (!name) { return; }
			const entry = { name, type, enabled: true };
			if (type === 'stdio') {
				entry.command = body.querySelector('#mcpAddCommand').value.trim();
				entry.args = body.querySelector('#mcpAddArgs').value.split('\n').map(s => s.trim()).filter(Boolean);
				entry.env = Object.fromEntries(
					body.querySelector('#mcpAddEnv').value.split('\n').filter(line => line.includes('=')).map(line => {
						const eq = line.indexOf('=');
						return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
					})
				);
			} else {
				entry.url = body.querySelector('#mcpAddUrl').value.trim();
			}
			// Replace an existing server with the same name rather than duplicating it.
			const next = mcpServers.filter(s => s.name !== name).concat(entry);
			pushMcpServers(next);
			addForm.classList.add('hidden');
			clearMcpForm(body);
		});
	}

	function clearMcpForm(body) {
		['#mcpAddName', '#mcpAddCommand', '#mcpAddArgs', '#mcpAddEnv', '#mcpAddUrl'].forEach(sel => {
			const el = body.querySelector(sel);
			if (el) { el.value = ''; }
		});
	}

	/** Send the authoritative list to the workbench, which persists it. */
	function pushMcpServers(servers) {
		mcpServers = servers;
		vscode.postMessage({ type: 'mcpUpdate', payload: servers.map(stripStatus) });
		renderMcp(mcpServers);
	}

	/** Status and tools are engine state, never part of the saved config. */
	function stripStatus(server) {
		const { status, tools, ...rest } = server;
		return rest;
	}

	/**
	 * Render the server list with the live status the engine reported. Called
	 * from agent.js on every `mcpData`.
	 */
	function renderMcp(servers) {
		mcpServers = Array.isArray(servers) ? servers : [];
		if (activePanel !== 'mcp') { return; }
		const list = document.getElementById('mcpList');
		if (!list) { return; }
		if (!mcpServers.length) {
			list.innerHTML = '<div class="mcp-empty">No MCP servers configured.</div>';
			return;
		}
		list.innerHTML = mcpServers.map((s, i) => `
			<div class="mcp-row" data-idx="${i}">
				<div class="mcp-info">
					<div class="mcp-name">${escapeHtml(s.name)}${s.enabled === false ? ' <span class="mcp-off">disabled</span>' : ''}</div>
					<div class="mcp-detail">${escapeHtml(s.type || 'stdio')} · ${escapeHtml(s.type && s.type !== 'stdio' ? (s.url || '') : (s.command || ''))}</div>
					${s.tools && s.tools.length ? `<div class="mcp-tools">${s.tools.map(t => `<span class="tool-chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
				</div>
				<div class="mcp-status status-${escapeHtml(s.status || 'disconnected')}">${escapeHtml(s.status || 'disconnected')}</div>
				<div class="mcp-actions">
					<button class="icon-btn" data-act="toggle" data-idx="${i}" title="${s.enabled === false ? 'Enable' : 'Disable'}" aria-label="${s.enabled === false ? 'Enable' : 'Disable'} ${escapeHtml(s.name)}">
						<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${s.enabled === false ? '<path d="M5 12h14"/>' : '<path d="M20 6L9 17l-5-5"/>'}</svg>
					</button>
					<button class="icon-btn" data-act="reconnect" data-idx="${i}" title="Reconnect" aria-label="Reconnect ${escapeHtml(s.name)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 10 15 10"/></svg></button>
					<button class="icon-btn" data-act="remove" data-idx="${i}" title="Remove" aria-label="Remove ${escapeHtml(s.name)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
				</div>
			</div>
		`).join('');

		list.querySelectorAll('[data-act="remove"]').forEach(btn => btn.addEventListener('click', (e) => {
			const idx = Number(e.currentTarget.dataset.idx);
			pushMcpServers(mcpServers.filter((_, i) => i !== idx));
		}));
		list.querySelectorAll('[data-act="toggle"]').forEach(btn => btn.addEventListener('click', (e) => {
			const idx = Number(e.currentTarget.dataset.idx);
			pushMcpServers(mcpServers.map((s, i) => i === idx ? { ...s, enabled: s.enabled === false } : s));
		}));
		list.querySelectorAll('[data-act="reconnect"]').forEach(btn => btn.addEventListener('click', () => {
			vscode.postMessage({ type: 'mcpReconnect' });
		}));
	}

	// ---------- Commit review sheet ----------

	/**
	 * Show the proposed commit message for the files `/commit` staged. The user
	 * can edit the message before confirming; either way the workbench is told,
	 * so it can run `git commit` or report the cancellation.
	 */
	function showCommitReview(payload) {
		const message = (payload && payload.message) || '';
		const files = (payload && payload.files) || [];
		showSheet({
			title: 'Review commit',
			className: 'commit-sheet',
			body: `
				<div class="form-group">
					<label for="commitMessage">Commit message</label>
					<textarea id="commitMessage" rows="6" spellcheck="false">${escapeHtml(message)}</textarea>
				</div>
				<div class="form-group">
					<label>Staged files (${files.length})</label>
					<div class="commit-files">${files.map(f => `<div class="commit-file">${escapeHtml(f)}</div>`).join('') || '<div class="panel-empty">Nothing staged.</div>'}</div>
				</div>
			`,
			confirmLabel: 'Commit',
			onConfirm: (sheet) => {
				const edited = sheet.querySelector('#commitMessage').value.trim();
				if (!edited) { return false; }
				vscode.postMessage({ type: 'commitResponse', payload: { confirmed: true, message: edited } });
				return true;
			},
			onCancel: () => vscode.postMessage({ type: 'commitResponse', payload: { confirmed: false } }),
			onOpen: (sheet) => {
				const area = sheet.querySelector('#commitMessage');
				area.focus();
				area.setSelectionRange(area.value.length, area.value.length);
			},
		});
	}

	// ---------- Generic sheet ----------

	/**
	 * A modal sheet built on the same markup as the API-key dialog. Returns after
	 * mounting; `onConfirm` returning false keeps the sheet open (invalid input).
	 */
	function showSheet(spec) {
		const overlay = document.createElement('div');
		overlay.className = 'modal-overlay';
		overlay.innerHTML = `
			<div class="modal ${spec.className || ''}" role="dialog" aria-modal="true">
				<h2>${escapeHtml(spec.title)}</h2>
				${spec.body}
				<div class="modal-actions">
					<button class="btn btn-secondary" data-sheet="cancel">Cancel</button>
					<button class="btn btn-primary" data-sheet="confirm">${escapeHtml(spec.confirmLabel || 'OK')}</button>
				</div>
			</div>
		`;
		document.body.appendChild(overlay);

		// The exit takes a hundred milliseconds (Section 6.10), and for that long the sheet is
		// still in the document — so a second Cancel must not run `onCancel` again.
		let closing = false;
		const close = () => {
			if (closing) { return; }
			closing = true;
			document.removeEventListener('keydown', onKeydown);
			// agent.js owns the shared exit animation; without it the sheet just goes.
			const agent = window.CodeMindAgent;
			if (agent && agent.playOut) {
				agent.playOut(overlay, () => overlay.remove());
			} else {
				overlay.remove();
			}
		};
		const cancel = () => {
			if (closing) { return; }
			if (spec.onCancel) { spec.onCancel(); }
			close();
		};
		const confirm = () => {
			if (closing) { return; }
			if (spec.onConfirm(overlay) !== false) { close(); }
		};
		function onKeydown(e) {
			if (e.key === 'Escape') { cancel(); }
			// Ctrl/Cmd+Enter confirms from inside a textarea, where Enter is a newline.
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { confirm(); }
		}

		overlay.querySelector('[data-sheet="cancel"]').addEventListener('click', cancel);
		overlay.querySelector('[data-sheet="confirm"]').addEventListener('click', confirm);
		overlay.addEventListener('click', (e) => { if (e.target === overlay) { cancel(); } });
		document.addEventListener('keydown', onKeydown);
		if (spec.onOpen) { spec.onOpen(overlay); }
	}

	function escapeHtml(t) {
		if (t == null) return '';
		return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
	}

	// ---------- One-setting pickers (Alt+P / Alt+T / Alt+O) ----------
	//
	// The CLI puts its model and thinking pickers one chord away from the prompt, so
	// the panel does too rather than making the settings form the only route. They
	// write through the same `settingsUpdate` message the form uses.

	/**
	 * A radio list in a sheet. `spec` is `{ title, options, current, onPick }`;
	 * `options` are `{ value, label }` and `onPick` gets the chosen value.
	 */
	function showPicker(spec) {
		const rows = spec.options.map((opt, i) => `
			<label>
				<input type="radio" name="pickerChoice" value="${escapeHtml(opt.value)}" id="pickerChoice${i}"${opt.value === spec.current ? ' checked' : ''}>
				<span>${escapeHtml(opt.label)}</span>
			</label>
		`).join('');
		showSheet({
			title: spec.title,
			className: 'picker-sheet',
			body: `<div class="radio-group">${rows}</div>`,
			confirmLabel: 'Apply',
			onConfirm(overlay) {
				const picked = overlay.querySelector('input[name="pickerChoice"]:checked');
				if (!picked) { return false; }
				spec.onPick(picked.value);
				return true;
			},
			onOpen(overlay) {
				// Focus the current choice so the arrow keys move through the list at once.
				const checked = overlay.querySelector('input[name="pickerChoice"]:checked') || overlay.querySelector('input[name="pickerChoice"]');
				if (checked) { checked.focus(); }
			},
		});
	}

	/**
	 * Change one setting without touching the rest. The workbench merges partial
	 * payloads, but the full snapshot is sent anyway so a stale value elsewhere in
	 * the form can never be written back by a later save.
	 */
	function pushSettingChange(patch) {
		settings = { ...settings, ...patch };
		vscode.postMessage({ type: 'settingsUpdate', payload: settings });
		// Keep an open settings form in step; a `settingsData` reply will confirm it.
		if (activePanel === 'settings') { applySettings(settings); }
	}

	function showModelPicker() {
		showPicker({
			title: 'Model for new turns',
			options: modelOptions(),
			current: settings.model || '',
			onPick: (value) => pushSettingChange({ model: value }),
		});
	}

	/**
	 * Set the active model from outside this file. The composer's pill owns model
	 * selection now (Section 2.2), so it needs the same one-setting write the picker
	 * uses rather than a second path into the settings payload.
	 */
	function selectModel(value) {
		pushSettingChange({ model: value });
	}

	function showEffortPicker() {
		showPicker({
			title: 'Reasoning effort',
			options: EFFORT_OPTIONS,
			current: settings.effort || 'auto',
			onPick: (value) => pushSettingChange({ effort: value }),
		});
	}

	/** Flip fast mode and report the new value, so the caller can say which way it went. */
	function toggleFastMode() {
		const next = settings.fastMode !== true;
		pushSettingChange({ fastMode: next });
		return next;
	}

	window.CodeMindPanels = {
		openPanel, closePanel, renderPanelData, applySettings, applyEndpointModels, renderMcp, showCommitReview, showSheet,
		showPicker, showModelPicker, showEffortPicker, toggleFastMode,
		// The composer's model pill renders this list itself and writes back through
		// selectModel, so both are part of the surface now.
		modelOptions, selectModel,
		getActivePanel: () => activePanel,
	};
})();
