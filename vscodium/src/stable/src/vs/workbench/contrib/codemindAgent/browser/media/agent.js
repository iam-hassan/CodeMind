// CodeMind Agent Webview Controller
// Streaming chat UI backed by the Claude Code engine.

const vscode = acquireVsCodeApi();

// ---------- State ----------
let messages = [];
let status = 'ready';
let isBusy = false;
let streamingMessageId = null;

// Per-stream scratch keyed by message id, kept outside `messages` so re-renders
// don't wipe tool input/result that arrive as separate upserts.
const streamScratch = new Map(); // id -> { thinking, tools: Map, model, meta }

// Long tool output is drawn clipped, with the whole of it a click away: `clipStash`
// holds the full text by content key, `expandedClips` the keys the reader has opened.
// Keying by content is what lets an expansion survive the re-render that every stream
// delta triggers.
const clipStash = new Map(); // clip key -> full text
const expandedClips = new Set(); // clip keys the reader expanded

// Section 4.3: a tool card and a reasoning block rest closed and open only when the
// reader opens them. The transcript is rebuilt on every delta, so the `open` attribute
// is written from these sets rather than read back from the DOM — otherwise a card
// would fold itself away one token after being opened.
const expandedTools = new Set(); // tool ids the reader expanded
const expandedThinking = new Set(); // message ids whose reasoning the reader expanded
// Which tool cards have been drawn at least once. A card that opens itself (a question, a
// todo list) seeds `expandedTools` the first time it appears and is governed by that set
// afterwards, so closing one stays closed instead of springing back open on the next tick.
const seenTools = new Set();

// B.4 – Dev mode toggle state. The trace itself is rendered by the separate Orchestration
// Trace window (media/trace.js); this flag only drives the 🐛 header toggle and its banner.
let devModeEnabled = false;

/**
 * Section 6.1: which message ids have not yet played their entry animation. Only ids that
 * arrived in this session go in — a transcript restored from history is drawn as something
 * that was already there, not as thirty bubbles flying in at once.
 *
 * An id is taken out by the render that first draws it with the class, so a structural
 * redraw mid-turn cannot restart the fade. That trades a full 180ms on a bubble that is
 * immediately redrawn for never showing the same bubble fading in twice.
 */
const enterQueue = new Set();

/**
 * Which element is currently drawing which message (Section 5). A stream delta is
 * written straight into the text node recorded here, so the transcript is not rebuilt
 * once per token: `appendData` extends a node the browser has already laid out, where
 * re-parsing the markdown would throw that layout away and build it again.
 * Rebuilt after every full render; entries whose element has left the document are
 * ignored and the caller falls back to a full render.
 */
const domIndex = new Map(); // message id -> { el, blocksEl, tailNode, thinkingNode }

/**
 * Schemes a rendered link is allowed to carry. Model output is untrusted text, so
 * anything that could execute — `javascript:`, `data:`, `vscode:` — never becomes an
 * anchor and stays visible as the literal markdown it was.
 */
const SAFE_LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i;

// ---------- Closing animations (Section 6) ----------
/**
 * How long to wait for a close animation that never reports finishing. Reached when the
 * element has no `.is-closing` rule at all, or when the frame the animation would have
 * started on never came because the panel was hidden — either way what is closing must
 * still close.
 */
const CLOSE_FALLBACK_MS = 400;

/**
 * Play something out and hide it afterwards. `.hidden` is `display: none`, which no
 * animation can run from, so an element that is being dismissed keeps its box until
 * `.is-closing` has finished — the class is both the animation and the wait for it.
 *
 * `hide` is what actually takes the element out: adding `.hidden`, or removing the node.
 * It runs once, whichever of the animation and the fallback gets there first — and not at
 * all if the element was reopened in the meantime, which is what taking `.is-closing` back
 * off means.
 */
function playOut(el, hide) {
	if (!el || el.classList.contains('is-closing')) { return; }
	el.classList.add('is-closing');
	let timer = 0;
	let done = false;
	const finish = () => {
		if (done) { return; }
		done = true;
		clearTimeout(timer);
		el.removeEventListener('animationend', onEnd);
		// Reopened while the exit was playing: whoever reopened it dropped the class, and
		// hiding now would hide something that is deliberately on screen.
		if (!el.classList.contains('is-closing')) { return; }
		el.classList.remove('is-closing');
		hide();
	};
	// Both layers of a dialog animate — the backdrop on a pseudo-element of the overlay and
	// the dialog itself inside it — so the first of the two to end is the one that counts.
	const onEnd = (ev) => { if (ev.target === el || el.contains(ev.target)) { finish(); } };
	el.addEventListener('animationend', onEnd);
	timer = setTimeout(finish, CLOSE_FALLBACK_MS);
}

// ---------- DOM ----------
const messagesEl = document.getElementById('messages');
const chatScrollEl = document.getElementById('chatScroll');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const sendSlot = document.getElementById('sendSlot');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
// The composer's own controls (Section 2): the model is named on the pill and nowhere
// else, and the mode a turn runs in is chosen next to it.
const modelPill = document.getElementById('modelPill');
const modelMenu = document.getElementById('modelMenu');
const modePill = document.getElementById('modePill');
const modeMenu = document.getElementById('modeMenu');
const newSessionBtn = document.getElementById('newSessionBtn');
const apiKeyModal = document.getElementById('apiKeyModal');
const apiKeyInput = document.getElementById('apiKeyInput');
const apiKeySave = document.getElementById('apiKeySave');
const apiKeyCancel = document.getElementById('apiKeyCancel');
const permissionModal = document.getElementById('permissionModal');
const permTitle = document.getElementById('permTitle');
const permIntro = document.getElementById('permIntro');
const permToolName = document.getElementById('permToolName');
const permInput = document.getElementById('permInput');
const permReason = document.getElementById('permReason');
const permScopes = document.getElementById('permScopes');
const permFeedbackGroup = document.getElementById('permFeedbackGroup');
const permFeedback = document.getElementById('permFeedback');
const permAllow = document.getElementById('permAllow');
const permAllowSession = document.getElementById('permAllowSession');
const permDeny = document.getElementById('permDeny');
const attachBtn = document.getElementById('attachBtn');
const mentionBtn = document.getElementById('mentionBtn');
const filePicker = document.getElementById('filePicker');
const attachmentsHost = document.getElementById('attachments');
const vimIndicator = document.getElementById('vimIndicator');
const composerHint = document.getElementById('composerHint');
const slashMenu = document.getElementById('slashMenu');
const mentionMenu = document.getElementById('mentionMenu');
const sessionTokensEl = document.getElementById('sessionTokens');
const settingsBtn = document.getElementById('settingsBtn');
const historyBtn = document.getElementById('historyBtn');
let devModeBtn = document.getElementById('devModeBtn');
const micBtn = document.getElementById('micBtn');
const sessionNameEl = document.getElementById('sessionName');
const sessionTagsEl = document.getElementById('sessionTags');
const slashHintEl = document.getElementById('slashHint');
const inputModeEl = document.getElementById('inputMode');
const promptQueueEl = document.getElementById('promptQueue');
const contextMeterEl = document.getElementById('contextMeter');
const contextBarFillEl = document.getElementById('contextBarFill');
const contextTextEl = document.getElementById('contextText');
const bgTasksEl = document.getElementById('bgTasks');
const bgPillEl = document.getElementById('bgPill');
const bgPillTextEl = document.getElementById('bgPillText');

