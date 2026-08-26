// Headless check of media/aristotle.js: drive the state machine with a fake DOM and a fake
// clock, and assert the transitions the feature is specified by.
//
//   node scripts/aristotle-selftest.mjs
//
// The module is a browser script that talks to the DOM, requestAnimationFrame and
// matchMedia, so this stubs exactly those and nothing else — the logic under test is the
// real file, loaded from disk, not a copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(here, '..', 'vscodium', 'src', 'stable', 'src', 'vs', 'workbench',
	'contrib', 'codemindAgent', 'browser', 'media');

let now = 1_000_000;
let rafQueue = [];
let timers = [];
let nextTimer = 1;

function el(id) {
	return {
		id,
		dataset: {},
		style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } },
		classList: {
			set: new Set(),
			toggle(c, on) { if (on) { this.set.add(c); } else { this.set.delete(c); } },
			add(c) { this.set.add(c); },
			contains(c) { return this.set.has(c); },
		},
		listeners: {},
		addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
		querySelector(sel) { return this.children[sel] ?? null; },
		// A fixed box: 131x62 with his eyes around (838, 526).
		getBoundingClientRect() { return { left: 800, top: 500, width: 131, height: 62 }; },
		children: {},
	};
}

const host = el('aristotle');
host.dataset.base = 'stub://aristotle/';
const layer = el('layer');
const hit = el('hit');
host.children['.aristotle-layer'] = layer;
host.children['.aristotle-hit'] = hit;
const input = el('input');

const documentStub = {
	readyState: 'complete',
	listeners: {},
	addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
	getElementById(id) { return id === 'aristotle' ? host : id === 'input' ? input : null; },
};

const sandbox = {
	console,
	Image: class { set src(_v) { /* preloading is fire-and-forget */ } },
	Math, Number, Date: { now: () => now },
	Object, String, Boolean, Set, Map, JSON, Array, isNaN, parseInt, parseFloat,
	document: documentStub,
	window: { matchMedia: () => ({ matches: false }), addEventListener() { } },
	requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
	cancelAnimationFrame(id) { rafQueue[id - 1] = null; },
	setTimeout(fn, ms) { timers.push({ id: nextTimer, at: now + ms, fn }); return nextTimer++; },
	clearTimeout(id) { timers = timers.filter(t => t.id !== id); },
};
sandbox.window.window = sandbox.window;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
vm.runInContext(readFileSync(join(MEDIA, 'aristotle', 'manifest.js'), 'utf8'), context, { filename: 'manifest.js' });
vm.runInContext(readFileSync(join(MEDIA, 'aristotle.js'), 'utf8'), context, { filename: 'aristotle.js' });

const M = sandbox.window.CodeMindAristotleFrames;
const pet = sandbox.window.CodeMindAristotle;

/** Advance the fake clock, firing due timers and draining rAF callbacks. */
function advance(ms, stepMs = 16) {
	const end = now + ms;
	while (now < end) {
		now = Math.min(end, now + stepMs);
		for (const t of timers.filter(t => t.at <= now)) {
			timers = timers.filter(x => x.id !== t.id);
			t.fn();
		}
		const queue = rafQueue;
		rafQueue = [];
		for (const fn of queue) { if (fn) { fn(now); } }
	}
}

/** What is on screen: which strip, and which frame of it. */
function shown() {
	const px = parseFloat(String(layer.style.backgroundPositionX ?? '0'));
	return { strip: layer.dataset.strip, frame: Math.round(-px / M.displayWidth) };
}

/** One full pass of a strip, plus the frame the loop spends deciding it is done. */
const runMs = name => (M.counts[name] / M.fps) * 1000 + 500;

/** Move the pointer, which is both a gaze change and a sign of life. */
const move = (x, y) => {
	for (const fn of documentStub.listeners.pointermove) { fn({ clientX: x, clientY: y }); }
	advance(80);
};

let failures = 0;
function check(label, cond, extra = '') {
	if (cond) {
		console.log(`  ok    ${label}`);
	} else {
		failures++;
		console.log(`  FAIL  ${label}${extra ? '  - ' + extra : ''}`);
	}
}

console.log('manifest:', JSON.stringify({ counts: M.counts, sleep: M.sleep, body: M.body }));

console.log('\nidle');
check('starts on the idle strip, centre frame',
	shown().strip === 'idle' && shown().frame === M.directions.center, JSON.stringify(shown()));
check('anchors by the pet, not by the frame',
	host.style['--cm-aristotle-body-right'] === `${M.displayWidth - (M.body.x + M.body.width)}px`);
check('hit area is the body rect',
	hit.style.width === `${M.body.width}px` && hit.style.height === `${M.body.height}px`);

console.log('\ngaze follows the pointer');
move(400, 520);
check('looking left', shown().frame === M.directions.left || shown().frame === M.directions.top_left, JSON.stringify(shown()));
move(1400, 900);
check('looking bottom_right', shown().frame === M.directions.bottom_right, JSON.stringify(shown()));
move(838, 526);
check('deadzone re-centres', shown().frame === M.directions.center, JSON.stringify(shown()));

