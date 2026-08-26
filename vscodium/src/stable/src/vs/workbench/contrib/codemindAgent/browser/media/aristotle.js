/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Aristotle — the axolotl who sits on the right end of the composer.
//
// Four sprite strips (`media/aristotle/*.png`, cut by `scripts/aristotle-assets.py`) and a
// generated manifest describing them. Every frame of every strip is the same size and holds
// the same stage, so switching strips can never move him: only the frame index changes.
//
// The states, and what drives each one:
//
//   idle        one still, chosen by where the pointer is. He is looking at your cursor.
//   stretch     plays once when a turn starts.
//   butterfly   plays once when a turn is still running after LONG_WAIT_MS, and from then
//               on while it runs — a long wait looks different from a short one.
//   sleep       after `sleepAfterMs` of nobody touching the panel: lie down, hold the
//               bubble loop for as long as that lasts, get up when disturbed.
//
// Every state begins and ends on the idle pose. That is not enforced here — it is a property
// of the art (all three sequences open and close on the identical standing frame, which the
// asset script measured and aligned everything to), so a state change needs no bridging
// frame and an interrupted animation only has to be allowed to finish.
//
// Waking from sleep is the one case with two exits: interrupted while lying down we play the
// dedicated get-up frames, but interrupted while still lying *down* — mid-intro — we play the
// intro backwards instead. Reversing frames the pet already walked through is seamless by
// construction, where jumping into the get-up sequence from a crouch would pop.