// ---------- Icons ----------
const LOGO_MARK_SVG = `<svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;
const USER_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
const AGENT_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;
const ERROR_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const SYSTEM_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
const TERMINAL_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

const HINTS = [
	{ label: 'Explain the codebase', hint: 'Explain the structure of this codebase and its main components' },
	{ label: 'Find and fix bugs', hint: 'Find and fix any bugs in the current file' },
	{ label: 'Refactor code', hint: 'Refactor the selected code to be cleaner and more readable' },

];

function init() {
	inputEl.addEventListener('keydown', handleKeydown);
	inputEl.addEventListener('input', handleInput);
	// The workbench shadows its own Ctrl/Alt globals while the composer has focus,
	// because the webview host re-dispatches every keydown into the keybinding
	// service whether or not this frame consumed it.
	inputEl.addEventListener('focus', () => vscode.postMessage({ type: 'composerFocus', payload: { focused: true } }));
	inputEl.addEventListener('blur', () => vscode.postMessage({ type: 'composerFocus', payload: { focused: false } }));
	// Clicking away must dismiss the autocompletes; the delay lets a click on a
	// menu row land before the menu is torn down.
	inputEl.addEventListener('blur', () => setTimeout(() => { closeSlashMenu(); closeMentionMenu(); }, 120));
	// A search that has lost the keyboard cannot be typed into, so it keeps what it
	// found rather than leaving its prompt under an unfocused composer.
	inputEl.addEventListener('blur', () => endHistorySearch(true));
	sendBtn.addEventListener('click', sendMessage);
	newSessionBtn.addEventListener('click', newSession);
	apiKeySave.addEventListener('click', saveApiKey);
	apiKeyCancel.addEventListener('click', () => showModal(false));
	apiKeyModal.addEventListener('click', (e) => {
		if (e.target === apiKeyModal) showModal(false);
	});
	permAllow.addEventListener('click', () => respondToPermission('allow_once'));
	if (permAllowSession) { permAllowSession.addEventListener('click', () => respondToPermission('allow_session')); }
	permDeny.addEventListener('click', () => respondToPermission('deny'));
	if (permFeedback) {
		permFeedback.addEventListener('keydown', (e) => {
			// Enter submits the denial with whatever guidance has been typed, which is
			// the only reason the box is there — it is never an "allow with a note".
			if (e.key === 'Enter') { e.preventDefault(); respondToPermission('deny'); }
			// Escape clears the box first so it cannot silently deny with stale text.
			// Propagation stops there too, or the document handler below would deny
			// on the very keystroke meant to undo the typing.
			if (e.key === 'Escape' && permFeedback.value) {
				e.preventDefault();
				e.stopPropagation();
				permFeedback.value = '';
			}
		});
	}
	permissionModal.addEventListener('click', (e) => {
		if (e.target === permissionModal) respondToPermission('deny');
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !permissionModal.classList.contains('hidden')) {
			respondToPermission('deny');
		}
	});
	apiKeyInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); saveApiKey(); }
		if (e.key === 'Escape') { e.preventDefault(); showModal(false); }
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !apiKeyModal.classList.contains('hidden')) {
			showModal(false);
		}
	});

	window.addEventListener('message', handleExtensionMessage);

	wireAttachments();
	wirePanelChrome();
	wireComposerControls();
	wireGlobalShortcuts();
	wireScrollAnchor();

	renderEmptyState();
	setStatus('ready');
	updateInputHeight();

	vscode.postMessage({ type: 'ready' });
}

// ---------- Attachments wiring (Step 8) ----------
function wireAttachments() {
	if (attachBtn && filePicker) {
		attachBtn.addEventListener('click', () => filePicker.click());
		filePicker.addEventListener('change', (e) => {
			const files = Array.from(e.target.files || []);
			for (const f of files) {
				const reader = new FileReader();
				reader.onload = () => attachDataUrl(f.name, String(reader.result));
				reader.readAsDataURL(f);
			}
			e.target.value = '';
		});
	}
	inputEl.addEventListener('paste', handlePaste);
}

// Pasting an image from the clipboard attaches it inline (Section 3.4).
function handlePaste(e) {
	const items = (e.clipboardData && e.clipboardData.items) || [];
	for (const item of items) {
		if (item.type && item.type.startsWith('image/')) {
			const blob = item.getAsFile();
			if (!blob) { continue; }
			const reader = new FileReader();
			const ext = item.type.split('/')[1] || 'png';
			reader.onload = () => attachDataUrl(`pasted-image.${ext}`, String(reader.result));
			reader.readAsDataURL(blob);
			e.preventDefault();
		}
	}
}

// ---------- Panel chrome ----------
function wirePanelChrome() {
	if (settingsBtn) {
		settingsBtn.addEventListener('click', () => {
			if (window.CodeMindPanels) { window.CodeMindPanels.openPanel('settings'); }
		});
	}
	if (historyBtn) {
		historyBtn.addEventListener('click', () => {
			if (window.CodeMindPanels) { window.CodeMindPanels.openPanel('history'); }
		});
	}
	if (micBtn) {
		micBtn.addEventListener('click', toggleVoiceInput);
	}

	// B.4 – Dev mode toggle button (bug icon).
	// The button used to live inside the lazily-created, initially-hidden modal
	// panel host (panels.js), so at module-load getElementById returned null and
	// the click handler was never wired — dev mode could never be turned on and
	// no trace card ever rendered. Mount it in the always-present header instead.
	if (!devModeBtn) {
		const headerActions = document.querySelector('.header-actions');
		if (headerActions) {
			const btn = document.createElement('button');
			btn.className = 'icon-btn';
			btn.id = 'devModeBtn';
			btn.setAttribute('aria-label', 'Toggle dev mode');
			btn.title = 'Dev mode (orchestration traces)';
			btn.textContent = '🐛';
			headerActions.insertBefore(btn, headerActions.firstChild);
			devModeBtn = btn;
		}
	}

	if (devModeBtn) {
		const saved = window.localStorage?.getItem('codemind.devMode');
		if (saved === 'true') {
			devModeEnabled = true;
			devModeBtn.style.color = 'var(--vscode-editorWarning-foreground)';
			showDevModeBanner();
			// A window reload restores our UI state from localStorage, but the worker
			// starts fresh with dev mode off. Without re-syncing it, the banner would
			// claim traces are active while the worker emits none — a silent no-card trap.
			vscode.postMessage({ type: 'set_dev_mode', enabled: true });
		}

		devModeBtn.addEventListener('click', () => {
			devModeEnabled = !devModeEnabled;
			devModeBtn.style.color = devModeEnabled
				? 'var(--vscode-editorWarning-foreground)'
				: 'var(--vscode-descriptionForeground)';

			vscode.postMessage({ type: 'set_dev_mode', enabled: devModeEnabled });
			window.localStorage?.setItem('codemind.devMode', String(devModeEnabled));

			showToast(devModeEnabled
				? 'Dev mode on — orchestration traces active'
				: 'Dev mode off');

			if (devModeEnabled) showDevModeBanner();
			else hideDevModeBanner();
		});
	}
}

function showDevModeBanner() {
	if (document.getElementById('devModeBanner')) return;
	const banner = document.createElement('div');
	banner.id = 'devModeBanner';
	banner.style.cssText = 'background:var(--vscode-editorWarning-background);opacity:0.2;border-left:3px solid var(--vscode-editorWarning-foreground);padding:6px 12px;font-size:10px;display:flex;align-items:center;justify-content:space-between;';
	banner.innerHTML = `
		<span>⚠ Dev mode active — traces are logged</span>
		<button id="devModeDismiss" style="background:none;border:none;color:var(--vscode-editorWarning-foreground);cursor:pointer;font-size:12px;">×</button>
	`;
	document.body.prepend(banner);
	document.getElementById('devModeDismiss')?.addEventListener('click', () => {
		devModeEnabled = false;
		devModeBtn.style.color = 'var(--vscode-descriptionForeground)';
		vscode.postMessage({ type: 'set_dev_mode', enabled: false });
		window.localStorage?.setItem('codemind.devMode', 'false');
		banner.remove();
	});
}

function hideDevModeBanner() {
	document.getElementById('devModeBanner')?.remove();
}

function showToast(text) {
	const t = document.createElement('div');
	t.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-input-border);padding:4px 12px;border-radius:4px;font-size:11px;opacity:0.95;z-index:10000;';
	t.textContent = text;
	document.body.appendChild(t);
	setTimeout(() => t.remove(), 2000);
}

// ---------- Composer controls (Section 2) ----------
/**
 * The strip's own controls: the model pill and its inline menu, the mode pill and its own,
 * the @ button, and the stop that shares a slot with send. Every one of them drives the
 * path its old location drove — the controls moved, the behaviour did not.
 */
function wireComposerControls() {
	if (modelPill) {
		// The click must not reach the document handler below, which would read it as a
		// click-outside and close the menu the same tick it opened.
		modelPill.addEventListener('click', (e) => { e.stopPropagation(); toggleModelMenu(); });
	}
	if (mentionBtn) {
		mentionBtn.addEventListener('click', insertMention);
	}
	if (stopBtn) {
		stopBtn.addEventListener('click', cancelStream);
	}
	if (modePill) {
		modePill.addEventListener('click', (e) => { e.stopPropagation(); toggleModeMenu(); });
		applyModeSelection(currentMode);
	}
	const consensusCheckbox = document.getElementById('consensusPillCheckbox');
	if (consensusCheckbox) {
		consensusCheckbox.addEventListener('change', () => {
			// The switch is a real toggle bound to the Multi-Agent Consensus window:
			// ON opens (and stays lit), OFF closes it. Once a run is in flight the pane
			// locks the switch (disabled), so this handler only ever fires before a run
			// starts or after it ends.
			if (consensusRunning) {
				// Locked: revert any stray change and do nothing.
				paintConsensusPill();
				return;
			}
			if (consensusCheckbox.checked) {
				consensusOpen = true;
				vscode.postMessage({ type: 'openConsensus' });
			} else {
				consensusOpen = false;
				vscode.postMessage({ type: 'closeConsensus' });
			}
			// Paint optimistically; the pane's consensusState echo confirms or corrects it.
			paintConsensusPill();
		});
	}
	// Clicking anywhere else closes either composer menu without changing anything (Section 2.2).
	document.addEventListener('click', (e) => {
		if (modelMenuOpen && modelMenu && !modelMenu.contains(e.target)) { closeModelMenu(); }
		if (modeMenuOpen && modeMenu && !modeMenu.contains(e.target)) { closeModeMenu(); }
	});
	// Escape closes them too, and claims the key so it does not also stop a running turn.
	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') { return; }
		if (modelMenuOpen) { closeModelMenu(); e.preventDefault(); }
		if (modeMenuOpen) { closeModeMenu(); e.preventDefault(); }
	});
}

/**
 * The @ button types the `@` for you (Section 2.5): the mention menu then opens through
 * the same path typing it by hand opens, so the behaviour is unchanged.
 */
function insertMention() {
	inputEl.focus();
	const start = inputEl.selectionStart ?? inputEl.value.length;
	const end = inputEl.selectionEnd ?? start;
	const before = inputEl.value.slice(0, start);
	// `updateMentionMenu` only matches an `@` that starts a word, so give it the space
	// it needs when the caret is sitting against other text.
	const insert = before && !/\s$/.test(before) ? ' @' : '@';
	inputEl.value = before + insert + inputEl.value.slice(end);
	const caret = start + insert.length;
	inputEl.setSelectionRange(caret, caret);
	handleInput();
}

// ---------- Model pill (Section 2.2) ----------
/**
 * How a model id reads on the pill. The table is the spec's own; anything missing from
 * it — an alias, or a custom endpoint's own name — loses the vendor prefix and keeps
 * whatever shape it came with, because a name we have never seen is not ours to rewrite.
 *
 * `claude-sonnet-5` and `claude-fable-5` are not in the spec's table but do ship in the
 * model list, so they follow the same pattern the listed ids follow rather than reading
 * as a hyphenated id beside them.
 */
const MODEL_SHORT_NAMES = {
	'claude-opus-5': 'Opus 5',
	'claude-opus-4-8': 'Opus 4.8',
	'claude-opus-4-8-thinking': 'Opus 4.8 T',
	'claude-opus-4-6': 'Opus 4.6',
	'claude-sonnet-5': 'Sonnet 5',
	'claude-sonnet-4-6': 'Sonnet 4.6',
	'claude-haiku-4-5': 'Haiku 4.5',
	'claude-fable-5': 'Fable 5',
};

/** The model the next turn will use, as the workbench last reported it. */
let currentModel = '';

function modelDisplayName(model) {
	const id = String(model || '').trim();
	if (!id) { return 'Model'; }
	if (MODEL_SHORT_NAMES[id]) { return MODEL_SHORT_NAMES[id]; }
	const bare = id.replace(/^claude-/, '');
	return bare.charAt(0).toUpperCase() + bare.slice(1);
}

let modelMenuOpen = false;

function toggleModelMenu() {
	if (modelMenuOpen) { closeModelMenu(); } else { openModelMenu(); }
}

function openModelMenu() {
	// A webview without the menu element is not a dead end — the sheet still exists.
	if (!modelMenu) {
		const panels = window.CodeMindPanels;
		if (panels && panels.showModelPicker) { panels.showModelPicker(); }
		return;
	}
	// Reopening during the close cancels it: the class goes, and the pending hide sees an
	// open menu and leaves it alone.
	modelMenu.classList.remove('is-closing');
	modelMenu.classList.remove('hidden');
	renderModelMenu();
	if (modelPill) { modelPill.setAttribute('aria-expanded', 'true'); }
	modelMenuOpen = true;
	// Focus follows the menu: with the filter box carrying focus, typing narrows the
	// list at once and the arrow keys walk it — no second click needed.
	const search = modelMenu.querySelector('.model-menu-search');
	if (search) { search.focus(); }
}

function closeModelMenu() {
	if (!modelMenu) { return; }
	// Closed already: no animation to play, and nothing that needs waiting for.
	if (modelMenu.classList.contains('hidden')) { modelMenuOpen = false; return; }
	modelMenuOpen = false;
	if (modelPill) { modelPill.setAttribute('aria-expanded', 'false'); }
	// Section 6.6: the menu drops the four pixels back and only then leaves the layout.
	playOut(modelMenu, () => modelMenu.classList.add('hidden'));
}

/**
 * Build the menu from the list every other picker offers, so the models a custom
 * endpoint reported are here too and the configured one can always be found again.
 */
/** The unfiltered option list behind the open composer model menu, cached so
 *  each keystroke filters the full set rather than the previous keystroke's subset. */
let modelMenuFullOptions = [];

function renderModelMenu() {
	const panels = window.CodeMindPanels;
	modelMenuFullOptions = (panels && panels.modelOptions) ? panels.modelOptions() : [];
	// A gateway can serve dozens of models; typing narrows them without leaving the
	// keyboard. The box is part of the menu markup so it survives row redraws; its
	// value is reset here, since reopening the menu should start fresh.
	let searchWrap = modelMenu.querySelector('.model-menu-search-wrap');
	if (!searchWrap) {
		searchWrap = document.createElement('div');
		searchWrap.className = 'model-menu-search-wrap';
		searchWrap.innerHTML = `<input type="text" class="model-menu-search" placeholder="Filter models…" autocomplete="off" spellcheck="false" aria-label="Filter models">`;
		modelMenu.appendChild(searchWrap);
		const searchInput = searchWrap.querySelector('input');
		searchInput.addEventListener('input', (e) => {
			renderModelMenuRows(e.currentTarget.value || '');
		});
		// Arrow/Enter navigation while typing: the rows are real DOM siblings, so the
		// selection is just the row carrying `aria-selected` — the same attribute the
		// check mark already reads.
		searchInput.addEventListener('keydown', (e) => {
			const rows = Array.from(modelMenu.querySelectorAll('.model-menu-item'));
			if (!rows.length) { return; }
			let idx = rows.findIndex(r => r.getAttribute('aria-selected') === 'true');
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				e.stopPropagation();
				rows.forEach(r => r.setAttribute('aria-selected', 'false'));
				// No selection yet: Down enters at the top, Up at the bottom.
				idx = e.key === 'ArrowDown'
					? (idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1))
					: (idx < 0 ? rows.length - 1 : Math.max(0, idx - 1));
				rows[idx].setAttribute('aria-selected', 'true');
				// scrollTop only — scrollIntoView would be free to move the transcript
				// behind the menu as well (Section 2.2's own note).
				modelMenu.scrollTop = Math.max(0, rows[idx].offsetTop - modelMenu.clientHeight / 2);
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				const picked = rows[Math.max(0, idx)];
				if (picked) { chooseModel(picked.dataset.value, picked.dataset.provider); }
			}
		});
	}
	searchWrap.querySelector('input').value = '';
	renderModelMenuRows('');
}

/**
 * Paint the menu's rows, filtered through `query` when one is typed. Kept separate
 * from the menu chrome so typing redraws rows without touching — or losing focus
 * from — the search box above them.
 */
function renderModelMenuRows(query) {
	const q = (query || '').trim();
	const options = q
		? fuzzySort(modelMenuFullOptions, q, o => `${o.label} ${o.value} ${o.providerName || ''}`)
		: modelMenuFullOptions;
	// Rows are appended after the search wrap and stale ones removed first, so an
	// empty match leaves a "no models" line rather than a blank box.
	Array.from(modelMenu.querySelectorAll('.model-menu-item, .model-menu-empty')).forEach(el => el.remove());
	if (!options.length) {
		modelMenu.insertAdjacentHTML('beforeend', '<div class="model-menu-empty">No models match.</div>');
		return;
	}
	const rowsHtml = options.map(o => `
		<div class="model-menu-item" role="option" data-value="${escapeAttr(o.value)}" data-provider="${escapeAttr(o.providerId || '')}" aria-selected="${o.value === currentModel ? 'true' : 'false'}" title="${escapeAttr((o.providerName ? o.providerName + ' — ' : '') + (o.label || o.value))}">
			<span class="model-menu-name">${escapeHtml(modelDisplayName(o.value))}</span>
			${o.providerName ? `<span class="model-menu-provider">${escapeHtml(o.providerName)}</span>` : ''}
			<span class="model-menu-check" aria-hidden="true">${o.value === currentModel ? CHECK_SVG : ''}</span>
		</div>
	`).join('');
	modelMenu.insertAdjacentHTML('beforeend', rowsHtml);
	modelMenu.querySelectorAll('.model-menu-item').forEach(row => {
		row.addEventListener('click', () => chooseModel(row.dataset.value, row.dataset.provider));
	});
	if (!q) {
		// Open on the current choice rather than at the top of a list it may be far down.
		// Only when no filter is active — a filtered list reads best from its top.
		const selected = modelMenu.querySelector('.model-menu-item[aria-selected="true"]');
		const searchWrap = modelMenu.querySelector('.model-menu-search-wrap');
		if (selected && searchWrap) { modelMenu.scrollTop = Math.max(0, selected.offsetTop - searchWrap.offsetHeight); }
	} else {
		modelMenu.scrollTop = 0;
	}
}

/**
 * Subsequence match with a contiguity-and-boundary score, tuned for model ids:
 * "son5" finds Sonnet 5, "op48" finds Opus 4.8, "haiku" finds Haiku 4.5. Returns
 * the items whose characters appear in order, best first. An empty query passes
 * everything through in the given order.
 */
function fuzzyScore(query, text) {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (!q) { return 0; }
	let qi = 0;
	let score = 0;
	let lastHit = -2;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] !== q[qi]) { continue; }
		// Consecutive hits read as one typed word; a hit at a separator (or the very
		// start) reads as a new word — both beat a hit mid-word.
		score += (ti === lastHit + 1) ? 3 : ((ti === 0 || /[-_ .\/]/.test(t[ti - 1])) ? 2 : 1);
		lastHit = ti;
		qi++;
	}
	// Every query character must have matched — otherwise it is not a match at all.
	return qi === q.length ? score : -1;
}

/** Filter+rank `items` by `key(item)` against `query`; empty query → items as-is. */
function fuzzySort(items, query, key) {
	if (!query || !query.trim()) { return items; }
	return items
		.map(item => ({ item, s: fuzzyScore(query.trim(), key(item)) }))
		.filter(x => x.s >= 0)
		.sort((a, b) => b.s - a.s)
		.map(x => x.item);
}

function chooseModel(value, providerId) {
	closeModelMenu();
	if (!value || value === currentModel) { return; }
	const panels = window.CodeMindPanels;
	if (panels && panels.selectModel) {
		// The provider rides along so the endpoint + key + model switch together for a
		// model that belongs to a provider other than the active one.
		panels.selectModel(value, providerId || undefined);
	} else {
		vscode.postMessage({ type: 'runCommand', payload: { name: 'model', args: value } });
	}
	// Move the pill on the click; the `settingsData` echo confirms it a moment later.
	setModelLabel(value);
}

// ---------- Mode selector (Section 2.3) ----------
/**
 * The modes a turn can run in, in the order Shift+Tab walks them. This is a menu rather
 * than a row of segments, which is what lets `bypassPermissions` be listed at all: the
 * segmented control could not show it as active, so it had to be left out and the control
 * went blank whenever that mode was set. A menu names whatever is chosen.
 */
const MODE_OPTIONS = [
	{ mode: 'default', label: 'Normal', detail: 'Asks before edits and commands.' },
	{ mode: 'acceptEdits', label: 'Edit', detail: 'File edits are auto-approved, commands still ask.' },
	{ mode: 'plan', label: 'Plan', detail: 'Read-only: the agent researches and plans, and changes nothing.' },
	{ mode: 'bypassPermissions', label: 'Bypass', detail: 'Nothing is asked. Only in a workspace you can throw away.' },
];

/** The mode the next turn will run in, as the workbench last reported it. */
let currentMode = 'default';
let modeMenuOpen = false;

function modeLabel(mode) {
	const found = MODE_OPTIONS.find(o => o.mode === mode);
	return found ? found.label : 'Mode';
}

function toggleModeMenu() {
	if (modeMenuOpen) { closeModeMenu(); } else { openModeMenu(); }
}

function openModeMenu() {
	if (!modeMenu) { return; }
	// Only one of the two composer menus is ever open: they sit side by side and would
	// otherwise overlap.
	closeModelMenu();
	modeMenu.classList.remove('is-closing');
	modeMenu.classList.remove('hidden');
	renderModeMenu();
	if (modePill) { modePill.setAttribute('aria-expanded', 'true'); }
	modeMenuOpen = true;
}

function closeModeMenu() {
	if (!modeMenu) { return; }
	if (modeMenu.classList.contains('hidden')) { modeMenuOpen = false; return; }
	modeMenuOpen = false;
	if (modePill) { modePill.setAttribute('aria-expanded', 'false'); }
	// Section 6.6: the same four pixels back that every other dropdown drops.
	playOut(modeMenu, () => modeMenu.classList.add('hidden'));
}

function renderModeMenu() {
	modeMenu.innerHTML = MODE_OPTIONS.map(o => `
		<div class="model-menu-item mode-menu-item" role="option" data-mode="${escapeAttr(o.mode)}" aria-selected="${o.mode === currentMode ? 'true' : 'false'}">
			<span class="model-menu-name">
				<span class="mode-menu-label">${escapeHtml(o.label)}</span>
				<span class="mode-menu-detail">${escapeHtml(o.detail)}</span>
			</span>
			<span class="model-menu-check" aria-hidden="true">${o.mode === currentMode ? CHECK_SVG : ''}</span>
		</div>
	`).join('');
	modeMenu.querySelectorAll('.mode-menu-item').forEach(row => {
		row.addEventListener('click', () => chooseMode(row.dataset.mode));
	});
}

/**
 * Switch the mode a turn runs in. The pane moves both the plan flag and the stored
 * permission mode from one place, so this sends the mode and nothing else — setting either
 * half from here would leave the other disagreeing. No transcript line: the pill already
 * says which mode is active, and a chat entry repeating it is noise.
 */
function chooseMode(mode) {
	closeModeMenu();
	if (!mode || mode === currentMode) { return; }
	// Optimistic: the pill changes on the press, and the pane's echo confirms it.
	applyModeSelection(mode);
	vscode.postMessage({ type: 'setPermissionMode', payload: { mode } });
}

/** Paint the pill. An unknown mode keeps its own name rather than showing as nothing. */
// Multi-Agent Consensus toggle state, mirrored from the pane's `consensusState`.
// `consensusOpen` = the window is open (switch lit); `consensusRunning` = a run is in
// flight, which locks the switch so the window can't be closed from the composer.
let consensusOpen = false;
let consensusRunning = false;

/** Paint the consensus switch to match {consensusOpen, consensusRunning}. */
function paintConsensusPill() {
	const checkbox = document.getElementById('consensusPillCheckbox');
	const bg = document.getElementById('consensusPillSliderBg');
	const knob = document.getElementById('consensusPillSliderKnob');
	const label = document.querySelector('#consensusPillWrap label');
	if (!checkbox || !bg || !knob) { return; }
	checkbox.checked = consensusOpen;
	checkbox.disabled = consensusRunning;
	if (consensusOpen) {
		knob.style.left = '14px';
		bg.style.backgroundColor = 'var(--cm-accent)';
		knob.style.backgroundColor = 'var(--cm-bg)';
	} else {
		knob.style.left = '2px';
		bg.style.backgroundColor = 'transparent';
		knob.style.backgroundColor = 'var(--cm-accent)';
	}
	// Running reads as locked: dim it and switch the cursor to not-allowed.
	const wrap = document.getElementById('consensusPillWrap');
	if (wrap) { wrap.style.opacity = consensusRunning ? '0.6' : '1'; }
	if (label) {
		label.style.cursor = consensusRunning ? 'not-allowed' : 'pointer';
		label.title = consensusRunning
			? 'Consensus is running — close it from the window when it finishes'
			: (consensusOpen ? 'Multi-Agent Consensus — on (click to close)' : 'Multi-Agent Consensus — off (click to open)');
	}
}

function applyModeSelection(mode) {
	currentMode = mode;
	const consensusWrap = document.getElementById('consensusPillWrap');
	if (consensusWrap) {
		consensusWrap.style.display = mode === 'plan' ? 'flex' : 'none';
	}
	paintConsensusPill();
	if (!modePill) { return; }
	modePill.dataset.mode = mode;
	modePill.textContent = modeLabel(mode);
	const found = MODE_OPTIONS.find(o => o.mode === mode);
	modePill.title = found ? `${found.label} — ${found.detail}` : 'Agent mode for new turns';
	if (modeMenuOpen) { renderModeMenu(); }
}

/** Follow the permission mode the workbench reports in `settingsData`. */
function applyPermissionModeToSelector(mode) {
	applyModeSelection(MODE_OPTIONS.some(o => o.mode === mode) ? mode : 'default');
}

// ---------- Keyboard shortcuts (Section 4.2) ----------
function wireGlobalShortcuts() {
	document.addEventListener('keydown', (e) => {
		// A key the composer already handled is not also a panel shortcut: Ctrl+R is
		// vim's redo and Ctrl+K kills to end of line when there is text to kill.
		if (e.defaultPrevented) { return; }
		// Ctrl+C / Escape cancels a running stream.
		if (isBusy && (e.key === 'Escape' || (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()))) {
			cancelStream();
			e.preventDefault();
			return;
		}
		// Ctrl+R opens the session picker (Section 4.2), the same one `/resume` opens.
		// Vim's redo and the reverse-prompt search both preventDefault before this,
		// so this only runs when neither of them wanted the key.
		if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'r') {
			vscode.postMessage({ type: 'runCommand', payload: { name: 'resume', args: '' } });
			e.preventDefault();
			return;
		}
		if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'l') {
			messages = [];
			streamScratch.clear();
			resetClips();
			renderEmptyState();
			e.preventDefault();
			return;
		}
		if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'k') {
			inputEl.focus();
			inputEl.value = '/';
			handleInput();
			e.preventDefault();
			return;
		}
		// Ctrl+T shows or hides the task list, as it does in the CLI.
		if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 't') {
			toggleTasksPanel();
			e.preventDefault();
			return;
		}
		// Ctrl+O expands or collapses every tool card and thinking block — the CLI's
		// transcript-detail toggle.
		if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'o') {
			toggleTranscriptDetail();
			e.preventDefault();
			return;
		}
		// Alt+P / Alt+T / Alt+O: the pickers the CLI puts behind its own Alt chords.
		if (e.altKey && !e.ctrlKey && !e.metaKey) {
			const letter = (e.key || '').toLowerCase();
			if (letter === 'p') { openModelPicker(); e.preventDefault(); return; }
			if (letter === 't') { openEffortPicker(); e.preventDefault(); return; }
			if (letter === 'o') { toggleFastMode(); e.preventDefault(); return; }
		}
	});
}

/** Show or hide the tasks panel (Ctrl+T). */
function toggleTasksPanel() {
	const panels = window.CodeMindPanels;
	if (!panels || !panels.getActivePanel) {
		vscode.postMessage({ type: 'runCommand', payload: { name: 'tasks', args: '' } });
		return;
	}
	if (panels.getActivePanel() === 'tasks') { panels.closePanel(); } else { panels.openPanel('tasks'); }
}

// Whether tool cards and thinking blocks are forced open. `null` means neither —
// each block keeps whatever the user did to it.
let transcriptExpanded = null;

/** Ctrl+O: open every collapsible block in the transcript, or close them all. */
function toggleTranscriptDetail() {
	transcriptExpanded = !transcriptExpanded;
	const count = applyTranscriptDetail();
	if (!count) { showComposerHint('Nothing to expand yet.'); return; }
	showComposerHint(transcriptExpanded ? `Expanded ${count} block${count === 1 ? '' : 's'}.` : `Collapsed ${count} block${count === 1 ? '' : 's'}.`);
}

/**
 * Push the current expand-all state onto the transcript. Called again after every
 * render so blocks that arrive later match what the toggle last asked for.
 * Returns how many blocks it touched.
 */
function applyTranscriptDetail() {
	if (transcriptExpanded === null || !messagesEl) { return 0; }
	const blocks = messagesEl.querySelectorAll('details');
	blocks.forEach(el => { el.open = transcriptExpanded; });
	return blocks.length;
}

/** Alt+P: pick the model for new turns — the pill's own menu (Section 2.2). */
function openModelPicker() {
	if (modelMenu && modelPill) {
		// Focus follows the menu so the choice can be made from the keyboard the shortcut
		// was pressed with.
		openModelMenu();
		modelPill.focus();
		return;
	}
	const panels = window.CodeMindPanels;
	if (panels && panels.showModelPicker) { panels.showModelPicker(); return; }
	vscode.postMessage({ type: 'runCommand', payload: { name: 'model', args: '' } });
}

/** Alt+T: pick how hard the model thinks — the GUI's thinking toggle. */
function openEffortPicker() {
	const panels = window.CodeMindPanels;
	if (panels && panels.showEffortPicker) { panels.showEffortPicker(); return; }
	vscode.postMessage({ type: 'runCommand', payload: { name: 'effort', args: '' } });
}

/** Alt+O: fast mode on or off, without opening anything. */
function toggleFastMode() {
	const panels = window.CodeMindPanels;
	if (!panels || !panels.toggleFastMode) {
		vscode.postMessage({ type: 'runCommand', payload: { name: 'fast', args: '' } });
		return;
	}
	showComposerHint(panels.toggleFastMode() ? 'Fast mode on.' : 'Fast mode off.');
}

function cancelStream() {
	if (!streamingMessageId) { return; }
	vscode.postMessage({ type: 'cancel', payload: { queryId: streamingMessageId } });
	// Interrupting drops whatever was waiting behind the turn, as the CLI does —
	// the queue existed to follow that turn, and it is no longer happening.
	if (promptQueue.length) {
		promptQueue.length = 0;
		renderPromptQueue();
		appendLocalSystemMessage('Interrupted. Queued prompts were discarded.');
	}
	setStatus('ready');
}

// ---------- Inbound messages ----------
function handleExtensionMessage(event) {
	const msg = event.data;
	switch (msg.type) {
		case 'history':
			messages = (msg.payload || []).map(normalizeHistoryMessage);
			streamScratch.clear();
			resetClips();
			renderMessages();
			// A replaced transcript opens at its newest turn, and following starts armed
			// again — whatever the reader had scrolled to belonged to the old one.
			scrollToBottom();
			// Seed arrow-up history from a restored transcript, but only while nothing
			// has been typed this session — otherwise `/clear` would wipe it, and the
			// CLI keeps its prompt history across a cleared conversation.
			if (!inputHistory.length) { seedInputHistory(); }
			break;
		case 'status':
			setStatus(msg.payload);
			break;
		case 'newMessage':
			addOrUpdateMessage(msg.payload);
			break;
		case 'streamStart':
			startStreamingMessage(msg.payload);
			break;
		case 'streamMeta':
			applyStreamMeta(msg.payload);
			break;
		case 'streamDelta':
			appendStreamingDelta(msg.payload);
			break;
		case 'streamError':
			markStreamError(msg.payload);
			break;
		case 'thinkingDelta':
			appendThinkingDelta(msg.payload);
			break;
		case 'tool':
			upsertTool(msg.payload);
			break;
		case 'agentText':
			appendAgentText(msg.payload);
			break;
		case 'toolDelta':
			updateToolInput(msg.payload);
			break;
		case 'streamEnd':
			finishStreamingMessage(msg.payload);
			break;
		case 'toolProgress':
			updateToolProgress(msg.payload);
			break;
		case 'permissionRequest':
			showPermissionDialog(msg.payload);
			break;
		case 'openPanel':
			// `apiKey` is the sign-in dialog that lives in this document, not one of
			// the panel-module overlays, so `/login` is routed to it directly. So is
			// `backgroundTasks`: it is the footer list above the composer, not a panel.
			if (msg.payload.panelId === 'apiKey') {
				showModal(true);
			} else if (msg.payload.panelId === 'backgroundTasks') {
				openBackgroundTaskList();
			} else if (window.CodeMindPanels && window.CodeMindPanels.openPanel) {
				window.CodeMindPanels.openPanel(msg.payload.panelId);
			}
			break;
		case 'panelData':
			if (window.CodeMindPanels && window.CodeMindPanels.renderPanelData) {
				window.CodeMindPanels.renderPanelData(msg.payload.panelId, msg.payload.items);
			}
			break;
		case 'commandList':
			commandList = msg.payload || [];
			break;
		case 'settingsData':
			// Keep the header's model label in step with configuration even when
			// the settings panel is closed.
			if (msg.payload && msg.payload.model) { setModelLabel(msg.payload.model); }
			if (window.CodeMindPanels && window.CodeMindPanels.applySettings) {
				window.CodeMindPanels.applySettings(msg.payload || {});
			}
			applyPanelSettings(msg.payload || {});
			break;
		case 'endpointModels':
			if (window.CodeMindPanels && window.CodeMindPanels.applyEndpointModels) {
				window.CodeMindPanels.applyEndpointModels(msg.payload || {});
			}
			break;
		case 'providerModels':
			if (window.CodeMindPanels && window.CodeMindPanels.applyProviderModels) {
				window.CodeMindPanels.applyProviderModels(msg.payload || {});
			}
			break;
		case 'providerDetection':
			if (window.CodeMindPanels && window.CodeMindPanels.handleProviderDetection) {
				window.CodeMindPanels.handleProviderDetection(msg.payload || {});
			}
			break;
		case 'historyData':
			if (window.CodeMindPanels && window.CodeMindPanels.renderHistory) {
				window.CodeMindPanels.renderHistory(msg.payload && msg.payload.entries || [], msg.payload && msg.payload.allProjects);
			}
			break;
		case 'mcpData':
			if (window.CodeMindPanels && window.CodeMindPanels.renderMcp) {
				window.CodeMindPanels.renderMcp(msg.payload || []);
			}
			break;
		case 'mentionItems':
			showMentionMenu((msg.payload && msg.payload.items) || [], msg.payload && msg.payload.query, msg.payload && msg.payload.requestId);
			break;
		case 'imagePreview':
			applyImagePreview(msg.payload.path, msg.payload.dataUrl);
			break;
		case 'commitReview':
			if (window.CodeMindPanels && window.CodeMindPanels.showCommitReview) {
				window.CodeMindPanels.showCommitReview(msg.payload);
			} else {
				// Never leave the pane waiting on a sheet that cannot be shown.
				vscode.postMessage({ type: 'commitResponse', payload: { confirmed: false } });
			}
			break;
		case 'sessionCost':
			applySessionCost(msg.payload);
			break;
		case 'contextStatus':
			updateContextMeter(msg.payload);
			break;
		case 'featureFlags':
			featureFlags = msg.payload || {};
			applyFeatureFlags();
			break;
		case 'planMode':
			setPlanMode(!!msg.payload);
			break;
		case 'consensusState':
			consensusOpen = !!(msg.payload && msg.payload.open);
			consensusRunning = !!(msg.payload && msg.payload.running);
			paintConsensusPill();
			break;
		case 'attachPaths':
			attachFiles(msg.payload || []);
			break;
		case 'sessionName':
			applySessionName(msg.payload || {});
			break;
		case 'promptColor':
			applyPromptColor((msg.payload && msg.payload.color) || '');
			break;
		case 'restoreDraft':
			restoreDraft(msg.payload || '');
			break;
		case 'composerText':
			// The external editor is authoritative while it is open, so this replaces
			// whatever is in the composer rather than deferring to it.
			setComposerText((msg.payload && msg.payload.text) || '');
			break;
		case 'focusInput':
			inputEl.focus();
			break;
		case 'aristotle': {
			// The pet draws itself (media/aristotle.js); the workbench only owns whether he
			// exists and how long he waits before dozing off.
			const pet = window.CodeMindAristotle;
			const cfg = msg.payload || {};
			if (pet) {
				pet.setSleepAfterSeconds(cfg.sleepAfterSeconds);
				pet.setEnabled(cfg.enabled !== false);
			}
			break;
		}
		case 'panelVisible':
			// The document is retained while the view is hidden, so nothing inside it would
			// otherwise know to stop its frame loop.
			if (window.CodeMindAristotle) { window.CodeMindAristotle.setVisible(msg.payload !== false); }
			break;
			case 'orchestrationProgress': {
				// Live spinner label for the pre-query pipeline (Section 11.2). Shown to all
				// users, not just dev mode. Only while busy, and it gives way to the model's
				// own "Thinking…" as soon as the first token arrives (noteFirstToken).
				const p = msg.payload || {};
				if (!isBusy) break;
				let label = '';
				if (p.phase === 'cache_hit' || p.status === 'cache_hit') {
					label = 'Using cached context…';
				} else if (p.phase === 'intent_detection') {
					label = (p.status === 'complete' && p.intent)
						? `Intent: ${String(p.intent).replace(/_/g, ' ').toLowerCase()}`
						: 'Detecting intent…';
				} else if (p.phase === 'tool_execution') {
					if (p.status === 'complete') {
						label = 'Optimizing context…';
					} else {
						const n = p.toolId ? String(p.toolId).split(',').filter(Boolean).length : 0;
						label = n ? `Gathering context · ${n} tool${n === 1 ? '' : 's'}…` : 'Gathering context…';
					}
				}
				if (label) { statusText.textContent = label; }
				break;
			}
	}
}

// History arrives without streaming scratch; render its content + stored metadata.
function normalizeHistoryMessage(m) {
	return { ...m, streaming: false };
}

// ---------- Input ----------
function handleKeydown(e) {
	// A reverse history search owns the keyboard while it runs — including the keys
	// the menus below would take, which is why it is read first.
	if (historySearch && handleHistorySearchKey(e)) { return; }

	// The slash-command autocomplete owns navigation keys while it is open.
	if (slashOpen) {
		if (e.key === 'ArrowDown') { moveSlashSelection(1); e.preventDefault(); return; }
		if (e.key === 'ArrowUp') { moveSlashSelection(-1); e.preventDefault(); return; }
		// Ctrl+N / Ctrl+P move too, as they do in the CLI.
		if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { moveSlashSelection(1); e.preventDefault(); return; }
		if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) { moveSlashSelection(-1); e.preventDefault(); return; }
		// Shift+Tab is the permission-mode cycle everywhere, so only plain Tab accepts.
		if (e.key === 'Tab' && !e.shiftKey) { acceptSlashSelection(false); e.preventDefault(); return; }
		if (e.key === 'Enter' && !e.shiftKey) { acceptSlashSelection(true); e.preventDefault(); return; }
		if (e.key === 'Escape') { closeSlashMenu(); e.preventDefault(); return; }
	}

	// The @-mention menu owns the same keys while it is open.
	if (mentionOpen) {
		if (e.key === 'ArrowDown') { moveMentionSelection(1); e.preventDefault(); return; }
		if (e.key === 'ArrowUp') { moveMentionSelection(-1); e.preventDefault(); return; }
		if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) { acceptMentionSelection(); e.preventDefault(); return; }
		if (e.key === 'Escape') { closeMentionMenu(); e.preventDefault(); return; }
	}

	// Shift+Tab cycles the permission mode, the CLI's most-used shortcut. It is
	// handled here rather than in wireGlobalShortcuts so that the menus above get
	// first refusal on the Tab key.
	if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
		vscode.postMessage({ type: 'runCommand', payload: { name: 'permissions', args: 'cycle' } });
		e.preventDefault();
		return;
	}

	// Ctrl+Shift+R starts the reverse prompt search. Plain Ctrl+R belongs to the session
	// picker (Section 4.2) and, in vim NORMAL, to redo — so the search takes the shifted
	// chord and stays available in every mode. Once the search is open, Ctrl+R on its own
	// steps to the next match, as readline does.
	if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
		startHistorySearch();
		e.preventDefault();
		return;
	}

	// Everything else — readline bindings, vim, Enter-to-send — belongs to the
	// composer editing engine in input.js. It calls preventDefault itself when it
	// consumes a key, which is also what stops the document-level shortcuts below
	// from firing on the same keystroke.
	if (composerEditor.handleKey(e)) { return; }

	// Input history: Up from the first line, Down from the last one (Section 3.4). The
	// line test rather than "caret at offset 0" is what makes repeated Up keep walking
	// back — a recalled entry leaves the caret at its end, as every shell does, and that
	// end is still on the first line. Inside a multi-line draft the arrows keep their
	// normal job on every line but the outermost.
	const caretCollapsed = inputEl.selectionStart === inputEl.selectionEnd;
	const onFirstLine = caretCollapsed && !inputEl.value.slice(0, inputEl.selectionStart).includes('\n');
	const onLastLine = caretCollapsed && !inputEl.value.slice(inputEl.selectionStart).includes('\n');
	if (e.key === 'ArrowUp' && onFirstLine) {
		if (cycleHistory(-1)) { e.preventDefault(); }
		return;
	}
	if (e.key === 'ArrowDown' && onLastLine) {
		if (cycleHistory(1)) { e.preventDefault(); }
		return;
	}
}

// Move through the session's sent messages. Returns true when it consumed the key.
function cycleHistory(delta) {
	if (!inputHistory.length) { return false; }
	if (historyIdx === inputHistory.length) {
		if (delta > 0) { return false; }
		pendingDraft = inputEl.value;
	}
	const next = historyIdx + delta;
	if (next < 0) { return true; }
	historyIdx = Math.min(next, inputHistory.length);
	inputEl.value = historyIdx === inputHistory.length ? pendingDraft : inputHistory[historyIdx];
	handleInput();
	const end = inputEl.value.length;
	inputEl.setSelectionRange(end, end);
	return true;
}

function handleInput() {
	// Disabled while a turn runs (Section 2.4), which does not refuse the prompt: Enter
	// still queues it, the same way the CLI takes a line typed mid-turn.
	sendBtn.disabled = isBusy || !inputEl.value.trim();
	updateInputHeight();
	updateSlashMenu();
	updateMentionMenu();
	syncSlashArgsHint();
	updateInputMode();
	syncDraft();
}

// ---------- Draft persistence ----------
// The workbench writes the composer text into the panel's memento so a window
// reload does not lose it. Debounced: this is about surviving a reload, not
// about reporting every keystroke across the message channel.
let draftTimer = null;
let lastSentDraft = '';

function syncDraft() {
	if (draftTimer !== null) { clearTimeout(draftTimer); }
	draftTimer = setTimeout(() => {
		draftTimer = null;
		if (inputEl.value === lastSentDraft) { return; }
		lastSentDraft = inputEl.value;
		vscode.postMessage({ type: 'draftChanged', payload: lastSentDraft });
	}, 400);
}

// Report a cleared or restored composer at once: waiting would leave the saved
// draft describing text that is no longer on screen.
function syncDraftNow() {
	if (draftTimer !== null) { clearTimeout(draftTimer); draftTimer = null; }
	if (inputEl.value === lastSentDraft) { return; }
	lastSentDraft = inputEl.value;
	vscode.postMessage({ type: 'draftChanged', payload: lastSentDraft });
}

// Put an unsent draft back in the composer after a reload. The slash and mention
// menus stay closed on purpose: this is text left behind, not text being typed.
function restoreDraft(text) {
	if (!text || inputEl.value) { return; }
	lastSentDraft = text;
	inputEl.value = text;
	sendBtn.disabled = isBusy || !text.trim();
	updateInputHeight();
	updateInputMode();
	inputEl.setSelectionRange(text.length, text.length);
}

// ---------- Input modes (! shell, # memory) ----------
// A leading `!` runs the line as a shell command; a leading `#` files it as a
// memory note. Both mirror the CLI, where the prompt itself changes to say so.
const INPUT_MODES = {
	'!': { id: 'shell', label: 'shell', hint: 'runs in your workspace, output goes to the agent' },
	'#': { id: 'memory', label: 'memory', hint: 'appended to a CLAUDE.md you pick' },
};

