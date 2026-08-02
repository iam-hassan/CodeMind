/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// CodeMind companion sprites — the CLI's buddy/sprites.ts, unchanged data.
//
// Every sprite is 5 rows of 12 columns once `{E}` has been replaced by the eye
// character, with three frames per species for the idle fidget. Row 0 is the hat
// slot: frames 0-1 always leave it blank, frame 2 may use it for smoke, sparks or
// ears, which is why the hat is only substituted when the row is actually empty.
//
// The workbench side owns the bones (species, eye, hat, rarity, stats) because they
// have to be identical in the transcript and in the sprite; this file only knows how
// to draw them. Kept apart from agent.js so the table can be diffed against the CLI
// without scrolling past the chat surface.
(function () {
	'use strict';

	const BODIES = {
		duck: [
			['            ', '    __      ', '  <({E} )___  ', '   (  ._>   ', '    `--´    '],
			['            ', '    __      ', '  <({E} )___  ', '   (  ._>   ', '    `--´~   '],
			['            ', '    __      ', '  <({E} )___  ', '   (  .__>  ', '    `--´    '],
		],
		goose: [
			['            ', '     ({E}>    ', '     ||     ', '   _(__)_   ', '    ^^^^    '],
			['            ', '    ({E}>     ', '     ||     ', '   _(__)_   ', '    ^^^^    '],
			['            ', '     ({E}>>   ', '     ||     ', '   _(__)_   ', '    ^^^^    '],
		],
		blob: [
			['            ', '   .----.   ', '  ( {E}  {E} )  ', '  (      )  ', '   `----´   '],
			['            ', '  .------.  ', ' (  {E}  {E}  ) ', ' (        ) ', '  `------´  '],
			['            ', '    .--.    ', '   ({E}  {E})   ', '   (    )   ', '    `--´    '],
		],
		cat: [
			['            ', '   /\\_/\\    ', '  ( {E}   {E})  ', '  (  ω  )   ', '  (")_(")   '],
			['            ', '   /\\_/\\    ', '  ( {E}   {E})  ', '  (  ω  )   ', '  (")_(")~  '],
			['            ', '   /\\-/\\    ', '  ( {E}   {E})  ', '  (  ω  )   ', '  (")_(")   '],
		],
		dragon: [
			['            ', '  /^\\  /^\\  ', ' <  {E}  {E}  > ', ' (   ~~   ) ', '  `-vvvv-´  '],
			['            ', '  /^\\  /^\\  ', ' <  {E}  {E}  > ', ' (        ) ', '  `-vvvv-´  '],
			['   ~    ~   ', '  /^\\  /^\\  ', ' <  {E}  {E}  > ', ' (   ~~   ) ', '  `-vvvv-´  '],
		],
		octopus: [
			['            ', '   .----.   ', '  ( {E}  {E} )  ', '  (______)  ', '  /\\/\\/\\/\\  '],
			['            ', '   .----.   ', '  ( {E}  {E} )  ', '  (______)  ', '  \\/\\/\\/\\/  '],
			['     o      ', '   .----.   ', '  ( {E}  {E} )  ', '  (______)  ', '  /\\/\\/\\/\\  '],
		],
		owl: [
			['            ', '   /\\  /\\   ', '  (({E})({E}))  ', '  (  ><  )  ', '   `----´   '],
			['            ', '   /\\  /\\   ', '  (({E})({E}))  ', '  (  ><  )  ', '   .----.   '],
			['            ', '   /\\  /\\   ', '  (({E})(-))  ', '  (  ><  )  ', '   `----´   '],
		],
		penguin: [
			['            ', '  .---.     ', '  ({E}>{E})     ', ' /(   )\\    ', '  `---´     '],
			['            ', '  .---.     ', '  ({E}>{E})     ', ' |(   )|    ', '  `---´     '],
			['  .---.     ', '  ({E}>{E})     ', ' /(   )\\    ', '  `---´     ', '   ~ ~      '],
		],
		turtle: [
			['            ', '   _,--._   ', '  ( {E}  {E} )  ', ' /[______]\\ ', '  ``    ``  '],
			['            ', '   _,--._   ', '  ( {E}  {E} )  ', ' /[______]\\ ', '   ``  ``   '],
			['            ', '   _,--._   ', '  ( {E}  {E} )  ', ' /[======]\\ ', '  ``    ``  '],
		],
		snail: [
			['            ', ' {E}    .--.  ', '  \\  ( @ )  ', '   \\_`--´   ', '  ~~~~~~~   '],
			['            ', '  {E}   .--.  ', '  |  ( @ )  ', '   \\_`--´   ', '  ~~~~~~~   '],
			['            ', ' {E}    .--.  ', '  \\  ( @  ) ', '   \\_`--´   ', '   ~~~~~~   '],
		],
		ghost: [
			['            ', '   .----.   ', '  / {E}  {E} \\  ', '  |      |  ', '  ~`~``~`~  '],
			['            ', '   .----.   ', '  / {E}  {E} \\  ', '  |      |  ', '  `~`~~`~`  '],
			['    ~  ~    ', '   .----.   ', '  / {E}  {E} \\  ', '  |      |  ', '  ~~`~~`~~  '],
		],
		axolotl: [
			['            ', '}~(______)~{', '}~({E} .. {E})~{', '  ( .--. )  ', '  (_/  \\_)  '],
			['            ', '~}(______){~', '~}({E} .. {E}){~', '  ( .--. )  ', '  (_/  \\_)  '],
			['            ', '}~(______)~{', '}~({E} .. {E})~{', '  (  --  )  ', '  ~_/  \\_~  '],
		],
		capybara: [
			['            ', '  n______n  ', ' ( {E}    {E} ) ', ' (   oo   ) ', '  `------´  '],
			['            ', '  n______n  ', ' ( {E}    {E} ) ', ' (   Oo   ) ', '  `------´  '],
			['    ~  ~    ', '  u______n  ', ' ( {E}    {E} ) ', ' (   oo   ) ', '  `------´  '],
		],
		cactus: [
			['            ', ' n  ____  n ', ' | |{E}  {E}| | ', ' |_|    |_| ', '   |    |   '],
			['            ', '    ____    ', ' n |{E}  {E}| n ', ' |_|    |_| ', '   |    |   '],
			[' n        n ', ' |  ____  | ', ' | |{E}  {E}| | ', ' |_|    |_| ', '   |    |   '],
		],
		robot: [
			['            ', '   .[||].   ', '  [ {E}  {E} ]  ', '  [ ==== ]  ', '  `------´  '],
			['            ', '   .[||].   ', '  [ {E}  {E} ]  ', '  [ -==- ]  ', '  `------´  '],
			['     *      ', '   .[||].   ', '  [ {E}  {E} ]  ', '  [ ==== ]  ', '  `------´  '],
		],
		rabbit: [
			['            ', '   (\\__/)   ', '  ( {E}  {E} )  ', ' =(  ..  )= ', '  (")__(")  '],
			['            ', '   (|__/)   ', '  ( {E}  {E} )  ', ' =(  ..  )= ', '  (")__(")  '],
			['            ', '   (\\__/)   ', '  ( {E}  {E} )  ', ' =( .  . )= ', '  (")__(")  '],
		],
		mushroom: [
			['            ', ' .-o-OO-o-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   '],
			['            ', ' .-O-oo-O-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   '],
			['   . o  .   ', ' .-o-OO-o-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   '],
		],
		chonk: [
			['            ', '  /\\    /\\  ', ' ( {E}    {E} ) ', ' (   ..   ) ', '  `------´  '],
			['            ', '  /\\    /|  ', ' ( {E}    {E} ) ', ' (   ..   ) ', '  `------´  '],
			['            ', '  /\\    /\\  ', ' ( {E}    {E} ) ', ' (   ..   ) ', '  `------´~ '],
		],
	};

	const HAT_LINES = {
		none: '',
		crown: '   \\^^^/    ',
		tophat: '   [___]    ',
		propeller: '    -+-     ',
		halo: '   (   )    ',
		wizard: '    /^\\     ',
		beanie: '   (___)    ',
		tinyduck: '    ,>      ',
	};

	// Idle sequence: mostly rest (frame 0), occasional fidget (frames 1-2), rare
	// blink. `-1` means "blink on frame 0" — the eye is swapped for a dash.
	const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0];

	/** Hearts float up-and-out over 5 ticks (~2.5s), prepended above the sprite. */
	const PET_HEARTS = ['   ♥    ♥   ', '  ♥  ♥   ♥  ', ' ♥   ♥  ♥   ', '♥  ♥      ♥ ', '·    ·   ·  '];

	const RARITY_STARS = { common: '★', uncommon: '★★', rare: '★★★', epic: '★★★★', legendary: '★★★★★' };

	// The stat order the card draws in. The workbench sends the stats as an object and
	// object key order is not something to lean on, so the row order lives here.
	const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'];

	function frameCount(species) {
		const frames = BODIES[species];
		return frames ? frames.length : 0;
	}

	/**
	 * The rows to draw for one frame. `blink` swaps the eye for a dash, which the CLI
	 * does after `renderSprite` rather than inside it; folded in here so the caller
	 * cannot forget that the eye may be a multi-byte character.
	 */
	function renderSprite(bones, frame, blink) {
		const frames = BODIES[bones.species];
		if (!frames) {
			return [];
		}
		const eye = blink ? '-' : (bones.eye || '·');
		const lines = frames[((frame % frames.length) + frames.length) % frames.length].map(line => line.split('{E}').join(eye));
		// Only take the hat slot when the frame is not already using row 0 for smoke,
		// sparks or ears.
		if (bones.hat && bones.hat !== 'none' && !lines[0].trim()) {
			lines[0] = HAT_LINES[bones.hat] || lines[0];
		}
		// Drop the blank hat slot so a hatless companion is not a row shorter than the
		// space it reserves — only safe when every frame leaves row 0 empty, otherwise
		// the sprite's height would oscillate as the fidget frames come round.
		if (!lines[0].trim() && frames.every(f => !f[0].trim())) {
			lines.shift();
		}
		return lines;
	}

	/** The one-line face, used where there is no room for the full sprite. */
	function renderFace(bones) {
		const e = bones.eye || '·';
		switch (bones.species) {
			case 'duck':
			case 'goose': return `(${e}>`;
			case 'blob': return `(${e}${e})`;
			case 'cat': return `=${e}ω${e}=`;
			case 'dragon': return `<${e}~${e}>`;
			case 'octopus': return `~(${e}${e})~`;
			case 'owl': return `(${e})(${e})`;
			case 'penguin': return `(${e}>)`;
			case 'turtle': return `[${e}_${e}]`;
			case 'snail': return `${e}(@)`;
			case 'ghost': return `/${e}${e}\\`;
			case 'axolotl': return `}${e}.${e}{`;
			case 'capybara': return `(${e}oo${e})`;
			case 'cactus': return `|${e}  ${e}|`;
			case 'robot': return `[${e}${e}]`;
			case 'rabbit': return `(${e}..${e})`;
			case 'mushroom': return `|${e}  ${e}|`;
			case 'chonk': return `(${e}.${e})`;
			default: return `(${e}${e})`;
		}
	}

	/**
	 * Which frame to draw on tick `tick`. Excited companions (talking or being
	 * petted) cycle every frame; idle ones follow IDLE_SEQUENCE.
	 */
	function frameForTick(species, tick, excited) {
		const count = frameCount(species) || 1;
		if (excited) {
			return { frame: tick % count, blink: false };
		}
		const step = IDLE_SEQUENCE[tick % IDLE_SEQUENCE.length];
		if (step === -1) {
			return { frame: 0, blink: true };
		}
		return { frame: step % count, blink: false };
	}

	window.CodeMindBuddy = {
		IDLE_SEQUENCE,
		PET_HEARTS,
		RARITY_STARS,
		STAT_NAMES,
		TICK_MS: 500,
		/** Ticks a speech bubble stays up (~10s), and the last ~3s it dims. */
		BUBBLE_SHOW: 20,
		FADE_WINDOW: 6,
		PET_BURST_MS: 2500,
		species: () => Object.keys(BODIES),
		frameCount,
		frameForTick,
		renderSprite,
		renderFace,
	};
})();
