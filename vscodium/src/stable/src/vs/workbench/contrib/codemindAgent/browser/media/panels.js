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
	 * The models the composer picker offers, each tagged with the provider that serves
	 * it so a pick can switch endpoint + key + model together, and with that provider's
	 * display name so the menu can say which model comes from where. Built from the
	 * curated `settings.pickerModels` (chosen across every provider in Settings),
	 * dropping any whose provider is gone or disabled. When nothing is curated it falls
	 * back to the ACTIVE provider's models, which preserves the pre-curation behaviour.
	 * The current `settings.model` is always included, tagged with the active provider,
	 * so the model in effect stays selectable.
	 */
	function modelOptions() {
		const seen = new Set();
		const out = [];
		const providers = Array.isArray(settings.providers) ? settings.providers : [];
		const enabledById = new Map(providers.filter(p => p.enabled !== false).map(p => [p.id, p]));
		const active = providers.find(p => p.id === settings.activeProviderId) || providers.find(p => p.enabled !== false);
		const add = (value, providerId) => {
			// Key on the pair: the same model id served by two providers is two choices.
			const key = `${providerId || ''} ${value}`;
			if (!value || seen.has(key)) { return; }
			seen.add(key);
			out.push({ value, label: labelForModel(value), providerId, providerName: providerNameFor(providerId) });
		};
		const picker = Array.isArray(settings.pickerModels) ? settings.pickerModels : [];
		const curated = picker.filter(e => e && e.model && enabledById.has(e.providerId));
		if (curated.length) {
			for (const entry of curated) { add(entry.model, entry.providerId); }
		} else if (active && Array.isArray(active.models)) {
			for (const value of active.models) { add(value, active.id); }
		}
		if (settings.model) { add(settings.model, settings.activeProviderId); }
		return out;
	}

	/** The display name of a provider by id, for the badge on a composer model row. */
	function providerNameFor(providerId) {
		if (!providerId) { return ''; }
		const providers = Array.isArray(settings.providers) ? settings.providers : [];
		const provider = providers.find(p => p.id === providerId);
		return provider ? (provider.name || 'Provider') : '';
	}

	/** A friendly label for a model id, using the built-in names where one is known. */
	function labelForModel(value) {
		const known = MODEL_OPTIONS.find(m => m.value === value);
		return known ? known.label : value;
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
		 * This panel owns provider *configuration* — the endpoints, their keys, the model
		 * lists each serves, and which provider is active — but not model *selection*.
		 * Which model answers the next turn is chosen in the input bar; that picker shows
		 * the active provider's curated models.
		 */
		settings: () => `
			<h2>Settings</h2>
			<div class="setting-group">
				<label>Providers</label>
				<div class="setting-hint">Anthropic-compatible endpoints. The active provider's key and endpoint drive the agent, and every model it serves is imported. Keys are stored securely, never in settings.</div>
				<div class="provider-list" id="providerList"></div>
				<button class="btn btn-secondary" id="providerAddBtn">＋ Add provider</button>
				<div class="provider-form hidden" id="providerForm">
					<div class="form-group">
						<label for="providerName">Name</label>
						<input type="text" id="providerName" placeholder="e.g. Anthropic" autocomplete="off" spellcheck="false">
					</div>
					<div class="form-group">
						<label for="providerBaseUrl">Endpoint URL</label>
						<input type="text" id="providerBaseUrl" placeholder="https://api.anthropic.com" autocomplete="off" spellcheck="false">
						<div class="setting-hint">The provider's API base address — host only, no <code>/v1</code> and no path. Leave empty for the official Anthropic API.</div>
					</div>
					<div class="form-group">
						<label for="providerApiKey">API Key</label>
						<div class="api-key-row">
							<input type="password" id="providerApiKey" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">
							<button class="btn btn-secondary" id="providerValidate">Validate</button>
						</div>
						<div class="setting-hint" id="providerKeyHint">Stored securely once you save the provider.</div>
					</div>
					<div class="form-group">
						<label>Models available from this provider</label>
						<button class="btn btn-secondary" id="providerFetch">Fetch models</button>
						<div class="setting-hint" id="providerFetchHint">Ask the endpoint what it serves — every model it lists is imported. You can also add a model id or alias by hand. Choose which of them appear in the composer under "Models in the picker" below.</div>
						<div class="provider-models" id="providerModelChecks"></div>
						<div class="provider-manual-row">
							<input type="text" id="providerManualModel" placeholder="add a model id or alias, e.g. sonnet" autocomplete="off" spellcheck="false">
							<button class="btn btn-secondary" id="providerManualAdd">Add</button>
						</div>
					</div>
					<div class="form-actions">
						<button class="btn btn-secondary" id="providerCancel">Cancel</button>
						<button class="btn btn-primary" id="providerSave">Save provider</button>
					</div>
				</div>
			</div>
			<div class="setting-group">
				<label>Models in the picker</label>
				<div class="setting-hint">Which models the composer's model menu offers, chosen across every provider. Leave none selected to fall back to the active provider's models.</div>
				<button class="btn btn-secondary" id="pickerModelsBtn">Choose models…</button>
				<div class="setting-hint picker-models-summary" id="pickerModelsSummary"></div>
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

		history: () => `
			<h2>Chat History</h2>
			<div class="setting-group history-search-group">
				<input type="text" id="historySearch" class="history-search" placeholder="Search by topic or project path…" autocomplete="off" spellcheck="false">
			</div>
			<div class="mcp-toolbar history-toolbar">
				<label class="toggle-row"><input type="checkbox" id="historyAllProjects"> <span>All projects</span></label>
			</div>
			<div class="panel-rows" id="historyList">
				<div class="panel-empty">Loading…</div>
			</div>
			<div class="setting-hint" style="margin-top:14px;">Past conversations from this project's transcripts. Click one to bring it back into the chat; the trash button deletes it for good.</div>
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
		history: 'Chat History',
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
		wireHistory(panelId, body);
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

	// ---------- Chat History ----------

	/** Rows last pushed by the workbench, kept so the search box can filter locally. */
	let historyEntries = [];
	/** Whether the last request asked for every project, echoed back to keep the toggle honest. */
	let historyAllProjects = false;

	/**
	 * The history panel is populated by the workbench. Wire the search box (local
	 * filter, no round trip) and the All-projects toggle (a fresh request, since it
	 * changes which directories are read), then ask for the initial list.
	 */
	function wireHistory(panelId, body) {
		if (panelId !== 'history') { return; }
		const search = body.querySelector('#historySearch');
		const allBox = body.querySelector('#historyAllProjects');
		if (search) { search.addEventListener('input', () => renderHistoryRows()); }
		if (allBox) {
			allBox.checked = historyAllProjects;
			allBox.addEventListener('change', () => {
				historyAllProjects = allBox.checked;
				const list = document.getElementById('historyList');
				if (list) { list.innerHTML = '<div class="panel-empty">Loading…</div>'; }
				vscode.postMessage({ type: 'requestHistory', payload: { allProjects: historyAllProjects } });
			});
		}
		vscode.postMessage({ type: 'requestHistory', payload: { allProjects: historyAllProjects } });
	}

	/** Store the workbench's history rows and paint them. Called from agent.js on `historyData`. */
	function renderHistory(entries, allProjects) {
		historyEntries = Array.isArray(entries) ? entries : [];
		if (typeof allProjects === 'boolean') {
			historyAllProjects = allProjects;
			const allBox = document.getElementById('historyAllProjects');
			if (allBox) { allBox.checked = allProjects; }
		}
		renderHistoryRows();
	}

	/** Paint the rows currently in `historyEntries`, filtered by the search box. */
	function renderHistoryRows() {
		const list = document.getElementById('historyList');
		if (!list) { return; }
		const query = (document.getElementById('historySearch')?.value || '').trim().toLowerCase();
		const rows = historyEntries.filter(e => {
			if (!query) { return true; }
			const haystack = `${e.topic || ''} ${e.cwd || e.projectDir || ''}`.toLowerCase();
			return haystack.includes(query);
		});
		if (!rows.length) {
			list.innerHTML = `<div class="panel-empty">${historyEntries.length ? 'No conversations match your search.' : 'No past conversations yet.'}</div>`;
			return;
		}
		list.innerHTML = rows.map((e, i) => `
			<div class="panel-row panel-row-openable history-row" data-idx="${i}">
				<div class="panel-row-main">
					<div class="panel-row-label">
						${escapeHtml(e.topic || '(no prompt recorded)')}
						${e.current ? '' : '<span class="panel-row-badge" title="Recorded in another project — read-only">other project</span>'}
					</div>
					<div class="panel-row-detail history-path" title="${escapeHtml(e.cwd || e.projectDir || '')}">${escapeHtml(e.cwd || e.projectDir || '')}</div>
					<div class="panel-row-meta">${escapeHtml(formatHistoryMeta(e))}</div>
				</div>
				<button class="icon-btn panel-row-delete" data-del="${i}" title="Delete this conversation" aria-label="Delete conversation"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
			</div>
		`).join('');

		list.querySelectorAll('.history-row').forEach(row => row.addEventListener('click', (e) => {
			if (e.target.closest('button')) { return; }
			const entry = rows[Number(row.dataset.idx)];
			if (!entry) { return; }
			vscode.postMessage({ type: 'openSession', payload: { id: entry.id, projectDir: entry.projectDir, current: entry.current === true } });
			closePanel();
		}));
		list.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
			const entry = rows[Number(btn.dataset.del)];
			if (!entry) { return; }
			showSheet({
				title: 'Delete this conversation?',
				className: 'confirm-sheet',
				body: `<p>${escapeHtml(entry.topic || '(no prompt recorded)')}</p><p class="setting-hint">The transcript is moved to the trash. This cannot be undone from here.</p>`,
				confirmLabel: 'Delete',
				onConfirm: () => {
					vscode.postMessage({ type: 'deleteSession', payload: { id: entry.id, projectDir: entry.projectDir } });
					// Optimistic: drop it locally so the row goes at once; the workbench
					// re-sends the list after the delete lands anyway.
					historyEntries = historyEntries.filter(x => !(x.id === entry.id && x.projectDir === entry.projectDir));
					renderHistoryRows();
					return true;
				},
			});
		}));
	}

	/** "12/03/2026 · 34 messages" for a history row. */
	function formatHistoryMeta(entry) {
		const parts = [];
		if (typeof entry.at === 'number') { parts.push(new Date(entry.at).toLocaleDateString()); }
		if (typeof entry.messages === 'number') { parts.push(`${entry.messages} message${entry.messages === 1 ? '' : 's'}`); }
		return parts.join(' · ');
	}

	// ---------- Settings ----------

	function wireSettings(panelId, body) {
		if (panelId !== 'settings') { return; }
		const openMcpBtn = body.querySelector('#settingsOpenMcp');

		// Paint whatever was last pushed so the form is never blank, then ask for
		// the authoritative values in case configuration changed elsewhere.
		applySettings(settings);
		vscode.postMessage({ type: 'requestSettings' });

		const persist = () => {
			settings = readSettingsForm(body);
			vscode.postMessage({ type: 'settingsUpdate', payload: settings });
		};

		wireProviders(body);

		const pickerModelsBtn = body.querySelector('#pickerModelsBtn');
		if (pickerModelsBtn) { pickerModelsBtn.addEventListener('click', showPickerModelsSheet); }

		body.querySelectorAll('#settingsFallbackModel, #settingsOutputStyle, #settingsEffort, #settingsFastMode, #settingsCoordinatorMode, #settingsAdvisorModel, #settingsMaxTurns, #settingsMaxThinkingTokens, #settingsSystemPrompt, #settingsSandboxEnabled, #settingsSandboxAutoAllow, #settingsSandboxFallback, #settingsSandboxExcluded, #settingsVimMode, #settingsVoiceMode, #settingsShowOnStartup, #settingsAutoCompact')
			.forEach(el => el.addEventListener('change', persist));
		body.querySelectorAll('input[name="permMode"], .settings-source').forEach(r => r.addEventListener('change', persist));
		if (openMcpBtn) { openMcpBtn.addEventListener('click', () => openPanel('mcp')); }
	}

	// ---------- Providers ----------

	/** Form state while adding/editing a provider. `editingId` null = adding new. */
	let providerDraft = { editingId: null, models: [] };
	/** Incremented per fetch; only the reply carrying the current value is applied. */
	let providerFetchToken = 0;

	/** Providers pushed by the workbench (from settings). */
	function currentProviders() {
		return Array.isArray(settings.providers) ? settings.providers : [];
	}

	/** Persist the whole providers array back to the workbench and repaint. */
	function pushProviders(providers) {
		settings = { ...settings, providers };
		vscode.postMessage({ type: 'providersUpdate', payload: providers });
		renderProviderList();
	}

	function wireProviders(body) {
		renderProviderList();
		const addBtn = body.querySelector('#providerAddBtn');
		const form = body.querySelector('#providerForm');
		const cancel = body.querySelector('#providerCancel');
		const save = body.querySelector('#providerSave');
		const validate = body.querySelector('#providerValidate');
		const fetch = body.querySelector('#providerFetch');
		const manualAdd = body.querySelector('#providerManualAdd');
		const manualInput = body.querySelector('#providerManualModel');
		if (!addBtn || !form) { return; }

		addBtn.addEventListener('click', () => openProviderForm(null));
		if (cancel) { cancel.addEventListener('click', () => closeProviderForm()); }
		if (save) { save.addEventListener('click', () => saveProvider(body)); }
		if (validate) {
			validate.addEventListener('click', () => {
				setProviderKeyHint('Checking the key against the endpoint…');
				vscode.postMessage({
					type: 'validateProviderKey',
					payload: {
						providerId: providerDraft.editingId || undefined,
						key: (body.querySelector('#providerApiKey').value || '').trim() || undefined,
						baseUrl: (body.querySelector('#providerBaseUrl').value || '').trim(),
					},
				});
			});
		}
		if (fetch) {
			fetch.addEventListener('click', () => {
				const key = (body.querySelector('#providerApiKey').value || '').trim() || undefined;
				const baseUrl = (body.querySelector('#providerBaseUrl').value || '').trim();

				if (!baseUrl) {
					setProviderFetchHint('Enter the endpoint URL first — the API base address your provider gave you, for example https://api.example.com.', 'error');
					return;
				}

				// A fetch replaces the list rather than adding to it: models left over
				// from a previous endpoint (or a previous URL typo) are not offered by
				// the one being probed now, and saving them would put dead ids in the
				// composer. Cleared up front so the stale list never lingers on screen
				// while the probe runs, and stays cleared if the probe fails.
				providerDraft.models = [];
				renderModelChecks();

				// Only the newest probe may write to the draft. Without this, fixing a
				// URL and re-fetching lets a slow first reply land last and overwrite
				// the correct result.
				providerFetchToken++;
				setProviderFetchBusy(true);
				setProviderFetchHint('Contacting the endpoint to list its models…', 'busy');

				// One probe does both jobs: it identifies the wire format *and* returns
				// the model list, so there is no second request to race with. (An earlier
				// version also fired `fetchProviderModels` on a timer; that reply landed
				// after the detection result and overwrote the detected models with the
				// Anthropic-only subset.)
				vscode.postMessage({
					type: 'fetchProviderModels',
					payload: {
						providerId: providerDraft.editingId || 'draft',
						baseUrl,
						key: key || '',
					},
				});
			});
		}
		if (manualAdd && manualInput) {
			const add = () => {
				const id = manualInput.value.trim();
				if (id && !providerDraft.models.includes(id)) {
					providerDraft.models.push(id);
					renderModelChecks();
				}
				manualInput.value = '';
			};
			manualAdd.addEventListener('click', add);
			manualInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
		}
	}

	/**
	 * Apply a `providerDetection` reply: the endpoint told us which wire format it
	 * speaks and which models it serves, so the draft is filled in from one probe
	 * instead of the user typing model ids by hand.
	 */
	function handleProviderDetection(result) {
		const data = result || {};

		// Ignore a reply from a superseded fetch. Older builds sent no requestId, so
		// a missing one is treated as current rather than silently dropped.
		if (typeof data.requestId === 'number' && data.requestId !== providerFetchToken) { return; }

		// The form may have been closed or switched to another provider while the
		// probe was in flight; applying the result then would edit the wrong draft.
		const form = document.getElementById('providerForm');
		if (!form || form.classList.contains('hidden')) { return; }

		setProviderFetchBusy(false);

		const models = Array.isArray(data.models) ? data.models.filter(m => typeof m === 'string' && m.trim()) : [];

		if (!data.success || !data.wire) {
			// The draft was already cleared at click time, so there is nothing stale to
			// undo here — just report what to fix. The backend's message names the
			// specific cause (bad address, refused key, unreachable host).
			setProviderFetchHint(data.error || 'Could not reach that endpoint or identify its protocol. Check the API base URL and the key.', 'error');
			renderModelChecks();
			return;
		}

		const label = data.wire === 'anthropic' ? 'Anthropic' : 'OpenAI';

		providerDraft.baseUrl = data.baseUrl;
		providerDraft.wire = data.wire;
		// De-duplicate: some gateways list the same id under several aliases, and a
		// duplicate would render twice and be stored twice.
		providerDraft.models = Array.from(new Set(models));

		const baseUrlInput = document.querySelector('#providerBaseUrl');
		// The backend normalises the address (adds a scheme, drops a trailing /v1), so
		// echo the corrected URL back — that is the form the provider will be saved
		// with, and seeing it change is how the user learns what was wrong.
		const corrected = baseUrlInput && data.baseUrl && baseUrlInput.value.trim() !== data.baseUrl;
		if (baseUrlInput && data.baseUrl) { baseUrlInput.value = data.baseUrl; }

		const count = providerDraft.models.length;
		const note = corrected ? ` The address was corrected to ${data.baseUrl}.` : '';
		// The engine speaks the Messages API; there is no OpenAI translation layer yet.
		// Saying so here — rather than letting the first chat fail — is the difference
		// between a known limitation and an apparent bug.
		const unsupported = data.wire === 'openai'
			? ' Note: CodeMind sends conversations in the Anthropic format, so this endpoint can be saved but cannot serve a chat yet.'
			: '';

		if (count) {
			setProviderFetchHint(
				`Detected the ${label} protocol and imported ${count} model${count === 1 ? '' : 's'}.${note} Remove any you do not want, then choose which appear in the composer under "Models in the picker".${unsupported}`,
				unsupported ? 'warn' : 'ok');
		} else {
			setProviderFetchHint(
				`Detected the ${label} protocol, but ${data.error || 'the endpoint published no model list'}.${note} Add the model ids by hand below.${unsupported}`,
				'warn');
		}

		renderModelChecks();
	}

	function renderProviderList() {
		const list = document.getElementById('providerList');
		if (!list) { return; }
		const providers = currentProviders();
		if (!providers.length) {
			list.innerHTML = '<div class="provider-empty">No providers yet. Add one to choose an endpoint and its models.</div>';
			return;
		}
		list.innerHTML = providers.map((p, i) => `
			<div class="provider-row${p.id === settings.activeProviderId ? ' active' : ''}" data-idx="${i}">
				<label class="provider-active" title="Use this provider">
					<input type="radio" name="activeProvider" ${p.id === settings.activeProviderId ? 'checked' : ''} ${p.enabled === false ? 'disabled' : ''} data-act="activate" data-idx="${i}">
				</label>
				<div class="provider-info">
					<div class="provider-name">${escapeHtml(p.name || 'Provider')}${p.enabled === false ? ' <span class="provider-off">disabled</span>' : ''}</div>
					<div class="provider-detail">${escapeHtml(p.baseUrl || 'https://api.anthropic.com')} · ${(p.models || []).length} model${(p.models || []).length === 1 ? '' : 's'}${p.wire === 'openai' ? ' · <span class="provider-wire-warn" title="CodeMind sends conversations in the Anthropic format. This endpoint speaks the OpenAI format, so it cannot serve a chat yet.">OpenAI protocol — chat not supported</span>' : ''}</div>
				</div>
				<div class="provider-actions">
					<button class="icon-btn" data-act="toggle" data-idx="${i}" title="${p.enabled === false ? 'Enable' : 'Disable'}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p.enabled === false ? '<path d="M5 12h14"/>' : '<path d="M20 6L9 17l-5-5"/>'}</svg></button>
					<button class="icon-btn" data-act="edit" data-idx="${i}" title="Edit"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
					<button class="icon-btn" data-act="remove" data-idx="${i}" title="Remove"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
				</div>
			</div>
		`).join('');

		list.querySelectorAll('[data-act="activate"]').forEach(el => el.addEventListener('change', e => {
			const p = currentProviders()[Number(e.currentTarget.dataset.idx)];
			if (p) { vscode.postMessage({ type: 'setActiveProvider', payload: { providerId: p.id } }); }
		}));
		list.querySelectorAll('[data-act="toggle"]').forEach(btn => btn.addEventListener('click', e => {
			const idx = Number(e.currentTarget.dataset.idx);
			pushProviders(currentProviders().map((p, i) => i === idx ? { ...p, enabled: p.enabled === false } : p));
		}));
		list.querySelectorAll('[data-act="edit"]').forEach(btn => btn.addEventListener('click', e => {
			const p = currentProviders()[Number(e.currentTarget.dataset.idx)];
			if (p) { openProviderForm(p); }
		}));
		list.querySelectorAll('[data-act="remove"]').forEach(btn => btn.addEventListener('click', e => {
			const p = currentProviders()[Number(e.currentTarget.dataset.idx)];
			if (!p) { return; }
			if (p.id === providerDraft.editingId) { closeProviderForm(); }
			vscode.postMessage({ type: 'deleteProviderKey', payload: { providerId: p.id } });
			pushProviders(currentProviders().filter(x => x.id !== p.id));
		}));
	}

	function openProviderForm(provider) {
		const form = document.getElementById('providerForm');
		if (!form) { return; }
		form.classList.remove('hidden');
		providerDraft = {
			editingId: provider ? provider.id : null,
			models: provider && Array.isArray(provider.models) ? provider.models.slice() : [],
		};
		form.querySelector('#providerName').value = provider ? (provider.name || '') : '';
		form.querySelector('#providerBaseUrl').value = provider ? (provider.baseUrl || '') : '';
		form.querySelector('#providerApiKey').value = '';
		setProviderKeyHint(provider ? 'Leave blank to keep the saved key, or type a new one.' : 'Stored securely once you save the provider.');
		// Abandon any in-flight probe from a previous open: its reply must not fill in
		// the form that is being opened now.
		providerFetchToken++;
		setProviderFetchBusy(false);
		setProviderFetchHint('Ask the endpoint what it serves — every model it lists is imported.');
		renderModelChecks();
	}

	function closeProviderForm() {
		const form = document.getElementById('providerForm');
		if (form) { form.classList.add('hidden'); }
		providerFetchToken++;
		setProviderFetchBusy(false);
		providerDraft = { editingId: null, models: [] };
	}

	function saveProvider(body) {
		const name = (body.querySelector('#providerName').value || '').trim() || 'Provider';
		const baseUrl = (body.querySelector('#providerBaseUrl').value || '').trim().replace(/\/+$/, '');
		const key = (body.querySelector('#providerApiKey').value || '').trim();
		const providers = currentProviders();
		let id = providerDraft.editingId;
		let next;
		// The detected wire is persisted so it survives a reload: re-detecting costs two
		// network round-trips, and the composer needs to know whether this endpoint can
		// actually serve a turn. Only written when detection ran — editing a provider
		// without re-fetching keeps whatever was stored before.
		const detected = providerDraft.wire ? { wire: providerDraft.wire } : {};
		if (id) {
			next = providers.map(p => p.id === id ? { ...p, name, baseUrl, models: providerDraft.models.slice(), ...detected } : p);
		} else {
			id = 'p-' + Math.abs(hashString(name + baseUrl + providerDraft.models.join(','))).toString(36) + '-' + providers.length;
			next = providers.concat({ id, name, baseUrl, models: providerDraft.models.slice(), enabled: true, ...detected });
		}
		if (key) { vscode.postMessage({ type: 'setProviderKey', payload: { providerId: id, key } }); }
		pushProviders(next);
		closeProviderForm();
	}

	/** A tiny non-crypto hash so a new provider gets a stable-ish id without Date/random. */
	function hashString(s) {
		let h = 0;
		for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
		return h;
	}

	/**
	 * Draw the provider's imported models. Every model a provider knows is kept —
	 * fetching auto-imports the whole list, and manual adds append — so this is a
	 * plain removable list, not a tick-to-keep one. Which of them reach the composer
	 * is a separate choice, made under "Models in the picker".
	 */
	function renderModelChecks(fetched) {
		const host = document.getElementById('providerModelChecks');
		if (!host) { return; }
		// Fetching imports everything: merge any freshly fetched ids into the draft so
		// the list below is exactly what the provider will store.
		for (const m of (fetched || [])) {
			const v = m && m.value;
			if (v && !providerDraft.models.includes(v)) { providerDraft.models.push(v); }
		}
		const ids = providerDraft.models.slice();
		if (!ids.length) {
			host.innerHTML = '<div class="provider-models-empty">No models yet — use “Fetch models” to import them from the endpoint, or add a model id by hand below.</div>';
			return;
		}
		host.innerHTML = ids.map((v, i) => `
			<div class="provider-model-item">
				<span>${escapeHtml(v)}</span>
				<button class="icon-btn provider-model-remove" data-del="${i}" title="Remove" aria-label="Remove ${escapeHtml(v)}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
			</div>
		`).join('');
		host.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', e => {
			const idx = Number(e.currentTarget.dataset.del);
			providerDraft.models = providerDraft.models.filter((_, i) => i !== idx);
			renderModelChecks();
		}));
	}

	/** Handle a providerModels reply from the workbench (Fetch models button). */
	function applyProviderModels(payload) {
		const data = payload || {};
		setProviderFetchBusy(false);
		if (data.error) {
			setProviderFetchHint(`Could not list models: ${data.error}`, 'error');
			return;
		}
		const models = Array.isArray(data.models) ? data.models : [];

		// A fetch replaces the list rather than adding to it — see handleProviderDetection.
		providerDraft.models = [];

		setProviderFetchHint(models.length
			? `Imported ${models.length} model${models.length === 1 ? '' : 's'} from ${data.endpoint || 'the endpoint'}. Curate the composer's list under "Models in the picker".`
			: `${data.endpoint || 'The endpoint'} listed no Anthropic-compatible models.`,
			models.length ? 'ok' : 'warn');

		// Replace the model list completely (not append)
		renderModelChecks(models);
	}

	/**
	 * The "Models in the picker" curation is a button that opens a sheet, not an inline
	 * list — the settings form should not grow a row per model across every provider.
	 * This keeps the button's summary line honest: how many models are chosen, or that
	 * the picker is falling back to the active provider.
	 */
	function renderPickerModelsSummary() {
		const summary = document.getElementById('pickerModelsSummary');
		if (!summary) { return; }
		const enabled = new Set((Array.isArray(settings.providers) ? settings.providers : [])
			.filter(p => p.enabled !== false).map(p => p.id));
		// Only count picks whose provider still exists and is enabled, so a stale entry
		// never inflates the number the user is shown.
		const live = (Array.isArray(settings.pickerModels) ? settings.pickerModels : [])
			.filter(e => e && e.providerId && e.model && enabled.has(e.providerId));
		summary.textContent = live.length
			? `${live.length} model${live.length === 1 ? '' : 's'} chosen for the composer picker.`
			: "None chosen — the composer falls back to the active provider's models.";
	}

	/**
	 * Choose which models the composer picker offers, across every enabled provider, in
	 * a sheet so the settings form stays short. Each provider's imported models are
	 * listed with a checkbox and the provider's name as the group heading; on Done the
	 * ticked set is written to `codemind.pickerModels` (`{providerId, model}` pairs, so
	 * the same model id served by two providers is two independent choices). An empty
	 * selection is valid and means "fall back to the active provider's models".
	 */
	function showPickerModelsSheet() {
		const providers = (Array.isArray(settings.providers) ? settings.providers : []).filter(p => p.enabled !== false);
		const groups = providers.filter(p => Array.isArray(p.models) && p.models.length);
		if (!groups.length) {
			showSheet({
				title: 'Models in the picker',
				className: 'picker-models-sheet',
				body: '<p class="setting-hint">No models imported yet. Add a provider and fetch its models first.</p>',
				confirmLabel: 'Done',
				onConfirm: () => true,
			});
			return;
		}
		const selected = new Set((Array.isArray(settings.pickerModels) ? settings.pickerModels : []).map(e => `${e.providerId} ${e.model}`));
		const body = `
			<div class="picker-models-sheet-list">
				${groups.map(p => `
					<div class="picker-model-group">
						<div class="picker-model-provider">${escapeHtml(p.name || 'Provider')}</div>
						${p.models.map(m => `
							<label class="picker-model-check">
								<input type="checkbox" data-provider="${escapeHtml(p.id)}" data-model="${escapeHtml(m)}" ${selected.has(`${p.id} ${m}`) ? 'checked' : ''}>
								<span class="picker-model-check-name">${escapeHtml(labelForModel(m))}</span>
							</label>
						`).join('')}
					</div>
				`).join('')}
			</div>`;
		showSheet({
			title: 'Models in the picker',
			className: 'picker-models-sheet',
			body,
			confirmLabel: 'Done',
			onConfirm(overlay) {
				const picked = Array.from(overlay.querySelectorAll('input[type="checkbox"]:checked'))
					.map(box => ({ providerId: box.dataset.provider, model: box.dataset.model }));
				pushSettingChange({ pickerModels: picked });
				return true;
			},
		});
	}

	function setProviderKeyHint(text) {
		const el = document.getElementById('providerKeyHint');
		if (el) { el.textContent = text; }
	}
	/**
	 * The one status line under "Fetch models". `tone` colours it so a failure reads
	 * as a failure at a glance: 'busy' | 'ok' | 'warn' | 'error', or omitted for the
	 * neutral resting text.
	 */
	function setProviderFetchHint(text, tone) {
		const el = document.getElementById('providerFetchHint');
		if (!el) { return; }
		el.textContent = text;
		el.classList.remove('is-busy', 'is-ok', 'is-warn', 'is-error');
		if (tone) { el.classList.add(`is-${tone}`); }
		// Failures are announced: the message names what to fix, and a sighted user
		// sees the colour change that a screen-reader user otherwise would not get.
		el.setAttribute('aria-live', tone === 'error' || tone === 'warn' ? 'assertive' : 'polite');
	}

	/**
	 * Disable the fetch/validate pair while a probe is in flight, so a second click
	 * cannot start a race whose reply overwrites the first one's models.
	 */
	function setProviderFetchBusy(busy) {
		const fetchBtn = document.getElementById('providerFetch');
		const validateBtn = document.getElementById('providerValidate');
		for (const btn of [fetchBtn, validateBtn]) {
			if (!btn) { continue; }
			btn.disabled = !!busy;
			btn.classList.toggle('is-busy', !!busy);
		}
		if (fetchBtn) { fetchBtn.textContent = busy ? 'Fetching…' : 'Fetch models'; }
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
	/** Legacy single-endpoint model hint. The provider UI uses its own hints now; this
	 *  stays only so the dormant applyEndpointModels path has something to call. */
	function setModelHint(text) {
		const hint = document.getElementById('settingsModelHint');
		if (hint) { hint.textContent = text; }
	}

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
			// The endpoint now lives per-provider, not in this form. Carry the workbench's
			// current values (baseUrl/model/providers/activeProviderId) through unchanged so
			// a settingsUpdate from this form never clobbers provider state.
			baseUrl: settings.baseUrl,
			model: settings.model,
			providers: settings.providers,
			activeProviderId: settings.activeProviderId,
			// The picker curation is written through its own change handler; carry it
			// through unchanged so a plain form save never clobbers it.
			pickerModels: settings.pickerModels,
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
		// The providers list is in every version of this form, so it is what "the settings
		// form is on screen" is asked about.
		if (!body || !body.querySelector('#providerList')) { return; }

		// Repaint the providers list (active/enabled state may have changed elsewhere).
		renderProviderList();
		renderPickerModelsSummary();
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
		const options = modelOptions();
		showPicker({
			title: 'Model for new turns',
			// Name the provider alongside the model in the fallback sheet too, so it reads
			// the same as the composer's inline menu.
			options: options.map(o => ({ value: o.value, label: o.providerName ? `${o.label} — ${o.providerName}` : o.label })),
			current: settings.model || '',
			onPick: (value) => {
				const chosen = options.find(o => o.value === value);
				selectModel(value, chosen && chosen.providerId);
			},
		});
	}

	/**
	 * Set the active model from outside this file. The composer's pill owns model
	 * selection now (Section 2.2). When the choice carries a provider — every composer
	 * option does — it goes through `selectPickerModel` so the endpoint, key and model
	 * switch together; without one it is a plain model write, the pre-provider path.
	 */
	function selectModel(value, providerId) {
		if (providerId) {
			settings = { ...settings, model: value, activeProviderId: providerId };
			vscode.postMessage({ type: 'selectPickerModel', payload: { providerId, model: value } });
			if (activePanel === 'settings') { applySettings(settings); }
			return;
		}
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
		openPanel, closePanel, renderPanelData, applySettings, applyEndpointModels, applyProviderModels, handleProviderDetection, renderMcp, showCommitReview, showSheet,
		showPicker, showModelPicker, showEffortPicker, toggleFastMode,
		// The composer's model pill renders this list itself and writes back through
		// selectModel, so both are part of the surface now.
		modelOptions, selectModel,
		// The Chat History panel's rows arrive from the workbench via agent.js.
		renderHistory,
		getActivePanel: () => activePanel,
	};
})();