function currentInputMode() {
	const first = inputEl.value.charAt(0);
	// `#` only counts at the very start of an otherwise empty-prefixed line, same
	// as the CLI: `## heading` inside a longer prompt is just text.
	return INPUT_MODES[first] || null;
}

function updateInputMode() {
	if (!inputModeEl) { return; }
	const mode = currentInputMode();
	if (!mode) {
		inputModeEl.classList.add('hidden');
		inputModeEl.textContent = '';
		inputEl.classList.remove('is-shell-mode', 'is-memory-mode');
		return;
	}
	inputModeEl.classList.remove('hidden');
	inputModeEl.textContent = `${mode.label} mode — ${mode.hint}`;
	inputEl.classList.toggle('is-shell-mode', mode.id === 'shell');
	inputEl.classList.toggle('is-memory-mode', mode.id === 'memory');
}

function updateInputHeight() {
	// One line to six, then a scrollbar (Section 2.6). The ceiling is CSS — `max-height`
	// on `#input` — so this only has to make the element as tall as its own content and
	// the cap does the rest. No line count is spelled out twice.
	inputEl.style.height = 'auto';
	inputEl.style.height = inputEl.scrollHeight + 'px';
}

function sendMessage() {
	const text = inputEl.value.trim();
	if (!text) return;

	closeSlashMenu();
	closeMentionMenu();
	pushInputHistory(text);
	inputEl.value = '';
	inputEl.style.height = 'auto';
	sendBtn.disabled = true;
	updateInputHeight();
	updateInputMode();
	syncDraftNow();
	if (vimEnabled) { setVimMode('normal'); }

	const entry = { text, attachments: attachments.slice(), planMode };
	attachments.length = 0;
	renderAttachments();

	// A turn is already running: hold this one and send it when that turn ends,
	// which is what the CLI does with anything typed while it is working.
	if (isBusy) {
		promptQueue.push(entry);
		renderPromptQueue();
		return;
	}
	dispatchPrompt(entry);
}

/**
 * Post one composed prompt, routing `!` and `#` lines to their own handlers. Returns
 * true when the send is expected to start an agent turn, which is what tells the queue
 * whether anything will report back that the panel is free again.
 */
function dispatchPrompt(entry) {
	const mode = INPUT_MODES[entry.text.charAt(0)];
	if (mode) {
		const body = entry.text.slice(1).trim();
		if (!body) { return false; }
		vscode.postMessage(mode.id === 'shell'
			? { type: 'runShell', payload: { command: body } }
			: { type: 'addMemory', payload: { text: body } });
		return false;
	}
	vscode.postMessage({ type: 'sendMessage', payload: entry });
	return !isCommandLine(entry.text);
}

/**
 * Whether the pane will answer this line with a command instead of a turn. Only the
 * names it advertised in `commandList` count — an unknown `/foo` falls through to the
 * engine as an ordinary prompt, and that does start a turn.
 */
function isCommandLine(text) {
	const match = /^\/([\w:-]+)/.exec(text.trim());
	if (!match) { return false; }
	const name = match[1].toLowerCase();
	return commandList.some(c => c.name.toLowerCase() === name
		|| (c.aliases || []).some(a => a.toLowerCase() === name));
}

// ---------- Prompt queue ----------
// Prompts typed while a turn was running, oldest first. Drained one per turn so
// each still gets its own answer.
const promptQueue = [];

function renderPromptQueue() {
	if (!promptQueueEl) { return; }
	if (!promptQueue.length) {
		promptQueueEl.classList.add('hidden');
		promptQueueEl.innerHTML = '';
		return;
	}
	promptQueueEl.classList.remove('hidden');
	promptQueueEl.innerHTML = promptQueue.map((entry, idx) => `
		<div class="queued-prompt" title="${escapeAttr(entry.text)}">
			<span class="queued-index">${idx + 1}</span>
			<span class="queued-text">${escapeHtml(entry.text)}</span>
			<button class="queued-remove" data-index="${idx}" title="Remove from queue" aria-label="Remove queued prompt">×</button>
		</div>
	`).join('');
	promptQueueEl.querySelectorAll('.queued-remove').forEach(btn => {
		btn.addEventListener('click', () => {
			promptQueue.splice(Number(btn.dataset.index), 1);
			renderPromptQueue();
		});
	});
}

/** Send the next queued prompt, if the panel is idle and one is waiting. */
function drainPromptQueue() {
	// Only a turn ends with a `ready` that comes back here, so a queued `/exit-plan`,
	// `!ls` or `#note` would strand everything behind it: keep going until something
	// that really is a turn takes over.
	while (!isBusy && promptQueue.length) {
		const next = promptQueue.shift();
		renderPromptQueue();
		if (dispatchPrompt(next)) { return; }
	}
}

// ---------- Background tasks (CLI: tasks/pillLabel.ts) ----------
//
// The CLI owns the processes it backgrounds, so its footer pill knows exactly what
// is still alive. The engine runs tools out of process and reports nothing about
// their lifetime, so the panel infers the set from the tool traffic it can see: a
// backgrounded Bash, a Monitor, a background Workflow or Agent joins the list, and
// BashOutput / TaskOutput / KillShell / TaskStop take it off again. A task whose
// end the panel never sees can be dismissed by hand — the one visible difference
// from the CLI, which polls real process state.

/** Live background tasks, keyed by the tool-use id that started them. */
const backgroundTasks = new Map();
let bgTasksOpen = false;
let bgTicker = null;

/** How each tool that can background work shows up in the list. */
const BACKGROUND_TOOLS = {
	Bash: 'shell',
	PowerShell: 'shell',
	Monitor: 'monitor',
	Workflow: 'workflow',
	Task: 'agent',
	Agent: 'agent',
};

/** Tools whose call is about an existing background task rather than a new one. */
const BACKGROUND_PROBE_TOOLS = new Set(['BashOutput', 'TaskOutput', 'KillShell', 'TaskStop']);

/**
 * The id the engine handed back for a background job. The CLI's own wording is
 * `… with ID: bash_1. Output is being written to: …`, so that is what is read
 * first; a workflow reports its `wf_…` run id instead.
 */
function backgroundIdFrom(result) {
	const text = typeof result === 'string' ? result : '';
	const withId = /\bID:\s*([A-Za-z0-9_.:-]+)/.exec(text);
	if (withId) { return withId[1].replace(/[.,;]+$/, ''); }
	const wf = /\bwf_[a-z0-9-]+/.exec(text);
	if (wf) { return wf[0]; }
	return undefined;
}

/** Whether a BashOutput / TaskOutput answer says the job is over. */
function backgroundTaskEnded(result) {
	const text = typeof result === 'string' ? result : '';
	const tagged = /<status>\s*([a-z_]+)\s*<\/status>/i.exec(text);
	if (tagged) { return !/^(running|pending)$/i.test(tagged[1]); }
	// Plain-text shapes the same tools use when they are not reporting XML.
	return /\b(exit code|exited with|has exited|process (?:completed|exited)|status:\s*(?:completed|failed|killed|cancelled))\b/i.test(text);
}

/** Drop every task whose id or label matches, however the caller named it. */
function pruneBackgroundTask(idLike) {
	const wanted = String(idLike ?? '').trim();
	if (!wanted) { return; }
	for (const [key, task] of backgroundTasks) {
		if (task.id === wanted || task.label === wanted || key === wanted) {
			backgroundTasks.delete(key);
		}
	}
}

/**
 * Fold one tool call into the background-task list. Called for every card update,
 * so it must stay cheap and idempotent: the same tool arrives many times as its
 * input streams in and again when the result lands.
 */
function syncBackgroundTask(toolId, tool) {
	const name = tool.toolName;
	if (!name) { return; }
	const input = toolInput(tool);
	if (BACKGROUND_PROBE_TOOLS.has(name)) {
		const target = input.bash_id || input.shell_id || input.task_id || input.id;
		if (name === 'KillShell' || name === 'TaskStop') {
			// A kill is a kill whether or not it succeeded: if it did not, the next
			// output check puts the task back on the list.
			if (tool.status !== 'running') { pruneBackgroundTask(target); renderBackgroundTasks(); }
			return;
		}
		if (tool.status !== 'running' && backgroundTaskEnded(tool.result)) {
			pruneBackgroundTask(target);
			renderBackgroundTasks();
		}
		return;
	}
	const kind = BACKGROUND_TOOLS[name];
	if (!kind) { return; }
	// Only a finished call can be trusted: while it is running the card already
	// says so, and a foreground Bash would otherwise flicker onto the list.
	if (tool.status === 'running' || tool.isError) { return; }
	if (kind === 'shell' && input.run_in_background !== true) { return; }
	// An Agent call is only listed when the model asked for it to be backgrounded.
	// A synchronous subagent has a running card of its own, and the panel would
	// never see it finish — a stale row is worse than no row.
	if (kind === 'agent' && input.run_in_background !== true) { return; }
	if (backgroundTasks.has(toolId)) { return; }
	backgroundTasks.set(toolId, {
		kind,
		id: backgroundIdFrom(tool.result),
		label: backgroundLabelFor(kind, input),
		startedAt: tool.startedAt || Date.now(),
	});
	renderBackgroundTasks();
}

/** The one line that says what a background task is doing. */
function backgroundLabelFor(kind, input) {
	if (kind === 'shell') { return firstLine(String(input.command || ''), 120) || 'shell'; }
	if (kind === 'monitor') { return String(input.description || input.command || 'monitor'); }
	if (kind === 'workflow') { return String(input.name || input.title || 'workflow'); }
	return String(input.description || input.subagent_type || 'agent');
}

/**
 * The CLI's `getPillLabel`: one wording per kind when they all match, the shell /
 * monitor split spelled out, and a plain count when the kinds are mixed.
 */
function backgroundPillLabel(tasks) {
	const n = tasks.length;
	if (!n) { return ''; }
	const kinds = new Set(tasks.map(task => task.kind));
	if (kinds.size > 1) { return `${n} background ${n === 1 ? 'task' : 'tasks'}`; }
	const [kind] = kinds;
	if (kind === 'monitor') { return n === 1 ? '1 monitor' : `${n} monitors`; }
	if (kind === 'agent') { return n === 1 ? '1 local agent' : `${n} local agents`; }
	if (kind === 'workflow') { return n === 1 ? '1 background workflow' : `${n} background workflows`; }
	return n === 1 ? '1 shell' : `${n} shells`;
}

/** `1h 04m`, `4m 12s`, `38s` — the same shape the tool cards use for elapsed time. */
function backgroundElapsed(startedAt) {
	const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	if (seconds < 60) { return `${seconds}s`; }
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) { return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`; }
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function renderBackgroundTasks() {
	const tasks = [...backgroundTasks.entries()];
	if (bgPillEl && bgPillTextEl) {
		bgPillEl.classList.toggle('hidden', tasks.length === 0);
		bgPillTextEl.textContent = backgroundPillLabel(tasks.map(([, task]) => task));
		bgPillEl.setAttribute('aria-expanded', String(bgTasksOpen && tasks.length > 0));
	}
	if (!tasks.length) { bgTasksOpen = false; }
	if (bgTasksEl) {
		bgTasksEl.classList.toggle('hidden', !bgTasksOpen || !tasks.length);
		bgTasksEl.innerHTML = !bgTasksOpen || !tasks.length ? '' : `${tasks.map(([key, task]) => `
			<div class="bg-task">
				<span class="bg-task-kind">${escapeHtml(task.kind)}</span>
				<span class="bg-task-label" title="${escapeAttr(task.label)}">${escapeHtml(task.id ? `${task.id} · ${task.label}` : task.label)}</span>
				<span class="bg-task-elapsed">${escapeHtml(backgroundElapsed(task.startedAt))}</span>
				<button class="bg-task-action" data-bg-check="${escapeAttr(key)}">Check</button>
				<button class="bg-task-action" data-bg-stop="${escapeAttr(key)}">Stop</button>
				<button class="bg-task-forget" data-bg-forget="${escapeAttr(key)}" title="Remove from this list" aria-label="Remove from this list">×</button>
			</div>
		`).join('')}<div class="bg-tasks-note">Check and Stop write the request into the composer — the agent owns these jobs, so it is the one that reads or ends them.</div>`;
		bgTasksEl.querySelectorAll('[data-bg-check]').forEach(btn => {
			btn.addEventListener('click', () => composeBackgroundRequest(btn.dataset.bgCheck, 'check'));
		});
		bgTasksEl.querySelectorAll('[data-bg-stop]').forEach(btn => {
			btn.addEventListener('click', () => composeBackgroundRequest(btn.dataset.bgStop, 'stop'));
		});
		bgTasksEl.querySelectorAll('[data-bg-forget]').forEach(btn => {
			btn.addEventListener('click', () => {
				backgroundTasks.delete(btn.dataset.bgForget);
				renderBackgroundTasks();
			});
		});
	}
	// The list shows elapsed time, so it needs a heartbeat — but only while it is
	// open, and never when there is nothing left to count.
	if (bgTasksOpen && tasks.length) {
		bgTicker = bgTicker || setInterval(renderBackgroundTasks, 1000);
	} else if (bgTicker) {
		clearInterval(bgTicker);
		bgTicker = null;
	}
}

/**
 * Put the ask in the composer rather than sending it: the tools that read or kill
 * a background job belong to the agent, and a click in a footer list is not a turn
 * the user has decided to spend.
 */
function composeBackgroundRequest(key, action) {
	const task = backgroundTasks.get(key);
	if (!task) { return; }
	const subject = task.id ? `${task.kind} ${task.id}` : `the background ${task.kind} running \`${task.label}\``;
	const text = action === 'stop'
		? `Stop ${subject}.`
		: `Show me the latest output from ${subject}.`;
	inputEl.value = inputEl.value ? `${inputEl.value.replace(/\s*$/, '')} ${text}` : text;
	inputEl.dispatchEvent(new Event('input', { bubbles: true }));
	inputEl.focus();
}

bgPillEl?.addEventListener('click', () => {
	bgTasksOpen = !bgTasksOpen;
	renderBackgroundTasks();
});

/** Called by `/bashes` and by a new session: nothing carries over. */
function clearBackgroundTasks() {
	backgroundTasks.clear();
	bgTasksOpen = false;
	renderBackgroundTasks();
}

/**
 * `/bashes`: show the list, and say so in the transcript when it is empty — a
 * command that appears to do nothing is worse than one that answers "none".
 */
function openBackgroundTaskList() {
	if (!backgroundTasks.size) {
		appendLocalSystemMessage('No background tasks are running. A Bash call with `run_in_background`, a Monitor, or a background Agent or Workflow shows up here while it lasts.');
		return;
	}
	bgTasksOpen = true;
	renderBackgroundTasks();
}

// ---------- Input history (Step 8) ----------
const inputHistory = [];
let historyIdx = -1;
let pendingDraft = '';

function pushInputHistory(text) {
	if (!text.trim()) { return; }
	inputHistory.push(text);
	historyIdx = inputHistory.length;
}

// Rebuild arrow-up history from the transcript, so a conversation restored after
// a reload still offers the prompts that were sent in it.
function seedInputHistory() {
	for (const m of messages) {
		if (m.type === 'user' && (m.content || '').trim()) { inputHistory.push(m.content); }
	}
	historyIdx = inputHistory.length;
}

// ---------- Reverse history search (Ctrl+Shift+R) ----------
// The CLI's `chat:historySearch`: Ctrl+Shift+R turns the composer into a search field
// over the prompts already sent, newest first, matching a case-sensitive
// substring. Ctrl+R again looks further back, Escape or Tab keeps what it found,
// Enter sends it. Unlike the CLI there is no cross-session history file, so this
// searches the session's own history (seeded from the transcript on restore).
let historySearch = null;

/** Keydowns that are only ever half of a chord; a search must not end on them. */
const CHORD_MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead']);

function startHistorySearch() {
	if (historySearch) { stepHistorySearch(); return true; }
	if (!inputHistory.length) { showComposerHint('No history to search.'); return true; }
	closeSlashMenu();
	closeMentionMenu();
	historySearch = {
		pattern: '',
		/** Walk position: the next candidate is `index - 1`. */
		index: inputHistory.length,
		/** Index of the prompt on screen, kept when a later search finds nothing. */
		match: -1,
		text: inputEl.value,
		offset: inputEl.selectionStart,
		/** Prompts already offered for this pattern, so a repeat is skipped. */
		seen: new Set(),
	};
	applyHistorySearch();
	return true;
}