console.log('\na turn starts: stretch, then back to idle');
pet.setBusy(true);
advance(40);
check('stretch begins at once', shown().strip === 'stretch' && shown().frame <= 1, JSON.stringify(shown()));
advance(runMs('stretch') / 2);
check('stretch is advancing', shown().strip === 'stretch' && shown().frame > 10, JSON.stringify(shown()));
// He keeps working for as long as the turn runs, so what to look for here is that he passes
// back through idle between animations rather than running two of them together.
let sawIdle = false;
let sawWork = false;
for (let i = 0; i < 60; i++) {
	advance(250);
	if (shown().strip === 'idle') { sawIdle = true; }
	if (shown().strip === 'stretch' || shown().strip === 'butterfly') { sawWork = true; }
}
check('returns to idle between animations while the turn runs', sawIdle && sawWork, `idle=${sawIdle} work=${sawWork}`);

console.log('\nstill working after 20s: the butterfly takes over');
advance(21_000);
advance(runMs('butterfly') / 3);
check('butterfly is playing and advancing',
	shown().strip === 'butterfly' && shown().frame > 5, JSON.stringify(shown()));

console.log('\nthe turn ends mid-animation');
pet.setBusy(false);
advance(250);
check('the animation is not cut', shown().strip === 'butterfly', JSON.stringify(shown()));
advance(runMs('butterfly'));
check('it finishes, then he settles on idle', shown().strip === 'idle', JSON.stringify(shown()));

console.log('\nleft alone: falls asleep');
pet.setSleepAfterSeconds(90);
move(838, 526);                        // the 90s clock starts here
advance(89_000, 500);
check('still awake at 89s', shown().strip === 'idle', JSON.stringify(shown()));
advance(2_000);
check('asleep just after 90s', shown().strip === 'sleep', JSON.stringify(shown()));
advance(runMs('sleep'));
const held = shown().frame;
check('holds inside the bubble loop', held >= M.sleep.loop[0] && held <= M.sleep.loop[1],
	`frame ${held}, loop ${JSON.stringify(M.sleep.loop)}`);
advance(8_000);
const stillHeld = shown().frame;
check('keeps looping, never runs off the end',
	stillHeld >= M.sleep.loop[0] && stillHeld <= M.sleep.loop[1], `frame ${stillHeld}`);

console.log('\ndisturbed while lying down: plays the get-up frames');
move(600, 700);
advance(40);
check('in the get-up range',
	shown().strip === 'sleep' && shown().frame >= M.sleep.outro[0], JSON.stringify(shown()));
advance(runMs('sleep'));
check('awake and idle again', shown().strip === 'idle', JSON.stringify(shown()));

console.log('\ndisturbed part-way into the nap: un-plays the intro');
move(838, 526);
advance(89_900, 500);                  // right up to the edge of dozing off
advance(500);                          // a few frames into lying down
const partway = shown().frame;
check('caught during the lie-down',
	shown().strip === 'sleep' && partway > 0 && partway < M.sleep.loop[0], `frame ${partway}`);
move(650, 660);
advance(1000 / M.fps + 40);
check('rewinding, not jumping to the get-up frames',
	shown().strip === 'sleep' && shown().frame < partway, `was ${partway}, now ${shown().frame}`);
advance(runMs('sleep'));
check('back to idle', shown().strip === 'idle', JSON.stringify(shown()));

console.log('\na turn beats the nap');
move(838, 526);
advance(91_000, 500);
check('asleep', shown().strip === 'sleep', JSON.stringify(shown()));
pet.setBusy(true);
advance(40);
check('a turn starts him getting up', shown().strip === 'sleep', JSON.stringify(shown()));
advance(runMs('sleep'));
check('then he works', shown().strip === 'stretch' || shown().strip === 'butterfly', JSON.stringify(shown()));
pet.setBusy(false);
advance(runMs('butterfly') + runMs('stretch'));
check('and settles back to idle', shown().strip === 'idle', JSON.stringify(shown()));

console.log('\nswitched off');
pet.setEnabled(false);
check('hidden', host.classList.contains('hidden'));
advance(200_000, 1000);
check('no frame loop left running', rafQueue.filter(Boolean).length === 0);
check('and no nap scheduled', timers.length === 0, `${timers.length} timer(s) pending`);
pet.setEnabled(true);
check('shown again, on idle',
	!host.classList.contains('hidden') && shown().strip === 'idle', JSON.stringify(shown()));

console.log('\npanel hidden');
pet.setVisible(false);
advance(200_000, 1000);
check('frame loop stopped while hidden', rafQueue.filter(Boolean).length === 0);
check('did not doze off where nobody could see', shown().strip === 'idle', JSON.stringify(shown()));
pet.setVisible(true);
advance(120);
check('awake and idle on return', shown().strip === 'idle', JSON.stringify(shown()));

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