(function () {
	'use strict';

	const M = window.CodeMindAristotleFrames;
	if (!M) {
		// The generated manifest is missing (assets never built). Export a surface that does
		// nothing so the one call site in agent.js does not have to care.
		window.CodeMindAristotle = {
			setBusy() { }, setEnabled() { }, setVisible() { }, setSleepAfterSeconds() { }, init() { },
		};
		return;
	}

	/** Frame-advance direction, so the sleep intro can be un-played to wake up. */
	const FORWARD = 1;
	const BACKWARD = -1;

	/** How long a turn has to run before stretching gives way to the butterfly. */
	const LONG_WAIT_MS = 20000;
	/** Beat of idle between two work animations, so they read as separate events. */
	const REST_MS = 2200;
	/** Pointer movement inside this many pixels of his eyes counts as "looking at me". */
	const GAZE_DEADZONE = 26;
	/** A turn ending is debounced by this much: auto-compaction posts busy→ready→busy→ready
	 *  around some turns, and without a gap he would flinch between the two. */
	const SETTLE_MS = 400;

	let host = null;      // positioned box; pointer-transparent so it never eats a click
	let layer = null;     // the element carrying the strip as its background
	let hit = null;       // body-sized, pointer-opaque: the part you can actually click

	let state = 'idle';
	let strip = 'idle';
	let frame = 0;
	let dir = FORWARD;
	/** Inclusive frame range the current state may play within. */
	let from = 0;
	let to = 0;

	let raf = 0;
	let lastStep = 0;
	let sleepTimer = 0;
	let settleTimer = 0;

	let enabled = true;
	let panelVisible = true;
	let reducedMotion = false;

	let busy = false;
	let busySince = 0;
	let restUntil = 0;
	let lastActivity = Date.now();
	let sleepAfterMs = 90000;

	let pointerX = null;
	let pointerY = null;
	let gaze = 'center';

	// ---------- geometry ----------

	/** Where his eyes are on screen right now, for the gaze maths.
	 *
	 * Cached: this is read on every animation frame, and an uncached `getBoundingClientRect`
	 * there forces layout 60 times a second for a box that only moves when the panel is
	 * resized or the composer grows a row. */
	let eyesCache = null;
	let eyesCacheAt = 0;

	function eyesAt() {
		const now = Date.now();
		if (eyesCache && now - eyesCacheAt < 250) { return eyesCache; }
		if (!host) { return null; }
		const box = host.getBoundingClientRect();
		if (!box.width) { return null; }
		eyesCacheAt = now;
		// The head is the left third of the body: he faces left, so his eyes sit well inside
		// the body rect rather than at its centre.
		eyesCache = {
			x: box.left + M.body.x + M.body.width * 0.28,
			y: box.top + M.body.y + M.body.height * 0.42,
		};
		return eyesCache;
	}


	/** Which of the nine stills points at (pointerX, pointerY). */
	function gazeFor() {
		const eyes = eyesAt();
		if (!eyes || pointerX === null) { return 'center'; }
		const dx = pointerX - eyes.x;
		const dy = pointerY - eyes.y;
		if (Math.hypot(dx, dy) < GAZE_DEADZONE) { return 'center'; }
		// Screen y grows downward; negate it so the angle reads like a compass.
		const deg = Math.atan2(-dy, dx) * 180 / Math.PI;
		const sector = Math.round(deg / 45);
		switch (((sector % 8) + 8) % 8) {
			case 0: return 'right';
			case 1: return 'top_right';
			case 2: return 'top';
			case 3: return 'top_left';
			case 4: return 'left';
			case 5: return 'bottom_left';
			case 6: return 'bottom';
			default: return 'bottom_right';
		}
	}

	// ---------- painting ----------

	function paint() {
		if (!layer) { return; }
		if (layer.dataset.strip !== strip) {
			layer.dataset.strip = strip;
			layer.style.backgroundImage = `url("${host.dataset.base}${strip}.png")`;
			layer.style.backgroundSize = `${M.counts[strip] * M.displayWidth}px ${M.displayHeight}px`;
		}
		layer.style.backgroundPositionX = `${-frame * M.displayWidth}px`;
	}

	/** Show the idle still for the current gaze. */
	function paintIdle() {
		strip = 'idle';
		frame = M.directions[gaze] ?? 0;
		paint();
	}

	// ---------- state changes ----------

	function play(nextState, nextStrip, a, b, direction) {
		state = nextState;
		strip = nextStrip;
		from = Math.min(a, b);
		to = Math.max(a, b);
		dir = direction;
		frame = direction === FORWARD ? from : to;
		lastStep = 0;
		paint();
		ensureLoop();
	}

	/**
	 * Back to standing, looking wherever the pointer is.
	 *
	 * Deliberately does not touch `restUntil`: the beat of idle between two work animations
	 * is set as the previous one ends and has to survive the return to idle, or he would
	 * replay immediately and the two would read as one continuous animation.
	 */
	function toIdle() {
		state = 'idle';
		gaze = gazeFor();
		paintIdle();
		scheduleSleep();
		ensureLoop();
	}

	/** The work animation a turn of this age should be showing. */
	function workStrip() {
		return (Date.now() - busySince >= LONG_WAIT_MS) ? 'butterfly' : 'stretch';
	}

	function startWork() {
		// With reduced motion he holds the idle pose: starting a run here would freeze him on
		// its first frame, which is the idle pose anyway, but would also leave the state
		// machine claiming to be animating.
		if (reducedMotion) { return; }
		const name = workStrip();
		play(name, name, 0, M.counts[name] - 1, FORWARD);
	}

	function startSleep() {
		if (reducedMotion) { return; }
		play('sleepIn', 'sleep', M.sleep.intro[0], M.sleep.intro[1], FORWARD);
	}

	/**
	 * Get up. Which frames that means depends on how far under he was — see the note at the
	 * top of the file.
	 */
	function wake() {
		if (state === 'sleepHold') {
			play('sleepOut', 'sleep', M.sleep.outro[0], M.sleep.outro[1], FORWARD);
		} else if (state === 'sleepIn') {
			play('sleepOut', 'sleep', M.sleep.intro[0], frame, BACKWARD);
		}
	}

	function asleep() {
		return state === 'sleepIn' || state === 'sleepHold';
	}

	// ---------- the loop ----------

	function shouldRun() {
		if (!enabled || !panelVisible || reducedMotion || !M) { return false; }
		// Idle is a single still: it only needs the loop when something is pending.
		return state !== 'idle' || busy || gaze !== gazeFor();
	}

	function ensureLoop() {
		if (!raf && shouldRun()) { raf = requestAnimationFrame(tick); }
	}

	function stopLoop() {
		if (raf) { cancelAnimationFrame(raf); raf = 0; }
	}

	function tick(now) {
		raf = 0;
		if (!shouldRun()) {
			// Settle on the still that matches wherever the pointer ended up.
			if (state === 'idle') { gaze = gazeFor(); paintIdle(); }
			return;
		}

		if (state === 'idle') {
			const next = gazeFor();
			if (next !== gaze) { gaze = next; paintIdle(); }
			if (busy && Date.now() >= restUntil) { startWork(); }
			raf = requestAnimationFrame(tick);
			return;
		}

		if (!lastStep) { lastStep = now; }
		const frameMs = 1000 / M.fps;
		const due = Math.floor((now - lastStep) / frameMs);
		if (due > 0) {
			// Advance the clock by whole frames rather than to `now`: dropping the remainder
			// makes the real frame period however long the next repaint happens to be, which
			// on an unlucky display cadence runs the animation half again too slow.
			lastStep += due * frameMs;
			frame += dir * due;
			if (dir === FORWARD ? frame >= to : frame <= from) {
				frame = dir === FORWARD ? to : from;
				endOfRun();
			} else {
				paint();
			}
		}
		ensureLoop();
	}

	/** The current run reached its last frame. */
	function endOfRun() {
		if (state === 'sleepIn') {
			// Lying down finished; hold the bubble loop until something disturbs him.
			play('sleepHold', 'sleep', M.sleep.loop[0], M.sleep.loop[1], FORWARD);
			return;
		}
		if (state === 'sleepHold') {
			frame = M.sleep.loop[0];
			lastStep = 0;
			paint();
			ensureLoop();
			return;
		}
		// stretch / butterfly / sleepOut all land on the idle pose by construction.
		if (busy && (state === 'stretch' || state === 'butterfly')) {
			restUntil = Date.now() + REST_MS;
		}
		toIdle();
	}

	// ---------- activity ----------

	function scheduleSleep() {
		if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = 0; }
		// Nodding off behind a hidden panel is not a thing anyone can see, and it would leave
		// him mid-animation with the loop stopped — so the clock only runs while he is on show.
		if (!enabled || !panelVisible || reducedMotion || busy || state !== 'idle' || sleepAfterMs <= 0) { return; }
		const due = sleepAfterMs - (Date.now() - lastActivity);
		sleepTimer = setTimeout(() => {
			sleepTimer = 0;
			if (state !== 'idle' || busy) { return; }
			// Pointer movement only stamps `lastActivity`: rescheduling this timer on every
			// mouse move would be a clearTimeout/setTimeout pair per pixel travelled. The
			// deadline is re-checked here instead, so a stale one costs one extra wait rather
			// than putting him to sleep with the pointer still moving over the panel.
			if (Date.now() - lastActivity < sleepAfterMs) { scheduleSleep(); return; }
			startSleep();
		}, Math.max(250, due));
	}

	function noteActivity() {
		lastActivity = Date.now();
		if (asleep()) { wake(); } else { scheduleSleep(); }
	}

	// ---------- public surface ----------

	/** Called from agent.js's setStatus, the one place that knows a turn is running. */
	function setBusy(next) {
		if (next === busy) { return; }
		if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
		if (next) {
			busy = true;
			busySince = Date.now();
			restUntil = 0;
			noteActivity();
			if (state === 'idle') { startWork(); }
			return;
		}
		// A turn ending is debounced: see SETTLE_MS. The animation in flight is never cut —
		// it has to reach its last frame for him to be standing again.
		settleTimer = setTimeout(() => {
			settleTimer = 0;
			busy = false;
			restUntil = 0;
			lastActivity = Date.now();
			scheduleSleep();
		}, SETTLE_MS);
	}

	function setEnabled(next) {
		enabled = next !== false;
		if (!host) { return; }
		host.classList.toggle('hidden', !enabled);
		if (!enabled) { stopLoop(); if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = 0; } return; }
		lastActivity = Date.now();
		restUntil = 0;
		toIdle();
	}

	function setVisible(next) {
		panelVisible = next !== false;
		if (!panelVisible) {
			stopLoop();
			if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = 0; }
			return;
		}
		lastActivity = Date.now();
		// Opening the panel is activity, and anything he was part-way through happened where
		// nobody could see it. Snap straight to standing rather than playing a wake-up for a
		// nap that was never watched.
		if (state !== 'idle') { state = 'idle'; restUntil = 0; }
		toIdle();
	}

	function setSleepAfterSeconds(seconds) {
		const n = Number(seconds);
		sleepAfterMs = Number.isFinite(n) && n > 0 ? n * 1000 : 0;
		scheduleSleep();
	}

	// ---------- wiring ----------

	function init() {
		host = document.getElementById('aristotle');
		if (!host || !M) { return; }
		layer = host.querySelector('.aristotle-layer');
		hit = host.querySelector('.aristotle-hit');
		if (!layer || !hit) { return; }

		reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

		// Size everything from the manifest so the numbers live in one place.
		host.style.width = `${M.displayWidth}px`;
		host.style.height = `${M.displayHeight}px`;
		// Anchor the *pet* against the composer's right edge, not the frame: the frame keeps
		// empty margin on the right for the butterfly's flight.
		host.style.setProperty('--cm-aristotle-body-right', `${M.displayWidth - (M.body.x + M.body.width)}px`);
		host.style.setProperty('--cm-aristotle-body-bottom', `${M.displayHeight - (M.body.y + M.body.height)}px`);
		Object.assign(hit.style, {
			left: `${M.body.x}px`, top: `${M.body.y}px`,
			width: `${M.body.width}px`, height: `${M.body.height}px`,
		});

		// Decode every strip up front: a first play that has to wait for a 10000px PNG shows
		// an empty box for a frame or two.
		for (const name of ['idle', 'stretch', 'butterfly', 'sleep']) {
			const img = new Image();
			img.src = `${host.dataset.base}${name}.png`;
		}

		paintIdle();

		// The pointer drives his eyes, and any movement counts as you still being here. Only
		// the coordinates are stored — the still is chosen inside the frame, never in the
		// handler, so a fast mouse cannot make this expensive.
		document.addEventListener('pointermove', (e) => {
			pointerX = e.clientX;
			pointerY = e.clientY;
			lastActivity = Date.now();
			if (asleep()) { wake(); } else if (state === 'idle') { ensureLoop(); }
		}, { passive: true });

		const input = document.getElementById('input');
		if (input) {
			input.addEventListener('input', noteActivity);
			input.addEventListener('keydown', noteActivity);
			input.addEventListener('focus', noteActivity);
		}

		// Poking him wakes him and, if nothing else is going on, gets the butterfly out.
		// `mousedown` + preventDefault rather than a real button: anything focusable here
		// would steal focus from the composer, which closes its menus, ends a reverse-history
		// search and hands workbench keybindings back mid-sentence.
		hit.addEventListener('mousedown', (e) => {
			e.preventDefault();
			noteActivity();
			if (state === 'idle' && !busy && !reducedMotion) {
				play('butterfly', 'butterfly', 0, M.counts.butterfly - 1, FORWARD);
			}
		});

		scheduleSleep();
		ensureLoop();

		// The box moves when the panel is resized or the composer grows a row, and the gaze
		// maths is the only thing that cares where it is.
		window.addEventListener('resize', () => { eyesCache = null; }, { passive: true });
	}

	window.CodeMindAristotle = { setBusy, setEnabled, setVisible, setSleepAfterSeconds, init };

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init, { once: true });
	} else {
		init();
	}
})();