/** Put `text` in the composer with the matched run selected. */
function showSearchMatch(text, selStart, selEnd) {
	inputEl.value = text;
	handleInput();
	// A recalled prompt often starts with `/` or holds an `@`; neither menu should
	// open over the search.
	closeSlashMenu();
	closeMentionMenu();
	const max = text.length;
	inputEl.setSelectionRange(Math.min(selStart, max), Math.min(selEnd, max));
}

function applyHistorySearch() {
	const state = historySearch;
	if (!state) { return; }
	if (!state.pattern) {
		// An empty query is not a failed search: it shows the draft the search
		// started from, and Enter would send that.
		state.match = -1;
		showSearchMatch(state.text, state.offset, state.offset);
		showComposerHint('search prompts:', { sticky: true, kind: 'search' });
		return;
	}
	for (let i = state.index - 1; i >= 0; i--) {
		const entry = inputHistory[i];
		if (state.seen.has(entry)) { continue; }
		const at = entry.lastIndexOf(state.pattern);
		if (at === -1) { continue; }
		state.match = i;
		showSearchMatch(entry, at, at + state.pattern.length);
		showComposerHint(`search prompts: ${state.pattern}`, { sticky: true, kind: 'search' });
		return;
	}
	// Nothing further back matches. The CLI leaves the prompt it last found on
	// screen and changes the label, rather than emptying the composer.
	showComposerHint(`no matching prompt: ${state.pattern}`, { sticky: true, kind: 'search' });
}

/** Ctrl+R again: the same pattern, further back. */
function stepHistorySearch() {
	const state = historySearch;
	if (!state || !state.pattern) { return; }
	if (state.match < 0) {
		showComposerHint(`no matching prompt: ${state.pattern}`, { sticky: true, kind: 'search' });
		return;
	}
	state.seen.add(inputHistory[state.match]);
	state.index = state.match;
	applyHistorySearch();
}

/** A changed pattern searches the whole history again, from the newest prompt. */
function setHistorySearchPattern(pattern) {
	const state = historySearch;
	if (!state) { return; }
	state.pattern = pattern;
	state.index = inputHistory.length;
	state.seen.clear();
	applyHistorySearch();
}

function endHistorySearch(accept) {
	const state = historySearch;
	if (!state) { return; }
	historySearch = null;
	hideComposerHint();
	if (!accept) {
		inputEl.value = state.text;
		handleInput();
		const pos = Math.max(0, Math.min(state.offset, state.text.length));
		inputEl.setSelectionRange(pos, pos);
		return;
	}
	// Accepting behaves like arrow-up history: the recalled prompt becomes the
	// current entry, and the draft the search started from waits at the end of it.
	if (state.match >= 0) {
		historyIdx = state.match;
		pendingDraft = state.text;
	}
	const end = inputEl.value.length;
	inputEl.setSelectionRange(end, end);
}

/** Returns true when the key belonged to the search. */
function handleHistorySearchKey(e) {
	const state = historySearch;
	if (!state) { return false; }
	if (CHORD_MODIFIER_KEYS.has(e.key)) { return true; }
	if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
		stepHistorySearch();
		e.preventDefault();
		return true;
	}
	if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'c' || e.key === 'C' || e.key === 'g' || e.key === 'G')) {
		endHistorySearch(false);
		e.preventDefault();
		return true;
	}
	if (e.key === 'Escape' || e.key === 'Tab') {
		endHistorySearch(true);
		e.preventDefault();
		return true;
	}
	if (e.key === 'Enter') {
		// Ctrl+R, a few characters, Enter — re-running an earlier prompt is the
		// whole point of the search, so Enter accepts and sends.
		const send = !e.shiftKey;
		endHistorySearch(true);
		e.preventDefault();
		if (send) { sendMessage(); }
		return true;
	}
	if (e.key === 'Backspace') {
		e.preventDefault();
		// Backspace with nothing typed leaves the search, as it does in the CLI.
		if (!state.pattern) { endHistorySearch(false); } else { setHistorySearchPattern(state.pattern.slice(0, -1)); }
		return true;
	}
	if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
		e.preventDefault();
		setHistorySearchPattern(state.pattern + e.key);
		return true;
	}
	// Anything else — an arrow, a readline chord — ends the search, keeps what it
	// found, and goes on to do what it normally does.
	endHistorySearch(true);
	return false;
}

// ---------- File / image attachments (Step 8 / Section 3.4) ----------
const attachments = []; // { kind: 'file'|'image', name, path?, dataUrl? }
const imagePreviewCache = new Map(); // path -> dataUrl

function renderAttachments() {
	if (!attachmentsHost) { return; }
	if (!attachments.length) { attachmentsHost.innerHTML = ''; attachmentsHost.classList.add('hidden'); return; }
	attachmentsHost.classList.remove('hidden');
	attachmentsHost.innerHTML = attachments.map((a, i) => `
		<span class="attachment-chip ${a.kind === 'image' ? 'attachment-chip-image' : ''}" data-idx="${i}" data-path="${escapeAttr(a.path || '')}" data-data-url="${escapeAttr(a.dataUrl || '')}">
			<span class="attachment-kind">${a.kind === 'image' ? '🖼' : '📄'}</span>
			<span class="attachment-name">${escapeHtml(a.name)}</span>
			<button class="attachment-remove" data-idx="${i}" aria-label="Remove attachment">×</button>
		</span>
	`).join('');
	attachmentsHost.querySelectorAll('.attachment-remove').forEach(btn => btn.addEventListener('click', (e) => {
		attachments.splice(Number(e.currentTarget.dataset.idx), 1);
		renderAttachments();
	}));
	// Wire hover previews for image attachments
	attachmentsHost.querySelectorAll('.attachment-chip-image').forEach(chip => {
		chip.addEventListener('mouseenter', () => requestImagePreview(chip));
	});
}

function requestImagePreview(chip) {
	const path = chip.dataset.path;
	const dataUrl = chip.dataset.dataUrl;
	if (dataUrl) {
		showImagePreview(chip, dataUrl);
	} else if (path) {
		if (imagePreviewCache.has(path)) {
			showImagePreview(chip, imagePreviewCache.get(path));
		} else {
			vscode.postMessage({ type: 'resolveImagePreview', payload: { path } });
		}
	}
}

function applyImagePreview(path, dataUrl) {
	imagePreviewCache.set(path, dataUrl);
	// Find the chip currently hovered (if any) and show the preview
	const chip = document.querySelector(`.attachment-chip-image[data-path="${CSS.escape(path)}"]:hover`);
	if (chip) {
		showImagePreview(chip, dataUrl);
	}
}

function showImagePreview(chip, dataUrl) {
	// Remove any existing preview
	document.querySelectorAll('.attachment-preview-popup').forEach(el => el.remove());
	const popup = document.createElement('div');
	popup.className = 'attachment-preview-popup';
	popup.innerHTML = `<img src="${escapeAttr(dataUrl)}" alt="Preview">`;
	document.body.appendChild(popup);
	const rect = chip.getBoundingClientRect();
	popup.style.left = `${rect.left}px`;
	popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
	const removePreview = () => popup.remove();
	chip.addEventListener('mouseleave', removePreview, { once: true });
	popup.addEventListener('mouseenter', () => {
		chip.removeEventListener('mouseleave', removePreview);
		popup.addEventListener('mouseleave', removePreview, { once: true });
	});
}

function attachFiles(paths) {
	for (const p of paths) {
		// The same path can arrive from a picker and an @-mention; attach it once.
		if (attachments.some(a => a.path === p)) { continue; }
		const image = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
		attachments.push({ kind: image ? 'image' : 'file', name: p.split(/[\\/]/).pop(), path: p });
	}
	renderAttachments();
}

function attachDataUrl(name, dataUrl) {
	const image = dataUrl.startsWith('data:image/');
	attachments.push({ kind: image ? 'image' : 'file', name, dataUrl });
	renderAttachments();
}

// ---------- Composer editing engine (Step 8 / Sections 3.4, 3.13) ----------
// The readline layer (kill ring, word motions, Ctrl/Alt bindings) and the vim
// state machine live in media/input.js, which is DOM-free: it asks this host for
// the composer text and caret and hands back the text and caret it wants. The
// code below is the only part that touches the textarea.

let vimEnabled = false;
let vimMode = 'insert'; // 'insert' | 'normal' | 'visual'
let vimStatus = null;   // pending operator/count/search text, shown after the mode

const composerEditor = window.CodeMindInput.createEditor({
	getText: () => inputEl.value,
	getOffset: () => inputEl.selectionStart,
	getSelectionEnd: () => inputEl.selectionEnd,
	hasSelection: () => inputEl.selectionStart !== inputEl.selectionEnd,
	isBusy: () => isBusy,
	apply(text, offset) {
		inputEl.value = text;
		const pos = Math.max(0, Math.min(offset, text.length));
		inputEl.setSelectionRange(pos, pos);
		handleInput();
	},
	setCaret(start, end) {
		const max = inputEl.value.length;
		inputEl.setSelectionRange(Math.max(0, Math.min(start, max)), Math.max(0, Math.min(end, max)));
	},
	submit: () => sendMessage(),
	historyUp: () => cycleHistory(-1),
	historyDown: () => cycleHistory(1),
	clearInput: () => clearComposer(),
	notify: (message) => showComposerHint(message),
	stash: () => toggleComposerStash(),
	externalEditor: () => openComposerInEditor(),
	onVimMode(mode) { vimMode = mode; renderVimIndicator(); },
	onVimStatus(status) { vimStatus = status; renderVimIndicator(); },
});
function renderVimIndicator() {
	if (!vimIndicator) { return; }
	if (!vimEnabled) { vimIndicator.classList.add('hidden'); return; }
	vimIndicator.classList.remove('hidden');
	vimIndicator.textContent = vimStatus ? `${vimMode.toUpperCase()} ${vimStatus}` : vimMode.toUpperCase();
	vimIndicator.dataset.mode = vimMode;
}

/** Turn the vim bindings on or off; enabling one starts the composer in NORMAL. */
function setVimEnabled(enabled) {
	vimEnabled = enabled;
	composerEditor.setVimEnabled(enabled);
	renderVimIndicator();
}

function setVimMode(mode) {
	composerEditor.setVimMode(mode);
}

// Transient composer messages, e.g. the CLI's "Press Escape again to clear".
let composerHintTimer = null;

/**
 * Show a line under the composer. Hints auto-hide after two seconds; a `sticky`
 * one stays until something hides it, which is what the reverse history search
 * needs — its prompt is state, not a notification. `kind` adds a `hint-<kind>`
 * class so the search prompt can read as a prompt rather than a warning.
 */
function showComposerHint(message, options) {
	if (!composerHint) { return; }
	composerHint.textContent = message;
	composerHint.classList.remove('hidden');
	composerHint.classList.toggle('hint-search', (options && options.kind) === 'search');
	if (composerHintTimer !== null) { clearTimeout(composerHintTimer); composerHintTimer = null; }
	if (options && options.sticky) { return; }
	composerHintTimer = setTimeout(() => {
		composerHintTimer = null;
		composerHint.classList.add('hidden');
	}, 2000);
}

function hideComposerHint() {
	if (composerHintTimer !== null) { clearTimeout(composerHintTimer); composerHintTimer = null; }
	if (composerHint) { composerHint.classList.add('hidden'); composerHint.classList.remove('hint-search'); }
}

/**
 * Escape twice (or Ctrl+C twice) empties the composer. The text goes into input
 * history first, so Up brings it straight back — as it does in the CLI.
 */
function clearComposer() {
	pushInputHistory(inputEl.value);
	pendingDraft = '';
	inputEl.value = '';
	inputEl.setSelectionRange(0, 0);
	handleInput();
	hideComposerHint();
}

/**
 * Replace the composer text outright — used by the external editor round trip,
 * where the editor is the source of truth. `restoreDraft` cannot serve that: it
 * refuses to overwrite text, which is right for a reload and wrong here.
 */
function setComposerText(text) {
	inputEl.value = text || '';
	handleInput();
	const end = inputEl.value.length;
	inputEl.setSelectionRange(end, end);
}

// ---------- Draft stash (Ctrl+S) ----------
// The CLI parks the current prompt so a quick question can go first, then brings
// it back. The stash is a stack, and it carries the attachment chips with it —
// they are part of the draft even though the composer text does not show them.
const composerStash = [];

function toggleComposerStash() {
	if (inputEl.value.trim() || attachments.length) {
		composerStash.push({
			text: inputEl.value,
			offset: inputEl.selectionStart,
			attachments: attachments.splice(0, attachments.length),
		});
		renderAttachments();
		inputEl.value = '';
		inputEl.setSelectionRange(0, 0);
		handleInput();
		showComposerHint(`Stashed (${composerStash.length}). Ctrl+S restores.`);
		return true;
	}
	const entry = composerStash.pop();
	if (!entry) {
		showComposerHint('Nothing stashed.');
		return true;
	}
	inputEl.value = entry.text;
	handleInput();
	const pos = Math.max(0, Math.min(entry.offset, entry.text.length));
	inputEl.setSelectionRange(pos, pos);
	if (entry.attachments.length) {
		attachments.push(...entry.attachments);
		renderAttachments();
	}
	showComposerHint(composerStash.length ? `Restored. ${composerStash.length} still stashed.` : 'Restored.');
	return true;
}

/**
 * Hand the prompt to a real editor (Ctrl+G, Ctrl+X Ctrl+E). The pane opens an
 * untitled buffer and streams every edit back as `composerText`, so unlike the
 * CLI's temp-file round trip nothing blocks and nothing touches disk.
 */
function openComposerInEditor() {
	vscode.postMessage({ type: 'editComposerInEditor', payload: { text: inputEl.value } });
	return true;
}

// ---------- Slash command autocomplete (Section 2.3) ----------
let commandList = [];
let slashOpen = false;
let slashFiltered = [];
let slashIndex = 0;
/** Offset of the `/` the open menu is completing. */
let slashStart = 0;

/**
 * Rank a command against what has been typed, mirroring the CLI's tiers: exact
 * name, exact alias, name prefix, alias prefix, name-part prefix, substring in
 * the name, then substring in the description. Lower is better; `undefined`
 * means no match. A hidden command only ever answers to its exact name or alias.
 */
function scoreCommand(command, query) {
	const name = command.name.toLowerCase();
	const aliases = (command.aliases || []).map(a => a.toLowerCase());
	if (!query) { return command.hidden ? undefined : 6; }
	if (name === query) { return 0; }
	if (aliases.indexOf(query) >= 0) { return 1; }
	if (command.hidden) { return undefined; }
	if (name.startsWith(query)) { return 2; }
	if (aliases.some(a => a.startsWith(query))) { return 3; }
	// `/review` should reach `/security-review`, so every `-`, `_` or `:` starts
	// a new place to match from.
	if (name.split(/[-_:]/).some(part => part.startsWith(query))) { return 4; }
	if (name.indexOf(query) >= 0) { return 5; }
	if ((command.description || '').toLowerCase().indexOf(query) >= 0) { return 7; }
	return undefined;
}

/** The alias that explains why a command matched, rendered in parentheses. */
function matchedAlias(command, query) {
	if (!query) { return ''; }
	return (command.aliases || []).find(a => a.toLowerCase().startsWith(query)) || '';
}

function updateSlashMenu() {
	if (!slashMenu) { return; }
	// The menu follows the caret, so `fix this /rev` completes as well — the CLI
	// does the same. Whitespace after the name closes it again, which is what
	// makes `/model ` mean "this one takes arguments".
	const caret = inputEl.selectionStart === null ? inputEl.value.length : inputEl.selectionStart;
	const upToCaret = inputEl.value.slice(0, caret);
	const match = /(^|\s)\/([\w:-]*)$/.exec(upToCaret);
	if (!match || !commandList.length) { closeSlashMenu(); return; }
	const query = match[2].toLowerCase();
	slashStart = upToCaret.length - match[2].length - 1;
	slashFiltered = commandList
		.map(c => ({ command: c, score: scoreCommand(c, query) }))
		.filter(entry => entry.score !== undefined)
		.sort((a, b) => (a.score - b.score)
			// With nothing typed the CLI lists alphabetically; once there is a query,
			// the shorter of two equally good matches is the likelier one.
			|| (query ? a.command.name.length - b.command.name.length : 0)
			|| a.command.name.localeCompare(b.command.name))
		.map(entry => Object.assign({}, entry.command, { alias: matchedAlias(entry.command, query) }));
	if (!slashFiltered.length) { closeSlashMenu(); return; }
	slashIndex = 0;
	slashOpen = true;
	renderSlashMenu();
}

function renderSlashMenu() {
	// Section 6.9: the rows stagger in on the opening render only. Both of these menus rebuild
	// their whole list on every keystroke and every arrow key, and a fade replayed on each of
	// those would read as a flicker rather than as an entrance.
	slashMenu.classList.toggle('cm-rows-in', slashMenu.classList.contains('hidden'));
	slashMenu.classList.remove('hidden');
	slashMenu.innerHTML = slashFiltered.map((c, i) => `
		<div class="slash-item${i === slashIndex ? ' selected' : ''}" data-idx="${i}">
			<span class="slash-name">/${escapeHtml(c.name)}${c.alias ? ` <span class="slash-alias">(${escapeHtml(c.alias)})</span>` : ''}</span>
			${c.args ? `<span class="slash-args">${escapeHtml(c.args)}</span>` : ''}
			<span class="slash-desc">${escapeHtml(c.description)}</span>
		</div>
	`).join('');
	slashMenu.querySelectorAll('.slash-item').forEach(el => {
		el.addEventListener('mousedown', (ev) => {
			ev.preventDefault();
			slashIndex = Number(el.dataset.idx);
			acceptSlashSelection(true);
		});
	});
	// Rebuilding the markup resets the scroller, so pull the selection back into
	// view — with ~75 commands the list is taller than the menu.
	const selected = slashMenu.querySelector('.slash-item.selected');
	if (selected) { selected.scrollIntoView({ block: 'nearest' }); }
}

function moveSlashSelection(delta) {
	slashIndex = (slashIndex + delta + slashFiltered.length) % slashFiltered.length;
	renderSlashMenu();
}

/** Complete the selected command; `run` also submits it immediately. */
function acceptSlashSelection(run) {
	const command = slashFiltered[slashIndex];
	const start = slashStart;
	const caret = inputEl.selectionStart === null ? inputEl.value.length : inputEl.selectionStart;
	const before = inputEl.value.slice(0, start);
	const after = inputEl.value.slice(caret);
	closeSlashMenu();
	if (!command) { return; }
	// The CLI submits on Enter even for a command that takes arguments — running it
	// bare is how you ask what those arguments are. Only do that for a command that
	// is the whole message, though; mid-sentence completion just completes.
	if (run && start === 0 && !after.trim()) {
		inputEl.value = `/${command.name}`;
		sendMessage();
		return;
	}
	inputEl.value = `${before}/${command.name} ${after}`;
	const position = before.length + command.name.length + 2;
	inputEl.setSelectionRange(position, position);
	handleInput();
	inputEl.focus();
	showSlashArgsHint(command);
}

function closeSlashMenu() {
	slashOpen = false;
	slashFiltered = [];
	if (slashMenu) { slashMenu.classList.add('hidden'); slashMenu.innerHTML = ''; }
}

/**
 * Show what a just-completed command expects, the way the CLI paints its dim
 * argument hint. It lives in the input footer rather than inside the textarea,
 * which cannot hold ghost text.
 */
function showSlashArgsHint(command) {
	if (!slashHintEl) { return; }
	slashHintEl.textContent = command && command.args ? `/${command.name} ${command.args}` : '';
	slashHintEl.classList.toggle('hidden', !(command && command.args));
}

/** Drop the argument hint once the input no longer starts with that command. */
function syncSlashArgsHint() {
	if (!slashHintEl || slashHintEl.classList.contains('hidden')) { return; }
	const expected = slashHintEl.textContent.split(' ')[0];
	if (!inputEl.value.startsWith(`${expected} `) && inputEl.value !== expected) {
		showSlashArgsHint(undefined);
	}
}

// ---------- @-mention file autocomplete (Section 3.4) ----------
// The workbench owns the file index, so typing `@foo` posts a query and the
// reply arrives as `mentionItems`. `mentionQuery` guards against a stale reply
// overwriting the menu after the user has typed on. Now debounced (300ms) and
// cancels stale backend searches via requestId.
let mentionOpen = false;
let mentionItems = [];
let mentionIndex = 0;
let mentionQuery = null;
/** Caret offset of the `@` that opened the menu, so accept can splice exactly. */
let mentionStart = -1;
let mentionRequestId = 0;
let mentionDebounceTimer = null;

function updateMentionMenu() {
	if (!mentionMenu) { return; }
	const caret = inputEl.selectionStart;
	const before = inputEl.value.slice(0, caret);
	// An `@` at the start or after whitespace, followed by a path fragment with
	// no spaces. Anything else (an email, a decorator) must not open the menu.
	const match = /(^|\s)@([^\s@]*)$/.exec(before);
	if (!match) { closeMentionMenu(); return; }
	mentionStart = caret - match[2].length - 1;
	mentionQuery = match[2];

	// Debounce: wait 300ms before posting the request
	clearTimeout(mentionDebounceTimer);
	mentionDebounceTimer = setTimeout(() => {
		const reqId = String(++mentionRequestId);
		vscode.postMessage({ type: 'requestMentionItems', payload: { query: mentionQuery, requestId: reqId } });
	}, 300);
}

function showMentionMenu(items, query, requestId) {
	// A reply for a query the user has already moved past is dropped — otherwise the
	// unfiltered list from `@` can land after the list for `@gulpfile` and the next
	// Enter accepts a file nobody was looking at.
	if (mentionQuery === null) { return; }
	if (query !== undefined && query !== mentionQuery) { return; }
	if (requestId !== undefined && requestId !== String(mentionRequestId)) { return; }
	mentionItems = items;
	if (!mentionItems.length) { closeMentionMenu(); return; }
	mentionIndex = 0;
	mentionOpen = true;
	renderMentionMenu();
}

function renderMentionMenu() {
	// The opening render staggers its rows; a redraw while open does not (Section 6.9).
	mentionMenu.classList.toggle('cm-rows-in', mentionMenu.classList.contains('hidden'));
	mentionMenu.classList.remove('hidden');
	mentionMenu.innerHTML = mentionItems.map((item, i) => `
		<div class="mention-item${i === mentionIndex ? ' selected' : ''}" data-idx="${i}">
			<span class="mention-name">${escapeHtml(item.label)}</span>
			${item.detail ? `<span class="mention-detail">${escapeHtml(item.detail)}</span>` : ''}
		</div>
	`).join('');
	mentionMenu.querySelectorAll('.mention-item').forEach(el => {
		el.addEventListener('mousedown', (ev) => {
			ev.preventDefault();
			mentionIndex = Number(el.dataset.idx);
			acceptMentionSelection();
		});
	});
	const selected = mentionMenu.querySelector('.mention-item.selected');
	if (selected) { selected.scrollIntoView({ block: 'nearest' }); }
}

function moveMentionSelection(delta) {
	mentionIndex = (mentionIndex + delta + mentionItems.length) % mentionItems.length;
	renderMentionMenu();
}

/**
 * Replace the `@fragment` with the picked path and attach the file, so the
 * agent gets the contents as well as the reference in the prompt.
 */
function acceptMentionSelection() {
	const item = mentionItems[mentionIndex];
	const start = mentionStart;
	const caret = inputEl.selectionStart;
	closeMentionMenu();
	if (!item || start < 0) { return; }
	// `detail` is the workspace-relative path and `label` only the basename, so
	// prefer detail — an unqualified name would be ambiguous to the agent.
	const inserted = `@${item.detail || item.label} `;
	inputEl.value = inputEl.value.slice(0, start) + inserted + inputEl.value.slice(caret);
	const pos = start + inserted.length;
	inputEl.setSelectionRange(pos, pos);
	if (item.path) { attachFiles([item.path]); }
	handleInput();
	inputEl.focus();
}

function closeMentionMenu() {
	mentionOpen = false;
	mentionItems = [];
	mentionQuery = null;
	mentionStart = -1;
	clearTimeout(mentionDebounceTimer);
	if (String(mentionRequestId)) {
		vscode.postMessage({ type: 'cancelMentionRequest', payload: { requestId: String(mentionRequestId) } });
	}
	if (mentionMenu) { mentionMenu.classList.add('hidden'); mentionMenu.innerHTML = ''; }
}

// ---------- Settings pushed from the workbench ----------

/**
 * Put the model on the pill (Section 2.2). The pill is short by design, so the id it
 * stands for stays available in the tooltip.
 */
function setModelLabel(model) {
	currentModel = String(model || '');
	if (!modelPill) { return; }
	modelPill.textContent = modelDisplayName(currentModel);
	modelPill.title = currentModel ? `Model for new turns — ${currentModel}` : 'Model for new turns';
	// An open menu is showing a checkmark that has just moved.
	if (modelMenuOpen) { renderModelMenu(); }
}

/**
 * Apply the part of `settingsData` the chat surface owns: vim, and the mode selector.
 * The mic needs the engine's voice capability as well as the user setting, so it stays
 * driven by `featureFlags`, which the pane computes from both.
 *
 * Vim is moved only when it actually differs — otherwise a settings refresh
 * mid-edit would drop the user out of normal mode.
 */
function applyPanelSettings(settings) {
	if (typeof settings.vimMode === 'boolean' && settings.vimMode !== vimEnabled) {
		setVimEnabled(settings.vimMode);
	}
	if (typeof settings.permissionMode === 'string') {
		applyPermissionModeToSelector(settings.permissionMode);
	}
}

// ---------- Plan mode (Section 3.6) ----------
let planMode = false;

function setPlanMode(on) {
	planMode = on;
	// The body class is the whole of plan mode's presence in the panel now that Section 3.1 has
	// taken the toggle out of the header and Section 2.3 has replaced the banner: it is what
	// puts the modified-file edge on the input strip.
	document.body.classList.toggle('plan-mode', on);
	// The pill shows plan mode too, so it follows the pane's own word rather than waiting
	// for the settings echo behind it. Leaving plan mode only moves the pill when it is
	// still showing Plan — a click that chose Edit has already moved it.
	if (on) { applyModeSelection('plan'); }
	else if (currentMode === 'plan') { applyModeSelection('default'); }
	vscode.postMessage({ type: 'setPlanMode', payload: { enabled: on } });
}

// ---------- Session name / tags (/rename, /tag) ----------
function applySessionName(payload) {
	const name = (payload.name || '').trim();
	if (sessionNameEl) {
		sessionNameEl.textContent = name;
		sessionNameEl.classList.toggle('hidden', !name);
	}
	const tags = Array.isArray(payload.tags) ? payload.tags.filter(Boolean) : [];
	if (sessionTagsEl) {
		sessionTagsEl.textContent = tags.map(t => `#${t}`).join(' ');
		sessionTagsEl.classList.toggle('hidden', !tags.length);
	}
}

// ---------- Prompt colour (/color) ----------
// The colour names the CLI offers map onto theme variables, so the accent still
// follows the user's theme. An unknown or empty name clears the override.
const PROMPT_COLORS = {
	red: 'var(--vscode-terminal-ansiRed)',
	blue: 'var(--vscode-terminal-ansiBlue)',
	green: 'var(--vscode-terminal-ansiGreen)',
	yellow: 'var(--vscode-terminal-ansiYellow)',
	purple: 'var(--vscode-charts-purple)',
	orange: 'var(--vscode-charts-orange)',
	pink: 'var(--vscode-terminal-ansiBrightMagenta)',
	cyan: 'var(--vscode-terminal-ansiCyan)'
};

function applyPromptColor(color) {
	const value = PROMPT_COLORS[String(color).toLowerCase()];
	// `--cm-accent` drives the prompt border, focus ring, prompt icon and user
	// bubble tint, so overriding it recolours the whole prompt bar at once. It has
	// to go on the root element: `--cm-accent-soft` and friends are declared in
	// `:root` via color-mix, so they only pick the override up there.
	const root = document.documentElement;
	if (value) {
		root.style.setProperty('--cm-accent', value);
	} else {
		root.style.removeProperty('--cm-accent');
	}
	if (sessionNameEl) {
		sessionNameEl.classList.toggle('accented', !!value);
	}
}

// ---------- Session token total (Section 1.4) ----------
/**
 * One line under the composer: how many tokens this session has spent, in thousands, to one
 * decimal. Not per message, not split into in and out, and never while a turn is streaming —
 * a counter that climbs mid-answer is something to watch instead of read. Its line is always
 * the same height, so writing into it cannot move the composer.
 */
function updateSessionTokens() {
	if (!sessionTokensEl) { return; }
	const total = (sessionTotals.inputTokens || 0) + (sessionTotals.outputTokens || 0);
	sessionTokensEl.textContent = total > 0 ? `↑${(total / 1000).toFixed(1)}k tokens this session` : '';
}

/**
 * The pane's own running total, which arrives with each result. Cost is cumulative there and
 * usage is per turn, so only the cost is taken from it — the tokens on screen are the ones
 * counted turn by turn in `streamEnd`, which is what "this session" means here.
 */
function applySessionCost(payload) {
	if (!payload) { return; }
	if (payload.totalCostUsd != null) { sessionTotals.totalCostUsd = payload.totalCostUsd; }
	if (payload.model) { sessionTotals.model = payload.model; }
}

// ---------- Context window meter ----------
/**
 * Show how full the model's context window is.
 *
 * Below the warning threshold this is a quiet bar and a percentage — the CLI has
 * no room for one and says nothing until it matters, but a panel does. From the
 * warning threshold up it becomes the CLI's own sentence, so the wording a user
 * has learned in the terminal is the wording they get here.
 */
function updateContextMeter(status) {
	if (!contextMeterEl) { return; }
	if (!status) {
		contextMeterEl.classList.add('hidden');
		return;
	}
	contextMeterEl.classList.remove('hidden');
	contextMeterEl.classList.toggle('is-warning', status.level === 'warning');
	contextMeterEl.classList.toggle('is-blocked', status.level === 'blocked');
	if (contextBarFillEl) {
		contextBarFillEl.style.width = `${status.percentUsed}%`;
	}
	if (contextTextEl) {
		contextTextEl.textContent = status.level === 'ok'
			? `${status.percentUsed}%`
			: (status.autoCompactEnabled
				? `${status.percentLeft}% until auto-compact`
				: `Context low (${status.percentLeft}% remaining) · /compact to continue`);
	}
	contextMeterEl.title = [
		`${formatTokens(status.usedTokens)} of ${formatTokens(status.contextWindow)} tokens used (${status.percentUsed}%).`,
		status.autoCompactEnabled
			? `The conversation is summarised automatically at ${formatTokens(status.threshold)}.`
			: 'Auto-compaction is off; turns fail once the window is full.',
		'Click to compact now.',
	].join('\n');
}

contextMeterEl?.addEventListener('click', () => {
	vscode.postMessage({ type: 'runCommand', payload: { name: 'compact', args: '' } });
});

// ---------- Feature flags (Section 3.18) ----------
let featureFlags = {};

function applyFeatureFlags() {
	// The mic button is intentionally always visible; the voice logic behind it
	// is wired directly in wirePanelChrome and does not depend on the flag.
}

// ---------- Voice input (Section 3.18) ----------
let recognition = null;
let recording = false;

function toggleVoiceInput() {
	const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!Recognition) {
		appendLocalSystemMessage('Speech recognition is not available in this webview.');
		return;
	}
	if (recording) {
		recognition?.stop();
		return;
	}
	recognition = new Recognition();
	recognition.continuous = true;
	recognition.interimResults = true;
	recognition.lang = navigator.language || 'en-US';
	const base = inputEl.value;
	recognition.onresult = (event) => {
		let transcript = '';
		for (let i = event.resultIndex; i < event.results.length; i++) {
			transcript += event.results[i][0].transcript;
		}
		inputEl.value = base + transcript;
		handleInput();
	};
	recognition.onend = () => {
		recording = false;
		micBtn?.classList.remove('recording');
	};
	recognition.onerror = () => {
		recording = false;
		micBtn?.classList.remove('recording');
	};
	recognition.start();
	recording = true;
	micBtn?.classList.add('recording');
}

/** Render a local-only system note without a round trip to the workbench. */
function appendLocalSystemMessage(text) {
	const id = `local-${Date.now()}`;
	markEntering(id);
	messages.push({ id, type: 'system', content: text, timestamp: Date.now() });
	renderMessages();
}

// ---------- Status ----------
function setStatus(newStatus) {
	status = newStatus;
	statusDot.className = 'status-dot ' + newStatus;
	// Idle is silent: only show text while working or on error.
	statusText.textContent = newStatus === 'busy' ? 'Thinking…'
		: newStatus === 'error' ? 'Error'
			: '';
	isBusy = newStatus === 'busy';
	// The line above has just said what is happening, so a pending "still
	// connecting" must not land on top of it.
	if (!isBusy) { cancelFirstTokenDeadline(); }
	// Send and stop share one 28px slot and cross-fade between them (Section 2.4);
	// which of the two is showing is this class and nothing else.
	if (sendSlot) { sendSlot.classList.toggle('is-streaming', isBusy); }
	sendBtn.disabled = isBusy || !inputEl.value.trim();
	sendBtn.title = isBusy ? 'Queue message with Enter (sent when this turn ends)' : 'Send message';
	// The turn that was holding the queue back has finished.
	if (!isBusy) { drainPromptQueue(); }
	// This is the only place that knows a turn started or ended, so it is the only place
	// that can tell Aristotle to stretch or to settle back down. He debounces it himself:
	// auto-compaction posts busy → ready → busy → ready around some turns.
	if (window.CodeMindAristotle) { window.CodeMindAristotle.setBusy(isBusy); }
}

/**
 * How long a turn may produce nothing at all before the status line stops saying
 * "Thinking…" and says what is really going on.
 *
 * A refused key or an unreachable endpoint is not reported to us quickly: the
 * engine retries inside its own process for minutes before it gives up and sends
 * back the API's complaint. "Thinking…" for that long reads as a hung panel, and
 * it points at the wrong thing — the model is not slow, the request never got
 * through. Naming the endpoint is the hint that matters, because the usual cause
 * is a custom one that is wrong.
 */
const FIRST_TOKEN_DEADLINE_MS = 30000;
let firstTokenTimer = null;
let firstTokenEndpoint = '';

/** Start the wait for a turn's first sign of life. */
function armFirstTokenDeadline(endpoint) {
	cancelFirstTokenDeadline();
	firstTokenEndpoint = endpoint || '';
	firstTokenTimer = setTimeout(() => {
		firstTokenTimer = null;
		// A turn that has since answered, failed or been stopped has already put the
		// right text in the status line.
		if (!isBusy) { return; }
		statusText.textContent = firstTokenEndpoint
			? `Still connecting to ${firstTokenEndpoint}…`
			: 'Still connecting to endpoint…';
	}, FIRST_TOKEN_DEADLINE_MS);
}

/**
 * Something arrived — text, reasoning, a tool call or the failure itself — so the
 * connection is up. Puts the ordinary spinner text back if the deadline had
 * already replaced it.
 */
function noteFirstToken() {
	cancelFirstTokenDeadline();
	if (isBusy && statusText.textContent !== 'Thinking…') {
		statusText.textContent = 'Thinking…';
	}
}

function cancelFirstTokenDeadline() {
	if (firstTokenTimer !== null) {
		clearTimeout(firstTokenTimer);
		firstTokenTimer = null;
	}
}

// ---------- Messages ----------
/** Mark a message as newly arrived, so the next render lets it rise into place (Section 6.1). */
function markEntering(id) {
	if (id) { enterQueue.add(id); }
}

function addOrUpdateMessage(message) {
	const idx = messages.findIndex(m => m.id === message.id);
	if (idx >= 0) {
		messages[idx] = message;
	} else {
		// Only a message that was not already in the transcript is arriving.
		markEntering(message.id);
		messages.push(message);
	}
	renderMessages();
	scrollToBottom();
}

function startStreamingMessage(payload) {
	streamingMessageId = payload.id;
	streamScratch.set(payload.id, { thinking: '', tools: new Map(), model: payload.metadata?.model, meta: payload.metadata });
	const message = {
		id: payload.id,
		type: 'assistant',
		content: '',
		timestamp: Date.now(),
		intent: payload.intent,
		metadata: payload.metadata,
		streaming: true
	};
	markEntering(payload.id);
	messages.push(message);
	armFirstTokenDeadline(payload.endpoint);
	renderMessages();
}

function applyStreamMeta(payload) {
	const scratch = streamScratch.get(payload.id);
	if (!scratch) return;
	if (payload.model) { scratch.model = payload.model; }
	const msg = messages.find(m => m.id === payload.id);
	if (msg) {
		msg.metadata = { ...(msg.metadata || {}), model: payload.model || msg.metadata?.model };
		if (payload.model) { setModelLabel(payload.model); }
	}
	scheduleRender();
}

function appendStreamingDelta(payload) {
	if (streamingMessageId !== payload.id) { streamingMessageId = payload.id; }
	const message = messages.find(m => m.id === payload.id);
	if (!message) return;
	noteFirstToken();
	const delta = payload.content || '';
	message.content += delta;
	// Section 5: the delta is appended to the text node that is already on screen, so
	// nothing above it is redrawn and nothing already laid out moves.
	if (!appendLiveText(payload.id, delta)) { renderMessages(); }
}

/**
 * This turn is a failure, not an answer: the engine could not reach the model. The
 * bubble that was opened for the answer becomes the error in place, so the panel
 * never shows the API's complaint as though the model had said it.
 */
function markStreamError(payload) {
	noteFirstToken();
	const message = messages.find(m => m.id === payload.id);
	if (!message) { return; }
	message.type = 'error';
	message.content = payload.content || '';
	// Nothing more is coming, so drop the caret even though `streamEnd` is still on
	// its way.
	message.streaming = false;
	renderMessages();
}

function appendThinkingDelta(payload) {
	const scratch = streamScratch.get(payload.id) || { thinking: '', tools: new Map() };
	streamScratch.set(payload.id, scratch);
	noteFirstToken();
	const delta = payload.content || '';
	// Section 4.2's duration label. The clock runs from the first reasoning token to the
	// last one, which is the part of the turn this block actually accounts for; it stops
	// on its own when the tokens stop, with no second event to listen for.
	if (!scratch.thinkStart) { scratch.thinkStart = Date.now(); }
	scratch.thinkEnd = Date.now();
	scratch.thinking += delta;
	// Reasoning is never markdown-parsed (Section 5), so the whole block is one text node
	// from its first token and a delta is only ever one `appendData`. The first delta is
	// the exception: the block it belongs in does not exist until a render draws it.
	const live = liveEntry(payload.id);
	if (live && live.thinkingNode) {
		if (delta) { live.thinkingNode.appendData(delta); }
	} else {
		renderMessages();
	}
}

function upsertTool(payload) {
	const scratch = streamScratch.get(payload.streamId) || { thinking: '', tools: new Map() };
	streamScratch.set(payload.streamId, scratch);
	noteFirstToken();
	// A result with no id would open a card of its own and leave the call it answers
	// spinning for ever. When exactly one call of this turn is still running, it is the
	// one the result belongs to.
	let toolId = payload.id;
	if (!toolId) {
		const running = Array.from(scratch.tools.entries()).filter(([, t]) => t.status === 'running');
		if (running.length !== 1) { return; }
		toolId = running[0][0];
	}
	const existing = scratch.tools.get(toolId) || {};
	const startedAt = existing.startedAt || (payload.status === 'running' ? Date.now() : existing.startedAt);
	scratch.tools.set(toolId, {
		...existing,
		toolName: payload.toolName || existing.toolName,
		input: payload.input !== undefined ? payload.input : existing.input,
		partialJson: existing.partialJson,
		result: payload.result !== undefined ? payload.result : existing.result,
		isError: payload.isError,
		status: payload.status,
		startedAt,
		// Sub-agent calls carry the Task tool that spawned them, so the card can
		// be drawn inside that Task instead of alongside it.
		parentId: payload.parentId || existing.parentId,
	});
	syncBackgroundTask(toolId, scratch.tools.get(toolId));
	// Section 5: a burst of tool events is one redraw on the next frame, not one each.
	scheduleRender();
}

/** A sub-agent's own prose, shown inside the Task card that owns it. */
function appendAgentText(payload) {
	const scratch = streamScratch.get(payload.streamId);
	if (!scratch) { return; }
	const tool = scratch.tools.get(payload.parentId);
	if (!tool) { return; }
	tool.agentText = payload.text;
	scheduleRender();
}

function updateToolInput(payload) {
	const scratch = streamScratch.get(payload.streamId);
	if (!scratch) return;
	const tool = scratch.tools.get(payload.id);
	if (tool) {
		tool.partialJson = payload.partialJson;
		scheduleRender();
	}
}

function finishStreamingMessage(payload) {
	cancelFirstTokenDeadline();
	const message = messages.find(m => m.id === payload.id);
	if (message) {
		message.streaming = false;
		if (payload?.metadata) {
			message.metadata = { ...(message.metadata || {}), ...payload.metadata };
		}
	}
	// Roll the result metadata into the session's running totals. Cost, the per-turn split and
	// the model are still tracked here — `/cost` and `/usage` answer from the engine, and the
	// panel keeps its own copy — but the only one of them that reaches the screen is the token
	// sum on the line under the composer (Section 1.4), written once a turn has ended.
	const meta = payload?.metadata;
	if (meta) {
		if (meta.costUsd != null) { sessionTotals.totalCostUsd += meta.costUsd; }
		if (meta.usage?.inputTokens != null) { sessionTotals.inputTokens += meta.usage.inputTokens; }
		if (meta.usage?.outputTokens != null) { sessionTotals.outputTokens += meta.usage.outputTokens; }
		sessionTotals.durationMs = meta.durationMs ?? sessionTotals.durationMs;
		sessionTotals.model = meta.model || sessionTotals.model;
		updateSessionTokens();
	}
	streamingMessageId = null;
	renderMessages();
}

// Running session totals, reset by newSession.
const sessionTotals = { totalCostUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: null, model: undefined };

// ---------- Rendering ----------
// Section 5. A full render is for structural change only — a message arriving, a tool
// card changing state, a transcript being replaced. Text and reasoning deltas never
// come through here; they append to a text node that is already on screen.

// Above this many bubbles the transcript is windowed: only the newest are real DOM,
// the rest are one spacer div of the same height. A long session otherwise pays for
// every bubble it has ever drawn on every structural render.
const WINDOW_THRESHOLD = 80;
const WINDOW_INITIAL = 40;
const WINDOW_STEP = 20;
// What an unmeasured bubble is assumed to be worth. Only reached for messages that
// were never on screen in this panel — a restored transcript, before any scroll.
const BUBBLE_HEIGHT_FALLBACK = 60;
let windowCount = WINDOW_INITIAL;
// Last measured height per message id, which is what makes the spacer the size of the
// content it stands in for rather than a guess.
const bubbleHeights = new Map();
let sentinelObserver = null;
let renderFrame = 0;

/**
 * Coalesce structural redraws into one frame. Tool events arrive in bursts — a call,
 * its streamed input, its progress ticks and its result can all land inside a single
 * frame — and each one used to rebuild the whole transcript on its own.
 */
function scheduleRender() {
	if (renderFrame) { return; }
	renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderMessages(); });
}

function renderMessages() {
	// A synchronous render satisfies whatever the pending frame was going to draw.
	if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
	if (!messages.length) {
		domIndex.clear();
		bubbleHeights.clear();
		renderEmptyState();
		return;
	}

	const total = messages.length;
	// `windowCount` only ever grows, so a transcript that has been scrolled back through
	// stays scrolled back through across the renders that follow.
	const keep = total > WINDOW_THRESHOLD ? Math.min(total, Math.max(windowCount, WINDOW_INITIAL)) : total;
	const start = total - keep;
	let html = '';
	if (start > 0) {
		html += `<div class="thread-spacer" style="height:${hiddenHeight(start)}px" aria-hidden="true"></div>`;
		html += '<div class="thread-sentinel" aria-hidden="true"></div>';
	}
	for (let i = start; i < total; i++) { html += renderMessage(messages[i]); }
	messagesEl.innerHTML = html;
	afterRender();
}

/**
 * Everything a freshly drawn transcript needs, in one place: the handlers that live on
 * new DOM, the expand-all state a rebuild throws away, the index the streaming path
 * writes through, the heights the spacer is sized from, and the scroll.
 */
function afterRender() {
	enhanceCodeBlocks();
	enhanceClips();
	enhanceAskOptions();
	// Before `applyTranscriptDetail`, so the expand-all state it pushes on is recorded
	// the same way a click would be.
	enhanceDisclosures();
	// Re-render throws away every `open` attribute, so the expand-all state has to
	// be pushed back on afterwards or Ctrl+O would come undone on the next delta.
	applyTranscriptDetail();
	settleEntering();
	indexMessages();
	observeSentinel();
	followBottom();
}

/**
 * Retire the entry animation (Section 6.1). The id leaves the queue as soon as its bubble has
 * been drawn once, and the class leaves the element when the animation ends — a transform is
 * a containing block for anything positioned inside it, so leaving one on a settled bubble
 * would quietly change what `position: fixed` means for the rest of the session.
 */
function settleEntering() {
	messagesEl.querySelectorAll('.message.cm-message-enter').forEach(el => {
		enterQueue.delete(el.dataset.id);
		el.addEventListener('animationend', () => el.classList.remove('cm-message-enter'), { once: true });
	});
	// Anything still queued was not drawn — windowed out of the live range, or replaced
	// before it ever rendered. It is not arriving now, so it does not stay owed an entry.
	enterQueue.clear();
}

/** The height the bubbles that were left out of the window used to occupy. */
function hiddenHeight(count) {
	let height = 0;
	for (let i = 0; i < count; i++) {
		height += bubbleHeights.get(messages[i].id) || BUBBLE_HEIGHT_FALLBACK;
	}
	return Math.round(height);
}

/**
 * Record where each message is drawing and how tall it came out. The handles are what
 * a delta appends through; the heights are what the spacer is sized from, so they have
 * to be taken while the bubble is still on screen — once it has been windowed out
 * there is nothing left to measure.
 */
function indexMessages() {
	domIndex.clear();
	const measure = messages.length >= WINDOW_INITIAL;
	messagesEl.querySelectorAll('.message').forEach(el => {
		const id = el.dataset.id;
		if (!id) { return; }
		const tailEl = el.querySelector('.stream-tail');
		const thinkingBody = el.querySelector('.thinking-body');
		domIndex.set(id, {
			el,
			blocksEl: el.querySelector('.stream-blocks'),
			tailNode: tailEl ? streamTextNode(tailEl) : null,
			thinkingNode: thinkingBody ? streamTextNode(thinkingBody) : null,
		});
		if (measure) { bubbleHeights.set(id, el.offsetHeight); }
	});
}

/**
 * The single text node a delta is appended to. The markup may have rendered the text
 * already or left the block empty; either way what comes back is one node whose
 * `appendData` is the whole of the write.
 */
function streamTextNode(host) {
	const first = host.firstChild;
	if (first && first.nodeType === 3) { return first; }
	const node = document.createTextNode('');
	host.insertBefore(node, first);
	return node;
}

/** The live handles for one message, or null when it is not on screen. */
function liveEntry(id) {
	const entry = domIndex.get(id);
	if (!entry || !entry.el.isConnected) { return null; }
	return entry;
}

/**
 * Grow the window when the reader reaches the top of it. Both markers are watched: the
 * sentinel line at the boundary between the spacer and the first live bubble, and the
 * spacer itself. The line alone is not enough — a scrollbar dragged to the top lands past
 * it, inside the spacer, and a marker that was never crossed never fires. The spacer is
 * the whole hidden region, so any part of it coming into view asks for more, however the
 * reader got there. Both are new DOM on every render, so the observer is rebuilt too.
 */
function observeSentinel() {
	if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }
	const spacer = messagesEl.querySelector('.thread-spacer');
	const sentinel = messagesEl.querySelector('.thread-sentinel');
	if (!spacer || typeof IntersectionObserver === 'undefined') { return; }
	sentinelObserver = new IntersectionObserver(entries => {
		if (!entries.some(e => e.isIntersecting)) { return; }
		if (windowCount >= messages.length) { return; }
		// Real bubbles are about to replace spacer height, and they are never exactly the
		// height it stood in for. The reader's place is kept from the bottom, which is the
		// edge that does not move.
		const fromBottom = chatScrollEl ? chatScrollEl.scrollHeight - chatScrollEl.scrollTop : 0;
		windowCount += WINDOW_STEP;
		renderMessages();
		if (chatScrollEl) { chatScrollEl.scrollTop = chatScrollEl.scrollHeight - fromBottom; }
	}, { root: chatScrollEl || null, rootMargin: '200px 0px 0px 0px' });
	sentinelObserver.observe(spacer);
	if (sentinel) { sentinelObserver.observe(sentinel); }
}


function renderEmptyState() {
	messagesEl.innerHTML = `
		<div class="empty-state">
			<div class="logo-mark">${LOGO_MARK_SVG}</div>
			<h2>CodeMind Agent</h2>
			<p>Claude Code, rebuilt as a native CodeMind panel. Ask anything about your project.</p>
			<div class="hints">
				${HINTS.map(h => `<button class="hint-chip" data-hint="${escapeAttr(h.hint)}">${escapeHtml(h.label)}</button>`).join('')}
			</div>
		</div>
	`;

	messagesEl.querySelectorAll('.hint-chip').forEach(btn => {
		btn.addEventListener('click', () => {
			inputEl.value = btn.dataset.hint;
			handleInput();
			inputEl.focus();
		});
	});
}

/** The longest a system message can be and still read as a one-line notice. */
const NOTICE_MAX_CHARS = 120;
/** How much of a tool's primary argument the resting row shows (Section 4.3). */
const TOOL_TARGET_CHARS = 40;

function renderMessage(msg) {
	const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const isUser = msg.type === 'user';
	const isAssistant = msg.type === 'assistant';
	const isError = msg.type === 'error';
	const isSystem = msg.type === 'system';
	// Output of a `!` shell-mode line — shown as terminal output, not prose.
	const isShell = msg.type === 'shell';
	// Section 4.1 draws a system message as one quiet centred line with no bubble. That
	// is right for what system messages nearly always are — session start, a compact
	// notice, a mode change — and wrong for the one that is not: the reply to a slash
	// command, which is content the user asked to read. A single short line is a notice;
	// anything longer keeps a readable left-aligned block.
	const isNotice = isSystem && !String(msg.content || '').includes('\n') && String(msg.content || '').length <= NOTICE_MAX_CHARS;

	let avatar;
	if (isUser) avatar = USER_AVATAR_SVG;
	else if (isError) avatar = ERROR_AVATAR_SVG;
	else if (isSystem) avatar = SYSTEM_AVATAR_SVG;
	else if (isShell) avatar = TERMINAL_AVATAR_SVG;
	else avatar = AGENT_AVATAR_SVG;

	const intentLabel = msg.intent && msg.intent.label && msg.intent.id !== 'general'
		? ` <span class="intent">· ${escapeHtml(msg.intent.label)}</span>`
		: '';
	const roleLabel = isUser ? 'You' : isAssistant ? `CodeMind${intentLabel}` : isError ? 'Error' : isSystem ? 'System' : isShell ? 'Shell' : escapeHtml(msg.type);
	// System and error output are shown verbatim (Section 3.17 output styles).
	// A streaming answer is drawn in two halves instead, so a delta can be a single
	// `appendData` call: the markdown blocks that are already complete, parsed once
	// each, and the block still being typed, held raw in one text node (Section 5).
	const liveStream = !!msg.streaming && isAssistant;
	const body = liveStream
		? renderStreamingBody(msg.content)
		: isError || isSystem
			? `<pre class="plain-output">${escapeHtml(msg.content)}</pre>`
			: isShell
				? `<pre class="plain-output is-terminal">${escapeHtml(msg.content)}</pre>`
				: renderMarkdown(msg.content);
	// The caret of a live answer sits inside the tail, at the end of the text; anywhere
	// else it lands on a line of its own once the tail wraps.
	const streamingCursor = msg.streaming && !liveStream ? '<span class="streaming-cursor"></span>' : '';
	// A turn the user stopped keeps the text that had arrived and says so, rather than
	// looking like a complete answer that happens to end mid-sentence.
	const interrupted = msg.metadata && msg.metadata.interrupted
		? '<div class="interrupted-note">[Interrupted]</div>'
		: '';

	// A turn that started normally and then failed keeps its id, so an error bubble
	// can have reasoning and tool cards of its own worth drawing.
	const scratch = isAssistant || isError ? streamScratch.get(msg.id) : undefined;
	const thinking = scratch && scratch.thinking
		? renderThinking(scratch.thinking, msg.streaming, msg.id, thinkingSeconds(scratch))
		: '';
	const tools = scratch && scratch.tools.size ? renderTools(scratch.tools) : '';
	const meta = isAssistant && msg.metadata && !msg.streaming ? renderMeta(msg.metadata) : '';
	// B.2/B.3 – The dev-mode orchestration trace is now shown in a separate window
	// (the Orchestration Trace panel, mirroring Multi-Agent Consensus), not inside the
	// chat bubble. The workbench routes each trace there via pushTrace.

	// Section 6.1: the class is only on the render that first draws a message which arrived
	// in this session, and `settleEntering` takes it off again once the animation has run.
	const entering = enterQueue.has(msg.id) ? ' cm-message-enter' : '';

	return `
		<div class="message ${msg.type}${isNotice ? ' is-notice' : ''}${entering}" data-id="${escapeAttr(msg.id)}">
			<div class="message-avatar" aria-hidden="true">${avatar}</div>
			<div class="message-content">
				<div class="message-header">
					<span class="message-role">${roleLabel}</span>
					<span class="message-time">${time}</span>
				</div>
				${thinking}${tools}
				<div class="message-body">${body}${streamingCursor}</div>
				${interrupted}${meta}
			</div>
		</div>
	`;
}

/**
 * Reasoning, as one 24px row: a triangle, what it is, and how long it took (Section 4.2).
 * The row is the whole block until the reader opens it — the text underneath is an aside
 * about how the answer was reached, not the answer.
 */
function renderThinking(text, streaming, id, seconds) {
	const open = expandedThinking.has(id) ? ' open' : '';
	const label = streaming ? 'Thinking…' : 'Thought process';
	// No duration while it is still running: a number that climbs on every token reads as
	// a stopwatch the reader is meant to watch, and this row is meant to be ignored.
	const elapsed = !streaming && seconds != null
		? `<span class="thinking-elapsed">${seconds < 1 ? '&lt;1' : Math.round(seconds)}s</span>`
		: '';
	return `
		<details class="thinking" data-think="${escapeAttr(id)}"${open}>
			<summary><span class="thinking-label">${label}</span>${elapsed}</summary>
			<div class="thinking-body">${escapeHtml(text)}</div>
		</details>
	`;
}

/** How long reasoning streamed for, or undefined when it never did. */
function thinkingSeconds(scratch) {
	if (!scratch || !scratch.thinkStart) { return undefined; }
	return Math.max(0, (scratch.thinkEnd - scratch.thinkStart) / 1000);
}

// ---------- Streaming text (Section 5) ----------
/**
 * The two halves of a live answer. Everything up to the last completed markdown block
 * is parsed; the remainder is the block still being typed and stays raw, because half a
 * fence or half a table renders as nonsense that would then have to be undone. Called
 * on a full render, so a redraw in the middle of a turn lands on the same split the
 * appending path would have produced.
 */
function renderStreamingBody(text) {
	const cut = lastBlockBoundary(text);
	const done = cut > 0 ? renderMarkdown(text.slice(0, cut)) : '';
	return `<div class="stream-blocks">${done}</div>`
		+ `<div class="stream-tail">${escapeHtml(text.slice(cut))}<span class="streaming-cursor"></span></div>`;
}

/**
 * Where the last complete markdown block ends. A blank line closes a block, unless a
 * fence is open — inside one, blank lines are content. The final line never counts: with
 * no newline after it yet, it is still being typed.
 */
function lastBlockBoundary(text) {
	let cut = 0;
	let pos = 0;
	let fenceOpen = false;
	let nl = text.indexOf('\n');
	while (nl !== -1) {
		const line = text.slice(pos, nl);
		if (/^\s{0,3}```/.test(line)) {
			fenceOpen = !fenceOpen;
			if (!fenceOpen) { cut = nl + 1; }
		} else if (!fenceOpen && !line.trim()) {
			cut = nl + 1;
		}
		pos = nl + 1;
		nl = text.indexOf('\n', pos);
	}
	return cut;
}

/**
 * Write one delta into the live tail, and move whatever block it completed into the
 * parsed half. Returns false when the bubble is not on screen — a transcript that was
 * just replaced, or a message windowed out — so the caller can fall back to a render.
 */
function appendLiveText(id, delta) {
	const live = liveEntry(id);
	if (!live || !live.tailNode || !live.blocksEl) { return false; }
	if (delta) { live.tailNode.appendData(delta); }
	const raw = live.tailNode.data;
	const cut = lastBlockBoundary(raw);
	if (cut > 0) {
		live.tailNode.deleteData(0, cut);
		// The one innerHTML a streaming block is allowed: a block that is finished is
		// parsed and highlighted once, appended after the blocks before it, and never
		// touched again until the turn ends.
		live.blocksEl.insertAdjacentHTML('beforeend', renderMarkdown(raw.slice(0, cut)));
		enhanceCodeBlocks();
	}
	return true;
}

// ---------- Tool cards ----------
/**
 * Draw the tool calls of one turn. Only cards whose parent matches are drawn at
 * this level; a Task's own calls are drawn again inside that Task's card, which
 * is how sub-agent work stays visually nested (Section 3.9).
 */
function renderTools(tools, parentId) {
	let html = '';
	for (const [id, tool] of tools) {
		if ((tool.parentId || undefined) !== (parentId || undefined)) { continue; }
		html += renderToolCard(id, tool, tools);
	}
	return html;
}

function renderToolCard(id, tool, tools) {
	const name = tool.toolName || 'tool';
	const input = toolInput(tool);
	const view = describeTool(name, input, tool, id);
	const nested = renderTools(tools, id);
	const running = tool.status === 'running';
	// A view may know the call failed when the transport did not say so — a server-side
	// fetch whose answer is an API error is the case that matters.
	// A call can fail without the transport saying so: the server-side tools and a
	// sub-agent whose own turn was refused all answer with an API error as their result.
	const failed = !!tool.isError || (!running && (!!view.failed || serverToolFailed(tool)));
	const elapsed = tool.elapsedSeconds != null
		? `<span class="tool-elapsed">${tool.elapsedSeconds.toFixed(1)}s</span>`
		: '';
	// Section 4.3: the row's left mark is a spinner while the call runs and how it ended
	// afterwards. The word it used to carry ("done", "read 120 lines") moves into the body,
	// so the resting row is one line of what ran and what it ran on.
	const mark = running
		? '<span class="tool-mark is-run"><span class="spinner"></span></span>'
		: `<span class="tool-mark ${failed ? 'is-error' : 'is-ok'}" aria-hidden="true"></span>`;
	const outcome = running
		? ''
		: `<div class="tool-outcome">${escapeHtml(failed ? 'error' : (view.done || 'done'))}${elapsed}</div>`;
	const target = view.target
		? `<span class="tool-target" title="${escapeAttr(view.targetTitle || view.target)}">${escapeHtml(clipChars(view.target, TOOL_TARGET_CHARS))}</span>`
		: '';
	const agentText = tool.agentText
		? `<div class="tool-agent-text">${renderMarkdown(tool.agentText)}</div>`
		: '';
	const children = nested ? `<div class="tool-children">${nested}</div>` : '';
	const body = `${view.body}${agentText}${children}`;
	// Section 4.3: expansion is always a user action. The exception is a card whose body is
	// the call — a question to answer, a todo list, a diff — which would otherwise hide the
	// only thing worth showing behind a click.
	const open = expandedTools.has(id) || (view.keepOpen && !seenTools.has(id)) ? 'open' : '';
	if (view.keepOpen && !seenTools.has(id)) { expandedTools.add(id); }
	seenTools.add(id);
	const status = running ? 'running' : failed ? 'failed' : 'done';
	return `
		<details class="tool-card tool-${escapeAttr(toolKind(name))}${failed ? ' is-error' : ''}" data-tool="${escapeAttr(id)}" data-status="${status}" ${open}>
			<summary>${mark}<span class="tool-name">${escapeHtml(name)}</span>${target}</summary>
			<div class="tool-card-body">${outcome}${body || '<div class="tool-empty">No details reported.</div>'}</div>
		</details>
	`;
}

/** One line of at most `max` characters, with an ellipsis where the rest was. */
function clipChars(text, max) {
	const str = String(text || '').replace(/\s+/g, ' ').trim();
	return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/** A css-safe token for the tool name, so cards can be styled per family. */
function toolKind(name) {
	return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Whatever we know of a tool's input: the parsed object when the call has
 * landed, or the partial JSON accumulated while it is still streaming in.
 */
function toolInput(tool) {
	if (tool.input && typeof tool.input === 'object') { return tool.input; }
	if (typeof tool.input === 'string' && tool.input) {
		try { return JSON.parse(tool.input); } catch { return {}; }
	}
	if (tool.partialJson) {
		try { return JSON.parse(tool.partialJson); } catch { return {}; }
	}
	return {};
}
/**
 * How one tool call should read: `target` is the headline argument shown next to
 * the name, `body` the detail, `done` an optional replacement for the "done"
 * badge, `keepOpen` whether the body is worth leaving expanded.
 *
 * Every tool the engine's preset exposes has a case here; anything else (an MCP
 * tool, a newly added built-in) falls through to the generic JSON view.
 *
 * `id` is the tool-use id — only the views that own interactive controls need it, so
 * that they can tell one card's buttons from another's after a re-render.
 */
function describeTool(name, input, tool, id) {
	switch (name) {
		case 'Read': return viewRead(input, tool);
		case 'Write': return viewWrite(input, tool);
		case 'Edit': return viewEdit(input, tool);
		case 'NotebookEdit': return viewNotebookEdit(input, tool);
		case 'Bash':
		case 'PowerShell': return viewShell(input, tool);
		case 'BashOutput': return viewBashOutput(input, tool);
		case 'Glob': return viewGlob(input, tool);
		case 'Grep': return viewGrep(input, tool);
		case 'Task':
		case 'Agent': return viewTask(input, tool);
		case 'TodoWrite': return viewTodos(input, tool);
		case 'TaskCreate':
		case 'TaskUpdate':
		case 'TaskGet':
		case 'TaskList': return viewTaskTool(name, input, tool);
		case 'WebFetch': return viewWebFetch(input, tool);
		case 'WebSearch': return viewWebSearch(input, tool);
		case 'Monitor': return viewMonitor(input, tool);
		case 'Skill': return viewSkill(input, tool);
		case 'SendMessage': return viewSendMessage(input, tool);
		case 'AskUserQuestion': return viewAskUser(input, tool, id);
		case 'Artifact':
		case 'ExitPlanMode':
		case 'EnterPlanMode': return viewPlain(input, tool);
		default: return viewGeneric(input, tool);
	}
}

function viewRead(input, tool) {
	const path = input.file_path || input.notebook_path || '';
	const range = input.offset != null || input.limit != null
		? ` (from line ${input.offset ?? 1}${input.limit != null ? `, ${input.limit} lines` : ''})`
		: input.pages ? ` (pages ${input.pages})` : '';
	return {
		target: `${shortPath(path)}${range}`,
		targetTitle: path,
		done: tool.result ? `${countLines(tool.result)} lines` : 'done',
		body: resultBlock(tool, { lang: langOf(path), label: 'Contents' }),
	};
}

function viewWrite(input, tool) {
	const path = input.file_path || '';
	const content = typeof input.content === 'string' ? input.content : '';
	return {
		target: shortPath(path),
		targetTitle: path,
		done: content ? `${countLines(content)} lines written` : 'done',
		keepOpen: false,
		body: `${content ? `<div class="tool-label">New contents</div>${clippedCode(content, langOf(path))}` : ''}${resultBlock(tool, { onlyErrors: true })}`,
	};
}

function viewEdit(input, tool) {
	const path = input.file_path || '';
	const before = typeof input.old_string === 'string' ? input.old_string : '';
	const after = typeof input.new_string === 'string' ? input.new_string : '';
	const all = input.replace_all ? ' <span class="tool-note">every occurrence</span>' : '';
	return {
		target: shortPath(path),
		targetTitle: path,
		keepOpen: true,
		body: `${all}${renderDiff(before, after)}${resultBlock(tool, { onlyErrors: true })}`,
	};
}

function viewNotebookEdit(input, tool) {
	const path = input.notebook_path || '';
	const mode = input.edit_mode || 'replace';
	const source = typeof input.new_source === 'string' ? input.new_source : '';
	return {
		target: `${shortPath(path)}${input.cell_id ? ` · cell ${input.cell_id}` : ''} · ${mode}`,
		targetTitle: path,
		body: `${source ? clippedCode(source, input.cell_type === 'markdown' ? 'markdown' : 'python') : ''}${resultBlock(tool, { onlyErrors: true })}`,
	};
}

function viewShell(input, tool) {
	const command = typeof input.command === 'string' ? input.command : '';
	const bits = [];
	if (input.description) { bits.push(`<div class="tool-note">${escapeHtml(input.description)}</div>`); }
	if (command) { bits.push(clippedCode(command, 'shell')); }
	if (input.run_in_background) { bits.push('<div class="tool-note">Runs in the background.</div>'); }
	bits.push(resultBlock(tool, { label: 'Output', terminal: true }));
	return {
		target: firstLine(command, 80),
		targetTitle: command,
		body: bits.join(''),
	};
}

function viewBashOutput(input, tool) {
	return {
		target: input.bash_id ? `job ${input.bash_id}` : '',
		body: resultBlock(tool, { label: 'Output', terminal: true }),
	};
}

function viewGlob(input, tool) {
	// "No files found" is one line of prose, not one match — counting lines blindly
	// would label an empty result "1 file".
	const empty = /^\s*no files found/i.test(tool.result || '');
	const matches = tool.result ? (empty ? 0 : countLines(tool.result)) : undefined;
	return {
		target: `${input.pattern || ''}${input.path ? ` in ${shortPath(input.path)}` : ''}`,
		done: matches != null ? `${matches} ${matches === 1 ? 'file' : 'files'}` : 'done',
		body: resultBlock(tool, { label: 'Matches' }),
	};
}

function viewGrep(input, tool) {
	const flags = [];
	if (input.glob) { flags.push(input.glob); }
	if (input.type) { flags.push(`type:${input.type}`); }
	if (input['-i']) { flags.push('case-insensitive'); }
	if (input.path) { flags.push(`in ${shortPath(input.path)}`); }
	// Grep answers an empty search with a sentence, the same way Glob does.
	const empty = /^\s*no (matches|files) found/i.test(tool.result || '');
	const hits = tool.result ? (empty ? 0 : countLines(tool.result)) : undefined;
	return {
		target: `${input.pattern || ''}${flags.length ? ` · ${flags.join(' · ')}` : ''}`,
		targetTitle: input.pattern || '',
		done: hits != null ? `${hits} ${hits === 1 ? 'line' : 'lines'}` : 'done',
		body: resultBlock(tool, { label: 'Matches' }),
	};
}

function viewTask(input, tool) {
	const kind = input.subagent_type || 'agent';
	const bits = [];
	if (input.prompt) {
		bits.push(`<details class="tool-subblock"><summary>Instructions</summary>${clippedCode(String(input.prompt), '', CLIP_LINES)}</details>`);
	}
	if (input.model) { bits.push(`<div class="tool-note">model: ${escapeHtml(input.model)}</div>`); }
	if (input.isolation) { bits.push(`<div class="tool-note">isolation: ${escapeHtml(input.isolation)}</div>`); }
	bits.push(resultBlock(tool, { label: 'Report', markdown: true }));
	return {
		target: `${input.description || kind} · ${kind}`,
		keepOpen: true,
		body: bits.join(''),
	};
}

function viewTodos(input, tool) {
	const todos = Array.isArray(input.todos) ? input.todos : [];
	if (!todos.length) { return viewGeneric(input, tool); }
	const done = todos.filter(t => t.status === 'completed').length;
	const rows = todos.map(t => {
		const state = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'todo';
		const mark = state === 'done' ? '✓' : state === 'active' ? '▸' : '○';
		return `<li class="todo-${state}"><span class="todo-mark">${mark}</span>${escapeHtml(t.content || t.activeForm || '')}</li>`;
	}).join('');
	return {
		target: `${done}/${todos.length} done`,
		keepOpen: true,
		body: `<ul class="todo-list">${rows}</ul>`,
	};
}

function viewTaskTool(name, input, tool) {
	const target = input.subject || input.taskId || (input.status ? `status: ${input.status}` : '');
	return {
		target: String(target || ''),
		body: `${input.description ? `<div class="tool-note">${escapeHtml(String(input.description))}</div>` : ''}${resultBlock(tool, { label: 'Result' })}`,
	};
}

/**
 * A call that failed without the transport saying so. The server-side tools and a
 * sub-agent whose own turn was refused all answer with no `is_error` on the block and
 * an HTTP `code` of 200 — that status belongs to the API call, not to the work — so the
 * result text is the only signal left, and it is written in one fixed form. Matching it
 * is what stops a card reading "done" directly above "API Error: 403".
 */
function serverToolFailed(tool) {
	return /^\s*API Error:/i.test(tool.result || '');
}

function viewWebFetch(input, tool) {
	return {
		target: input.url || '',
		targetTitle: input.url || '',
		body: `${input.prompt ? `<div class="tool-note">${escapeHtml(String(input.prompt))}</div>` : ''}${resultBlock(tool, { label: 'Answer', markdown: true })}`,
	};
}

/**
 * The search tool answers with a prose header and one JSON array of `{title, url}`
 * under a `Links:` label. Left as text that reads as a wall of escaped JSON, so the
 * array is pulled out and drawn as a list of hits. Anything that does not parse falls
 * back to the plain result block, which is still readable.
 */
function searchHits(text) {
	const label = (text || '').indexOf('Links:');
	if (label < 0) { return null; }
	const start = text.indexOf('[', label);
	if (start < 0) { return null; }
	// Scanned rather than matched to the last `]`: the array can be followed by prose,
	// and a title can contain a bracket of its own.
	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) { escaped = false; }
			else if (ch === '\\') { escaped = true; }
			else if (ch === '"') { inString = false; }
			continue;
		}
		if (ch === '"') { inString = true; }
		else if (ch === '[') { depth++; }
		else if (ch === ']' && --depth === 0) { end = i + 1; break; }
	}
	if (end < 0) { return null; }
	try {
		const parsed = JSON.parse(text.slice(start, end));
		// The scheme check is the same one rendered markdown applies: a search result is
		// text the model handed us, so a hit whose url could execute never becomes an
		// anchor. Such a hit is dropped rather than shown unlinked — there is nothing to
		// read in it, and the count below would otherwise lie about how many are usable.
		const hits = Array.isArray(parsed)
			? parsed.filter(hit => hit && typeof hit.url === 'string' && SAFE_LINK_SCHEME.test(hit.url))
			: [];
		return hits.length ? hits : null;
	} catch {
		return null;
	}
}

/** Host on its own line under a hit's title — which site the answer came from. */
function linkHost(url) {
	const match = /^https?:\/\/([^/?#]+)/i.exec(url);
	return match ? match[1].replace(/^www\./, '') : url;
}

function viewWebSearch(input, tool) {
	const hits = tool.result ? searchHits(tool.result) : null;
	if (hits) {
		const items = hits.map(hit => `
			<li class="search-hit">
				<a class="search-title" href="${escapeAttr(hit.url)}" title="${escapeAttr(hit.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(String(hit.title || hit.url))}</a>
				<div class="search-host">${escapeHtml(linkHost(hit.url))}</div>
				${hit.snippet ? `<div class="search-snippet">${escapeHtml(String(hit.snippet))}</div>` : ''}
			</li>`).join('');
		return {
			target: input.query || '',
			done: `${hits.length} result${hits.length === 1 ? '' : 's'}`,
			body: `<div class="tool-label">Results</div><ul class="search-hits">${items}</ul>`,
		};
	}
	return {
		target: input.query || '',
		body: resultBlock(tool, { label: 'Results', markdown: true }),
	};
}

function viewMonitor(input, tool) {
	const bits = [];
	if (input.command) { bits.push(clippedCode(String(input.command), 'shell')); }
	if (input.ws && input.ws.url) { bits.push(`<div class="tool-note">${escapeHtml(String(input.ws.url))}</div>`); }
	bits.push(resultBlock(tool, { label: 'Events', terminal: true }));
	return { target: input.description || '', body: bits.join('') };
}

function viewSkill(input, tool) {
	return {
		target: `${input.skill || ''}${input.args ? ` ${firstLine(String(input.args), 50)}` : ''}`,
		body: resultBlock(tool, { markdown: true }),
	};
}

function viewSendMessage(input, tool) {
	return {
		target: `to ${input.to || '?'}${input.summary ? ` · ${input.summary}` : ''}`,
		body: `${input.message ? clippedCode(String(input.message), '', CLIP_LINES) : ''}${resultBlock(tool, { onlyErrors: true })}`,
	};
}

// ---------- AskUserQuestion cards ----------
//
// A question with options is the one tool call the user is supposed to answer, so the
// card draws the options as buttons instead of printing the JSON and hoping the user
// retypes one of the labels.
//
// How the answer travels is set by the engine, not by us: it runs AskUserQuestion
// itself inside its own process and closes the call immediately with an empty answer
// ("User has answered your questions: ."), so there is no tool result for the panel to
// fill in. The answer therefore goes out the only way it can — as the next user
// message, exactly as if it had been typed. That also means a click is useful *after*
// the turn ends, which is why the buttons stay live on a finished card.
//
// Picks live here rather than in the DOM because `renderMessages` rewrites the whole
// transcript on every delta; the markup is drawn from this state each time.

/** tool-use id -> array (one per question) of chosen option indices. */
const askPickState = new Map();
/** tool-use id -> the summary of what was sent, once a card has been answered. */
const askSent = new Map();

function resetAskCards() {
	askPickState.clear();
	askSent.clear();
}

function askQuestions(input) {
	return Array.isArray(input.questions) ? input.questions.filter(q => q && typeof q === 'object') : [];
}

function askOptions(question) {
	return Array.isArray(question.options) ? question.options : [];
}

/** Options are `{ label, description }`, but tolerate a bare string. */
function askOptionLabel(option) {
	if (typeof option === 'string') { return option; }
	return String((option && (option.label ?? option.name)) || '');
}

/** Current picks for a card, grown to the question count on first use. */
function askPicks(id, questions) {
	const existing = askPickState.get(id);
	if (existing && existing.length === questions.length) { return existing; }
	const picks = questions.map((_, qi) => (existing && existing[qi]) || []);
	askPickState.set(id, picks);
	return picks;
}

/**
 * The tool behind a card. Cards are drawn from `streamScratch`, which is keyed by
 * stream and not by tool, so the id has to be looked up across the turns on screen.
 */
function findAskTool(id) {
	for (const scratch of streamScratch.values()) {
		const tool = scratch.tools && scratch.tools.get(id);
		if (tool) { return tool; }
	}
	return null;
}

/**
 * What gets sent. One question reads as a plain answer — the model asked it a moment
 * ago and this is the reply to it. Several need saying which answer is which, and the
 * `header` is the short label the tool supplies for exactly that.
 */
function askAnswerText(questions, picks) {
	const parts = questions.map((q, qi) => {
		const chosen = (picks[qi] || []).map(oi => askOptionLabel(askOptions(q)[oi])).filter(Boolean);
		if (!chosen.length) { return ''; }
		const answer = chosen.join(', ');
		if (questions.length === 1) { return answer; }
		const label = String(q.header || q.question || `Question ${qi + 1}`).trim();
		return `${label.replace(/[:?]\s*$/, '')}: ${answer}`;
	});
	return parts.filter(Boolean).join('\n');
}

function viewAskUser(input, tool, id) {
	const questions = askQuestions(input);
	// Nothing to click: an input that never parsed, or a card being replayed from a
	// transcript where the arguments were not kept.
	if (!questions.length || !id) {
		const list = askQuestions(input).map(q => `<li>${escapeHtml(q.question || '')}</li>`).join('');
		return {
			target: questions.length ? questions[0].header || `${questions.length} question(s)` : '',
			keepOpen: true,
			body: `${list ? `<ul>${list}</ul>` : ''}${resultBlock(tool, { label: 'Answer' })}`,
		};
	}

	const sent = askSent.get(id);
	const picks = askPicks(id, questions);
	const blocks = questions.map((q, qi) => {
		const buttons = askOptions(q).map((opt, oi) => {
			const label = askOptionLabel(opt);
			if (!label) { return ''; }
			const desc = typeof opt === 'string' ? '' : String(opt.description || '');
			const picked = picks[qi].includes(oi);
			return `
				<button class="ask-option${picked ? ' is-picked' : ''}"${sent ? ' disabled' : ''}
					data-ask-id="${escapeAttr(id)}" data-ask-q="${qi}" data-ask-opt="${oi}"
					${desc ? `title="${escapeAttr(desc)}"` : ''}
					aria-pressed="${picked ? 'true' : 'false'}">
					<span class="ask-option-label">${escapeHtml(label)}</span>
					${desc ? `<span class="ask-option-desc">${escapeHtml(desc)}</span>` : ''}
				</button>`;
		}).join('');
		return `
			<div class="ask-question">
				${q.header ? `<div class="ask-header">${escapeHtml(String(q.header))}</div>` : ''}
				<div class="ask-prompt">${escapeHtml(String(q.question || ''))}</div>
				${buttons
				? `<div class="ask-options${q.multiSelect ? ' is-multi' : ''}" role="group">${buttons}</div>`
				: '<div class="tool-note">No options were offered — answer in the composer.</div>'}
			</div>`;
	}).join('');

	// A single question with a single answer to give is complete the moment it is
	// clicked, so the click sends it. Anything else needs a button to say "that is all
	// of them", and stays disabled until every question has a pick.
	const needsSend = questions.length > 1 || questions.some(q => q.multiSelect);
	const ready = questions.every((_, qi) => picks[qi].length > 0);
	const footer = sent
		? `<div class="ask-sent">Answered: ${escapeHtml(sent.replace(/\n/g, ' · '))}</div>`
		: needsSend
			? `<div class="ask-actions">
					<button class="ask-send" data-ask-send="${escapeAttr(id)}"${ready ? '' : ' disabled'}>Send answer</button>
					${ready ? '' : '<span class="ask-hint">Pick an option for each question.</span>'}
				</div>`
			: '';

	return {
		target: questions[0].header || `${questions.length} question(s)`,
		keepOpen: true,
		// The engine's own result for this call is the empty self-answer described
		// above, so it is only worth showing when it is an error.
		body: `<div class="ask-block">${blocks}${footer}</div>${resultBlock(tool, { onlyErrors: true })}`,
	};
}

/** Record a pick; for the one-question case that is also the send. */
function pickAskOption(id, qi, oi) {
	if (askSent.has(id)) { return; }
	const tool = findAskTool(id);
	if (!tool) { return; }
	const questions = askQuestions(toolInput(tool));
	const question = questions[qi];
	if (!question) { return; }
	const picks = askPicks(id, questions);
	if (question.multiSelect) {
		const at = picks[qi].indexOf(oi);
		if (at >= 0) { picks[qi].splice(at, 1); } else { picks[qi].push(oi); }
	} else {
		picks[qi] = [oi];
	}
	if (questions.length === 1 && !question.multiSelect) {
		submitAskAnswer(id);
		return;
	}
	renderMessages();
}

/** Send the card's picks as the next user message. */
function submitAskAnswer(id) {
	if (askSent.has(id)) { return; }
	const tool = findAskTool(id);
	if (!tool) { return; }
	const questions = askQuestions(toolInput(tool));
	const picks = askPicks(id, questions);
	const text = askAnswerText(questions, picks);
	if (!text) { return; }
	askSent.set(id, text);
	pushInputHistory(text);
	const entry = { text, attachments: [], planMode };
	// The click can land while the turn that asked is still finishing. Holding it in
	// the queue is what the panel already does with anything sent mid-turn, so the
	// answer goes out as the next prompt instead of being dropped — and the composer's
	// own draft is left untouched either way.
	if (isBusy) {
		promptQueue.push(entry);
		renderPromptQueue();
		renderMessages();
		return;
	}
	dispatchPrompt(entry);
	renderMessages();
}

function viewPlain(input, tool) {
	return { target: '', body: resultBlock(tool, { markdown: true }) };
}

function viewGeneric(input, tool) {
	const json = tool.partialJson || (Object.keys(input).length ? safeStringify(input) : '');
	return {
		target: '',
		body: `${json ? `<div class="tool-label">Input</div>${clippedCode(json, 'json')}` : ''}${resultBlock(tool, { label: 'Result' })}`,
	};
}
/**
 * How much of a tool's input or output an expanded card shows before it asks (Section 4.3).
 * Twenty lines is about a screen of an opened card, which is the point at which reading
 * turns into scrolling past.
 */
const CLIP_LINES = 20;

/**
 * The tool's own output. Long output is clipped the way the CLI clips it, with
 * the tail kept for errors (where the message is usually last) and the head kept
 * otherwise.
 */
function resultBlock(tool, opts) {
	const options = opts || {};
	if (tool.result === undefined || tool.result === null || tool.result === '') {
		return '';
	}
	const text = String(tool.result);
	if (options.onlyErrors && !tool.isError) {
		return '';
	}
	const label = options.label ? `<div class="tool-label">${escapeHtml(options.label)}</div>` : '';
	if (tool.isError) {
		return `<div class="tool-label">Error</div>${clipBlock(text, CLIP_LINES, {
			tail: true,
			render: shown => `<pre class="tool-output is-error">${escapeHtml(shown)}</pre>`,
		})}`;
	}
	if (options.markdown) {
		return `${label}${clipBlock(text, CLIP_LINES, {
			render: shown => `<div class="tool-markdown">${renderMarkdown(shown)}</div>`,
		})}`;
	}
	const cls = options.terminal ? 'tool-output is-terminal' : 'tool-output';
	return `${label}${clipBlock(text, options.lines || CLIP_LINES, {
		render: shown => `<pre class="${cls}">${escapeHtml(shown)}</pre>`,
	})}`;
}

/** A code block with the same chrome as chat code blocks, clipped to `lines`. */
function clippedCode(text, lang, lines) {
	return clipBlock(String(text), lines || CLIP_LINES, {
		render: shown => renderCodeBlock(lang || '', escapeHtml(shown)),
	});
}

/**
 * Show the first (or, for an error, the last) `lines` lines with the rest one click
 * away. `render` turns the visible text into whatever markup this block wants — a
 * `<pre>`, a code block, rendered markdown — so every kind of output gets the same
 * control without the shapes being duplicated here.
 *
 * The full text stays in `clipStash` rather than in the DOM: a card re-renders on
 * every stream delta, and pushing a 3000-line file through innerHTML that often
 * costs real time for something nobody has asked to see.
 */
function clipBlock(text, lines, opts) {
	const options = opts || {};
	const render = options.render || (shown => `<pre class="tool-output">${escapeHtml(shown)}</pre>`);
	const all = String(text).split('\n');
	if (all.length <= lines) { return render(text); }

	const key = clipKey(text);
	// The render function is kept with the text so a toggle can redraw this one block on
	// its own, without a full re-render — which would throw away the `open` state of
	// every card on screen, including the card the reader just expanded.
	clipStash.set(key, { text: String(text), lines, tail: !!options.tail, render });
	return clipMarkup(key, clipStash.get(key));
}

/** The visible half of a clipped block, in whichever state the reader has left it. */
function clipMarkup(key, entry) {
	const all = entry.text.split('\n');
	const expanded = expandedClips.has(key);
	const dropped = all.length - entry.lines;
	const unit = dropped === 1 ? 'line' : 'lines';
	const shown = expanded
		? entry.text
		: entry.tail ? all.slice(-entry.lines).join('\n') : all.slice(0, entry.lines).join('\n');
	const label = expanded
		? 'Show less'
		: `Show ${dropped} ${entry.tail ? 'earlier' : 'more'} ${unit}`;
	return `
		<div class="clip${expanded ? ' is-expanded' : ''}" data-clip="${key}">
			${entry.render(shown)}
			<button class="clip-toggle" type="button" data-clip-toggle="${key}">${label}</button>
		</div>
	`;
}

/**
 * A key for a clipped block, derived from its own text so that a re-render lands on
 * the same entry and an expansion survives the next delta. The hash is FNV-1a over a
 * sample rather than the whole string, because this runs on every render and length
 * plus three windows is already enough to tell two tool outputs apart.
 */
function clipKey(text) {
	const middle = text.length >> 1;
	const sample = text.length > 600
		? text.slice(0, 200) + text.slice(middle, middle + 200) + text.slice(-200)
		: text;
	let hash = 0x811c9dc5;
	for (let i = 0; i < sample.length; i++) {
		hash ^= sample.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0;
	}
	return `${text.length.toString(36)}-${hash.toString(36)}`;
}

/**
 * Forget every clipped block, for when the conversation they belonged to is gone.
 * Called from the three places that replace the transcript wholesale, so the other
 * per-transcript scratch state goes with it.
 */
function resetClips() {
	clipStash.clear();
	expandedClips.clear();
	expandedTools.clear();
	expandedThinking.clear();
	seenTools.clear();
	resetAskCards();
	// The window and the heights it was sized from belonged to the transcript that is
	// going away; a new one starts at the newest bubbles again.
	windowCount = WINDOW_INITIAL;
	bubbleHeights.clear();
	domIndex.clear();
}

/**
 * Expand or collapse one clipped block. Only that block is redrawn: a full re-render
 * would drop the `open` attribute of every tool card on screen, so clicking "Show more"
 * would fold away the card whose output was just revealed.
 */
function toggleClip(key) {
	const entry = clipStash.get(key);
	if (expandedClips.has(key)) { expandedClips.delete(key); } else { expandedClips.add(key); }
	const block = messagesEl.querySelector(`[data-clip="${key}"]`);
	if (!entry || !block) {
		// Nothing to patch — the transcript moved on under us. A full render still lands
		// on the right state, since it reads `expandedClips` too.
		renderMessages();
		return;
	}
	block.outerHTML = clipMarkup(key, entry);
	// The replacement is new DOM: its copy button and its own toggle are unwired.
	enhanceCodeBlocks();
	enhanceClips();
	const next = messagesEl.querySelector(`[data-clip="${key}"]`);
	if (next) { keepInView(next); }
}

// After every render, wire up the Show more / Show less toggles.
function enhanceClips() {
	messagesEl.querySelectorAll('.clip-toggle').forEach(btn => {
		// A toggle redraws its own block and then calls this again, so buttons that are
		// already listening have to be left alone or a click would toggle twice.
		if (btn.dataset.wired) { return; }
		btn.dataset.wired = '1';
		btn.addEventListener('click', (e) => {
			// The toggle lives in the body of a `<details>`, and a card can be nested in
			// another — stopping here keeps the click from folding either one.
			e.preventDefault();
			e.stopPropagation();
			toggleClip(btn.dataset.clipToggle);
		});
	});
}

/**
 * After every render, remember what the reader opens. A tool card and a reasoning block
 * are `<details>`, so the browser does the opening — all this has to do is write the new
 * state into the set the next render reads its `open` attribute from. Ctrl+O goes through
 * the same path, since setting `open` in script fires `toggle` too.
 */
function enhanceDisclosures() {
	messagesEl.querySelectorAll('details[data-tool], details[data-think]').forEach(el => {
		if (el.dataset.wired) { return; }
		el.dataset.wired = '1';
		const set = el.dataset.tool ? expandedTools : expandedThinking;
		const key = el.dataset.tool || el.dataset.think;
		el.addEventListener('toggle', () => {
			if (!el.open) { set.delete(key); return; }
			// The slide (Section 6) belongs to the click that asked for it. A rebuild re-creates
			// the element with `open` already written from this set, and re-running the animation
			// on every token would make a card that is merely still streaming look like it is
			// being opened over and over.
			if (!set.has(key)) { el.classList.add('is-opening'); }
			set.add(key);
		});
	});
}

/**
 * After every render, wire up the option buttons of any AskUserQuestion card. Same
 * shape as `enhanceClips`: the markup is rebuilt from `askPickState` each time, so the
 * handlers only carry which card, question and option they belong to.
 */
function enhanceAskOptions() {
	messagesEl.querySelectorAll('.ask-option').forEach(btn => {
		if (btn.dataset.wired) { return; }
		btn.dataset.wired = '1';
		btn.addEventListener('click', (e) => {
			// The card is a `<details>`; a click that bubbles would fold the question away.
			e.preventDefault();
			e.stopPropagation();
			pickAskOption(btn.dataset.askId, Number(btn.dataset.askQ), Number(btn.dataset.askOpt));
		});
	});
	messagesEl.querySelectorAll('.ask-send').forEach(btn => {
		if (btn.dataset.wired) { return; }
		btn.dataset.wired = '1';
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			submitAskAnswer(btn.dataset.askSend);
		});
	});
}

function countLines(text) {
	const str = String(text);
	if (!str) { return 0; }
	return str.split('\n').length;
}

function firstLine(text, max) {
	const line = String(text || '').split('\n')[0];
	const limit = max || 80;
	const suffix = String(text || '').includes('\n') ? ' …' : '';
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : `${line}${suffix}`;
}
/** Workspace-relative-ish path: enough tail to identify the file. */
function shortPath(path) {
	const str = String(path || '').replace(/\\/g, '/');
	if (!str) { return ''; }
	const parts = str.split('/').filter(Boolean);
	return parts.length <= 3 ? str : `…/${parts.slice(-3).join('/')}`;
}

/** Fence language for a path, so file contents get the same colours as chat code. */
function langOf(path) {
	const ext = String(path || '').toLowerCase().match(/\.([a-z0-9]+)$/);
	if (!ext) { return ''; }
	const map = {
		ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
		js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
		py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
		cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
		json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
		md: 'markdown', html: 'html', css: 'css', scss: 'scss', less: 'less',
		sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', bat: 'bat',
		sql: 'sql', php: 'php', swift: 'swift', dart: 'dart', lua: 'lua', ipynb: 'json',
	};
	return map[ext[1]] || ext[1];
}
/**
 * Render an Edit as a line diff, with three lines of context around each change
 * and long unchanged stretches folded away — the same shape as the CLI's diff.
 */
function renderDiff(before, after) {
	const ops = diffLines(String(before).split('\n'), String(after).split('\n'));
	const keep = new Array(ops.length).fill(false);
	for (let i = 0; i < ops.length; i++) {
		if (ops[i].t === ' ') { continue; }
		for (let j = Math.max(0, i - 3); j <= Math.min(ops.length - 1, i + 3); j++) { keep[j] = true; }
	}
	const rows = [];
	let folded = 0;
	let added = 0;
	let removed = 0;
	for (let i = 0; i < ops.length; i++) {
		if (ops[i].t === '+') { added++; }
		if (ops[i].t === '-') { removed++; }
		if (!keep[i]) { folded++; continue; }
		if (folded) {
			rows.push(`<div class="diff-fold">⋯ ${folded} unchanged ${folded === 1 ? 'line' : 'lines'}</div>`);
			folded = 0;
		}
		const cls = ops[i].t === '+' ? 'diff-add' : ops[i].t === '-' ? 'diff-del' : 'diff-ctx';
		const sign = ops[i].t === ' ' ? ' ' : ops[i].t;
		rows.push(`<div class="${cls}"><span class="diff-sign">${sign}</span>${escapeHtml(ops[i].l) || '&nbsp;'}</div>`);
	}
	if (folded) {
		rows.push(`<div class="diff-fold">⋯ ${folded} unchanged ${folded === 1 ? 'line' : 'lines'}</div>`);
	}
	if (!rows.length) { return '<div class="tool-note">No change.</div>'; }
	const summary = `<div class="diff-summary">+${added} −${removed}</div>`;
	return `<div class="diff">${summary}<div class="diff-body">${rows.join('')}</div></div>`;
}

/**
 * Line diff by longest common subsequence. Bounded: very large edits skip the
 * DP table and are shown as a straight removal followed by an insertion, which
 * is still readable and keeps the panel responsive.
 */
function diffLines(a, b) {
	const n = a.length;
	const m = b.length;
	if (n * m > 250000) {
		return [...a.map(l => ({ t: '-', l })), ...b.map(l => ({ t: '+', l }))];
	}
	const dp = [];
	for (let i = 0; i <= n; i++) { dp.push(new Uint32Array(m + 1)); }
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) { out.push({ t: ' ', l: a[i] }); i++; j++; }
		else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', l: a[i] }); i++; }
		else { out.push({ t: '+', l: b[j] }); j++; }
	}
	while (i < n) { out.push({ t: '-', l: a[i++] }); }
	while (j < m) { out.push({ t: '+', l: b[j++] }); }
	return out;
}


/**
 * How long the turn took, and nothing else (Section 1.1). Cost, token counts and the model
 * name are still tracked — `/cost` and `/usage` report them from the engine's own totals —
 * but the thread is for the answer, and a row of five numbers under every reply is a
 * receipt. What is left is the one figure that says something about the turn itself.
 */
function renderMeta(meta) {
	if (meta.durationMs == null) { return ''; }
	return `<div class="message-duration">${(meta.durationMs / 1000).toFixed(1)}s</div>`;
}

function formatTokens(n) {
	if (n >= 1000) { return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'; }
	return String(n);
}

// ---------- Markdown (lightweight, no external deps) ----------
function renderMarkdown(text) {
	if (!text) return '';

	// Pull out fenced code blocks first so inline transformations don't touch them.
	const codeBlocks = [];
	let html = escapeHtml(text);
	html = html.replace(/```([a-zA-Z0-9+-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
		const idx = codeBlocks.length;
		codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
		return ` CODEBLOCK${idx} `;
	});

	// Inline code, stashed rather than emitted: the link and emphasis passes below have
	// no business rewriting what is inside it. The markers use a control character so
	// prose that happens to read "CODE0" is never mistaken for one.
	const inlineCode = [];
	html = html.replace(/`([^`]+)`/g, (match, code) => {
		inlineCode.push(code);
		return `\u0001CODE${inlineCode.length - 1}\u0001`;
	});

	// Links, both `[text](url)` and bare URLs. Stashed for the same reason, and because
	// an emphasis pass would otherwise chew on a URL that happens to contain `*`.
	const links = [];
	const stashLink = (href, label) => {
		links.push({ href, label });
		return `\u0001LINK${links.length - 1}\u0001`;
	};
	html = html.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, label, href) =>
		SAFE_LINK_SCHEME.test(href) ? stashLink(href, label || href) : match);
	html = html.replace(/(^|[\s(])(https?:\/\/[^\s<>)\]"']+)/g, (match, lead, url) => `${lead}${stashLink(url, url)}`);

	// Bold / italic
	html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<em>$1</em>');

	// Headings
	html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
	html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
	html = html.replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');

	// Blockquotes
	html = html.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');

	// Lists — bullets and numbers, nested by indentation.
	html = buildLists(html);

	// Tables
	html = buildTables(html);

	// Paragraphs
	html = html.split(/\n\n+/).map(block => {
		const trimmed = block.trim();
		if (!trimmed) return '';
		if (/^<(pre|ul|ol|table|blockquote|h\d|details|div)/.test(trimmed)) return trimmed;
		if (/^ CODEBLOCK/.test(trimmed)) return trimmed;
		return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
	}).join('');

	// Restore code blocks as rich code-block widgets with a copy button.
	html = html.replace(/ CODEBLOCK(\d+) /g, (m, idx) => {
		const block = codeBlocks[Number(idx)];
		return renderCodeBlock(block.lang, block.code);
	});

	// Inline code and links last, so nothing above could rewrite what is inside them.
	// Both halves were escaped by the first pass, and an escaped string is exactly what
	// an attribute value wants — `&amp;` inside an href decodes back to `&`.
	html = html.replace(/\u0001CODE(\d+)\u0001/g, (m, idx) => `<code>${inlineCode[Number(idx)]}</code>`);
	html = html.replace(/\u0001LINK(\d+)\u0001/g, (m, idx) => {
		const link = links[Number(idx)];
		return `<a href="${link.href}" title="${link.href}" target="_blank" rel="noopener noreferrer">${link.label}</a>`;
	});

	return html;
}

/**
 * Turn `-`/`*`/`1.` lines into real lists. Indentation nests them, and an
 * ordered list that starts at something other than 1 keeps its numbering.
 */
function buildLists(text) {
	const lines = text.split('\n');
	const out = [];
	const stack = [];
	const closeTop = () => { out.push(`</${stack.pop().tag}>`); };
	for (const line of lines) {
		const item = line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
		if (!item) {
			while (stack.length) { closeTop(); }
			out.push(line);
			continue;
		}
		const indent = item[1].replace(/\t/g, '    ').length;
		const tag = item[2] ? 'ul' : 'ol';
		while (stack.length && (stack[stack.length - 1].indent > indent
			|| (stack[stack.length - 1].indent === indent && stack[stack.length - 1].tag !== tag))) {
			closeTop();
		}
		if (!stack.length || stack[stack.length - 1].indent < indent) {
			const start = tag === 'ol' && item[3] && item[3] !== '1' ? ` start="${Number(item[3])}"` : '';
			out.push(`<${tag}${start}>`);
			stack.push({ tag, indent });
		}
		out.push(`<li>${item[4]}</li>`);
	}
	while (stack.length) { closeTop(); }
	return out.join('\n');
}

/** GitHub-style pipe tables: a header row, a dashed separator, then body rows. */
function buildTables(text) {
	const lines = text.split('\n');
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const next = lines[i + 1];
		if (isTableRow(lines[i]) && next && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(next) && next.includes('-')) {
			const header = splitTableRow(lines[i]);
			const align = splitTableRow(next).map(cell => (
				/^:.*:$/.test(cell) ? 'center' : /:$/.test(cell) ? 'right' : ''
			));
			const rows = [];
			i += 2;
			while (i < lines.length && isTableRow(lines[i])) { rows.push(splitTableRow(lines[i])); i++; }
			i--;
			out.push(renderTable(header, align, rows));
			continue;
		}
		out.push(lines[i]);
	}
	return out.join('\n');
}

function isTableRow(line) {
	return typeof line === 'string' && line.includes('|') && !/^\s*</.test(line) && line.split('|').length >= 3;
}

function splitTableRow(line) {
	return line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
}

/** Cells already carry inline markup, so they are placed as-is. */
function renderTable(header, align, rows) {
	const cell = (tag, content, idx) => {
		const cls = align[idx] ? ` class="ta-${align[idx]}"` : '';
		return `<${tag}${cls}>${content || ''}</${tag}>`;
	};
	const head = header.map((c, idx) => cell('th', c, idx)).join('');
	const body = rows.map(row => `<tr>${header.map((_, idx) => cell('td', row[idx], idx)).join('')}</tr>`).join('');
	return `<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * A fenced block: language label, copy button (added after render) and the code
 * itself, tokenised for colour. `code` arrives HTML-escaped.
 */
function renderCodeBlock(lang, code) {
	return `
		<div class="code-block">
			<div class="code-bar"><span>${escapeHtml(lang)}</span></div>
			<pre><code>${highlightCode(code, lang)}</code></pre>
		</div>
	`;
}

// ---------- Syntax highlighting (no external highlighter) ----------
const CODE_KEYWORDS = [
	'const', 'let', 'var', 'function', 'class', 'extends', 'implements', 'interface', 'type', 'enum',
	'return', 'if', 'else', 'elif', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
	'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'await', 'async', 'yield', 'try', 'catch',
	'finally', 'throw', 'raise', 'import', 'export', 'from', 'as', 'with', 'default', 'public',
	'private', 'protected', 'readonly', 'static', 'abstract', 'override', 'def', 'lambda', 'pass',
	'self', 'this', 'super', 'None', 'True', 'False', 'null', 'nil', 'nullptr', 'undefined', 'true',
	'false', 'void', 'fn', 'impl', 'trait', 'struct', 'pub', 'mut', 'use', 'mod', 'match', 'where',
	'package', 'func', 'go', 'defer', 'chan', 'range', 'select', 'echo', 'then', 'fi', 'esac',
	'done', 'local', 'export', 'unset', 'set', 'and', 'or', 'not',
].join('|');

const CODE_STRINGS = '"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`';
const CODE_TAIL = `(${CODE_STRINGS})|(\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)|(\\b(?:${CODE_KEYWORDS})\\b)|(\\b[A-Za-z_$][\\w$]*(?=\\s*\\())`;
/** Two tokenisers: one for `//` comment languages, one for `#`. */
const CODE_RE_SLASH = new RegExp(`(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|${CODE_TAIL}`, 'g');
const CODE_RE_HASH = new RegExp(`(#[^\\n]*)|${CODE_TAIL}`, 'g');

/** Which comment syntax a fence language uses, or '' to leave it alone. */
function codeFamily(lang) {
	const name = String(lang || '').toLowerCase();
	if (!name || name === 'text' || name === 'markdown' || name === 'md' || name === 'diff') { return ''; }
	if (['python', 'py', 'shell', 'sh', 'bash', 'zsh', 'fish', 'powershell', 'ps1', 'ruby', 'rb',
		'yaml', 'yml', 'toml', 'ini', 'conf', 'dockerfile', 'makefile', 'perl', 'r', 'elixir'].includes(name)) {
		return 'hash';
	}
	return 'slash';
}

/**
 * Wrap tokens in `<span class="tok-…">`. `escaped` is already HTML-escaped, so it
 * is decoded first and every emitted piece is re-escaped — the round trip is
 * exact because the text was escaped exactly once.
 */
function highlightCode(escaped, lang) {
	const family = codeFamily(lang);
	if (!family || escaped.length > 20000) { return escaped; }
	const raw = unescapeHtml(escaped);
	const re = family === 'hash' ? CODE_RE_HASH : CODE_RE_SLASH;
	re.lastIndex = 0;
	let out = '';
	let last = 0;
	let match;
	while ((match = re.exec(raw)) !== null) {
		if (!match[0]) { re.lastIndex++; continue; }
		out += escapeHtml(raw.slice(last, match.index));
		const cls = match[1] ? 'tok-cmt' : match[2] ? 'tok-str' : match[3] ? 'tok-num' : match[4] ? 'tok-kw' : 'tok-fn';
		out += `<span class="${cls}">${escapeHtml(match[0])}</span>`;
		last = match.index + match[0].length;
	}
	return out + escapeHtml(raw.slice(last));
}

function unescapeHtml(text) {
	return String(text)
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, '\'')
		.replace(/&amp;/g, '&');
}

// After every render, wire up copy buttons on code blocks.
function enhanceCodeBlocks() {
	messagesEl.querySelectorAll('.code-block').forEach(block => {
		if (block.querySelector('.copy-btn')) { return; }
		const bar = block.querySelector('.code-bar');
		const codeEl = block.querySelector('code');
		if (!bar || !codeEl) { return; }
		const btn = document.createElement('button');
		btn.className = 'copy-btn';
		btn.type = 'button';
		btn.setAttribute('aria-label', 'Copy code');
		btn.innerHTML = COPY_SVG;
		btn.addEventListener('click', () => {
			const text = codeEl.textContent || '';
			navigator.clipboard.writeText(text).then(() => {
				btn.classList.add('copied');
				btn.innerHTML = CHECK_SVG;
				setTimeout(() => {
					btn.classList.remove('copied');
					btn.innerHTML = COPY_SVG;
				}, 1400);
			}).catch(() => { /* clipboard unavailable */ });
		});
		bar.appendChild(btn);
	});
}

// ---------- Actions ----------

/**
 * Ask before throwing a conversation away. `window.confirm` is not an option: the
 * webview iframe is sandboxed without `allow-modals`, so the call is ignored and
 * returns false — which turned both buttons below into dead buttons whenever there
 * was anything to clear. The panel's own sheet is the same one panels.js uses in
 * place of `window.prompt`.
 */
function askConfirm(title, message, confirmLabel, onConfirm) {
	const sheet = window.CodeMindPanels && window.CodeMindPanels.showSheet;
	if (!sheet) {
		// No sheet means no way to ask. Acting is the lesser wrong: the alternative is
		// a button that does nothing at all.
		onConfirm();
		return;
	}
	sheet({
		title,
		className: 'confirm-sheet',
		body: `<p class="sheet-message">${escapeHtml(message)}</p>`,
		confirmLabel,
		onConfirm: () => { onConfirm(); },
	});
}

function discardConversation() {
	vscode.postMessage({ type: 'clearHistory' });
	messages = [];
	streamScratch.clear();
	resetClips();
	resetSessionTotals();
	renderEmptyState();
}

function newSession() {
	if (!messages.length) {
		discardConversation();
		inputEl.focus();
		return;
	}
	askConfirm(
		'Start a new session?',
		'This clears the conversation shown here. Earlier turns stay in the session log on disk.',
		'Start new session',
		() => { discardConversation(); inputEl.focus(); },
	);
}

// Section 3.2 cut the header down to two buttons, and the trash button was the only caller of a
// `clearHistory()` that asked the same question New Session asks and then ran the very same
// `discardConversation()`. The capability is New Session's; the duplicate prompt is gone. A
// workbench-side clear still works — the pane's own `clearHistory()` posts an empty history.

function resetSessionTotals() {
	// The background list was part of the old footer's sentence; it is still cleared here
	// because a fresh session has no jobs of its own to report either.
	clearBackgroundTasks();
	sessionTotals.totalCostUsd = 0;
	sessionTotals.inputTokens = 0;
	sessionTotals.outputTokens = 0;
	sessionTotals.durationMs = null;
	sessionTotals.model = undefined;
	// Back to an empty line rather than a zero: the line keeps its height either way
	// (Section 1.4), and "0.0k tokens this session" is a fact nobody needs stated.
	updateSessionTokens();
}

function showModal(show) {
	if (show) {
		apiKeyModal.classList.remove('is-closing');
		apiKeyModal.classList.remove('hidden');
		setTimeout(() => apiKeyInput.focus(), 50);
	} else if (!apiKeyModal.classList.contains('hidden')) {
		// Section 6.10: the dialog scales back down and its backdrop lifts before either
		// of them leaves the layout.
		playOut(apiKeyModal, () => apiKeyModal.classList.add('hidden'));
		apiKeyInput.value = '';
	} else {
		apiKeyInput.value = '';
	}
}

function saveApiKey() {
	const key = apiKeyInput.value.trim();
	if (key) {
		vscode.postMessage({ type: 'setApiKey', payload: key });
		showModal(false);
	}
}

// ---------- Permission dialog (Section 3.5) ----------
let currentPermissionToolUseId = null;
/** Scope ids the current dialog is offering, so a stale click cannot be sent. */
let currentPermissionScopes = [];

/** Where a grant is kept, spelled the way the engine's own settings UI spells it. */
const PERMISSION_STORE_LABELS = {
	session: 'Remembered until this conversation is cleared',
	localSettings: 'Saved to this project (.claude/settings.local.json)',
	projectSettings: 'Saved to shared project settings',
	userSettings: 'Saved to your user settings',
};

function showPermissionDialog(payload) {
	currentPermissionToolUseId = payload.toolUseId;
	currentPermissionScopes = Array.isArray(payload.scopes) ? payload.scopes : [];
	permToolName.textContent = payload.toolName || 'tool';
	permInput.textContent = payload.input !== undefined
		? (typeof payload.input === 'string' ? payload.input : safeStringify(payload.input))
		: '';
	if (permTitle) {
		permTitle.textContent = payload.agentId ? `Permission Request (${payload.agentId})` : 'Permission Request';
	}
	if (permIntro) {
		permIntro.textContent = payload.blockedPath
			? `CodeMind wants to use a tool on ${payload.blockedPath}:`
			: 'CodeMind wants to run a tool:';
	}
	if (permReason) {
		// The engine explains itself when a rule or a path is what forced the ask.
		permReason.textContent = payload.reason || '';
		permReason.classList.toggle('hidden', !payload.reason);
	}
	renderPermissionScopes(currentPermissionScopes);
	if (permFeedbackGroup) {
		permFeedbackGroup.classList.remove('hidden');
	}
	if (permFeedback) {
		permFeedback.value = '';
	}
	permissionModal.classList.remove('is-closing');
	permissionModal.classList.remove('hidden');
	setTimeout(() => permAllow.focus(), 50);
}

/**
 * One button per "and don't ask again…" option the worker offered. The label and
 * the grant both come from the worker — this only reports which one was clicked,
 * so the webview never has a say in what a rule actually permits.
 */
function renderPermissionScopes(scopes) {
	if (!permScopes) { return; }
	permScopes.textContent = '';
	permScopes.classList.toggle('hidden', scopes.length === 0);
	for (const scope of scopes) {
		if (!scope || typeof scope.id !== 'string') { continue; }
		const button = document.createElement('button');
		button.className = 'btn btn-secondary perm-scope';
		button.dataset.scopeId = scope.id;
		const label = document.createElement('span');
		label.className = 'perm-scope-label';
		label.textContent = scope.label || scope.id;
		button.appendChild(label);
		const caption = document.createElement('span');
		caption.className = 'perm-scope-store';
		caption.textContent = scope.mode
			? `${PERMISSION_STORE_LABELS[scope.store] || scope.store} · switches to ${scope.mode}`
			: (PERMISSION_STORE_LABELS[scope.store] || scope.store);
		button.appendChild(caption);
		button.addEventListener('click', () => respondToPermission('allow_scope', scope.id));
		permScopes.appendChild(button);
	}
}

/**
 * Take the permission dialog off screen (Section 6.10). The answer has already been decided
 * by the time this runs, so the hundred milliseconds it takes to leave cost nothing — and if
 * the engine asks again straight away, `showPermissionDialog` cancels the exit.
 */
function dismissPermissionDialog() {
	if (permissionModal.classList.contains('hidden')) { return; }
	playOut(permissionModal, () => permissionModal.classList.add('hidden'));
}

/**
 * decision: 'allow_once' | 'allow_scope' | 'allow_session' | 'deny'
 * `scopeId` is required for 'allow_scope' and ignored otherwise; the deny path
 * carries whatever guidance was typed into the feedback box.
 */
function respondToPermission(decision, scopeId) {
	if (!currentPermissionToolUseId) {
		dismissPermissionDialog();
		return;
	}
	// A scope id that this dialog did not offer would be a bug, not a grant.
	if (decision === 'allow_scope' && !currentPermissionScopes.some(s => s && s.id === scopeId)) {
		return;
	}
	const toolUseId = currentPermissionToolUseId;
	const feedback = decision === 'deny' && permFeedback ? permFeedback.value.trim() : '';
	dismissPermissionDialog();
	currentPermissionToolUseId = null;
	vscode.postMessage({
		type: 'permissionResponse',
		payload: {
			toolUseId,
			decision,
			allow: decision !== 'deny',
			scopeId: decision === 'allow_scope' ? scopeId : undefined,
			feedback: feedback || undefined,
		},
	});
	// Say what was remembered, so a grant that outlives the dialog is on the record.
	if (decision === 'allow_scope') {
		const chosen = currentPermissionScopes.find(s => s && s.id === scopeId);
		if (chosen) {
			appendLocalSystemMessage(`Remembered: ${chosen.label} — ${PERMISSION_STORE_LABELS[chosen.store] || chosen.store}.`);
		}
	} else if (decision === 'allow_session') {
		appendLocalSystemMessage(`Allowed every ${permToolName.textContent || 'tool'} call for the rest of this conversation.`);
	}
	currentPermissionScopes = [];
}

// ---------- Tool progress ----------
function updateToolProgress(payload) {
	// payload: { id: streamId, toolName, elapsedSeconds, toolUseId }
	// The engine gives every progress message a fresh id, so the tool it belongs
	// to arrives as `toolUseId` (its parent). When that is missing, fall back to
	// the most recently started running tool in this stream.
	const scratch = streamScratch.get(payload.id);
	if (!scratch) { return; }
	let target = payload.toolUseId ? scratch.tools.get(payload.toolUseId) : null;
	if (!target) {
		for (const [, tool] of scratch.tools) {
			if (tool.status === 'running') {
				if (!target || (tool.startedAt || 0) > (target.startedAt || 0)) {
					target = tool;
				}
			}
		}
	}
	if (target) {
		target.elapsedSeconds = payload.elapsedSeconds;
		scheduleRender();
	}
}

// ---------- Scroll anchoring (Section 5) ----------
// The transcript follows the newest content only while the reader is already at the
// bottom of it. Scrolling up turns following off; coming back to the bottom turns it
// on again. One ResizeObserver does the following, so nothing polls and nothing loops.
let autoScrollOn = true;

/** Whether the scroller is close enough to the end to count as being at it. */
function nearBottom() {
	if (!chatScrollEl) { return true; }
	return chatScrollEl.scrollTop + chatScrollEl.clientHeight >= chatScrollEl.scrollHeight - 40;
}

function wireScrollAnchor() {
	if (!chatScrollEl || !messagesEl) { return; }
	chatScrollEl.addEventListener('scroll', () => { autoScrollOn = nearBottom(); }, { passive: true });
	if (typeof ResizeObserver === 'undefined') { return; }
	// Whatever makes the transcript taller lands here — a delta, a tool card opening, an
	// image finally decoding — so the follow happens once per layout the browser had to
	// do anyway, instead of once per event that might have changed the height.
	new ResizeObserver(() => followBottom()).observe(messagesEl);
}

/** Follow the end of the transcript, if the reader is still asking to be followed. */
function followBottom() {
	if (autoScrollOn && chatScrollEl) { chatScrollEl.scrollTop = chatScrollEl.scrollHeight; }
}

/**
 * Go to the end and start following again. For the moments the panel knows the reader
 * wants the newest content — they just sent a prompt, or the transcript was replaced.
 */
function scrollToBottom() {
	autoScrollOn = true;
	if (chatScrollEl) { chatScrollEl.scrollTop = chatScrollEl.scrollHeight; }
}

/**
 * Keep one element in view without `scrollIntoView`, which Section 5 rules out: it
 * scrolls with its own animation and picks its own ancestor, and both fight the anchor
 * above. One scrollTop write, and only when the element actually left the viewport.
 */
function keepInView(el) {
	if (!chatScrollEl || !el) { return; }
	const box = el.getBoundingClientRect();
	const view = chatScrollEl.getBoundingClientRect();
	if (box.top < view.top) {
		chatScrollEl.scrollTop -= view.top - box.top;
	} else if (box.bottom > view.bottom) {
		// Never past the element's own top: a block taller than the viewport should show
		// its beginning, not its end.
		chatScrollEl.scrollTop += Math.min(box.bottom - view.bottom, box.top - view.top);
	}
}

// ---------- Helpers ----------
function escapeHtml(text) {
	if (text == null) return '';
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function escapeAttr(text) {
	return escapeHtml(text);
}

function safeStringify(value) {
	try {
		return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * The one thing the other webview scripts need from here: the shared exit animation
 * (Section 6.10), so a sheet panels.js built itself leaves the same way the dialogs
 * declared in the pane's HTML do. agent.js loads last, so this is read at call time.
 */
window.CodeMindAgent = { playOut };

init();
