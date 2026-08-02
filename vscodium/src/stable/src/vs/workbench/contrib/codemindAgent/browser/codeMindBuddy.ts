/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// The CLI's companion (`buddy/`), ported whole: a small ASCII creature that sits
// beside the composer, is deterministic per user, and occasionally says something.
//
// Two halves, exactly as in the CLI. The *bones* — species, eye, hat, rarity and
// stats — are a pure function of `hash(seed + SALT)` and are never persisted, so a
// hand-edited settings file cannot fake a legendary and re-ordering `SPECIES` can
// never corrupt a companion someone already has. The *soul* — name, personality and
// hatch time — is written by the model once, at hatch, and is the only part stored.
//
// The drawing lives in `media/buddy.js`; this file owns the numbers so the sprite
// beside the composer and the card in the transcript can never disagree.

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type CodeMindRarity = (typeof RARITIES)[number];

/**
 * The 18 species, in the CLI's order — the order is part of the hash, so a
 * companion only stays the same creature as long as this list does.
 */
export const SPECIES = [
	'duck', 'goose', 'blob', 'cat', 'dragon', 'octopus', 'owl', 'penguin', 'turtle',
	'snail', 'ghost', 'axolotl', 'capybara', 'cactus', 'robot', 'rabbit', 'mushroom', 'chonk',
] as const;
export type CodeMindSpecies = (typeof SPECIES)[number];

export const EYES = ['·', '✦', '×', '◉', '@', '°'] as const;
export type CodeMindEye = (typeof EYES)[number];

export const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck'] as const;
export type CodeMindHat = (typeof HATS)[number];

export const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'] as const;
export type CodeMindStatName = (typeof STAT_NAMES)[number];

export const RARITY_WEIGHTS: Record<CodeMindRarity, number> = {
	common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1,
};

export const RARITY_STARS: Record<CodeMindRarity, string> = {
	common: '★', uncommon: '★★', rare: '★★★', epic: '★★★★', legendary: '★★★★★',
};

/** Rarity raises the floor every stat is rolled from. */
const RARITY_FLOOR: Record<CodeMindRarity, number> = {
	common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50,
};

/** The deterministic half — regenerated from the seed on every read. */
export interface ICodeMindCompanionBones {
	readonly rarity: CodeMindRarity;
	readonly species: CodeMindSpecies;
	readonly eye: CodeMindEye;
	readonly hat: CodeMindHat;
	readonly shiny: boolean;
	readonly stats: Record<CodeMindStatName, number>;
}

/** The model-written half, and the only part that is stored. */
export interface ICodeMindCompanionSoul {
	readonly name: string;
	readonly personality: string;
	readonly hatchedAt: number;
	/**
	 * What the bones were rolled from. The CLI uses the account uuid, which it always
	 * has; the panel may not know an account yet at hatch time, so whatever it used is
	 * recorded here and the creature stays itself even after a sign-in.
	 */
	readonly seed: string;
}

export type ICodeMindCompanion = ICodeMindCompanionBones & ICodeMindCompanionSoul;

/** What the webview needs to draw the sprite and the card. */
export interface ICodeMindCompanionView extends ICodeMindCompanion {
	/** Muted companions are hidden and say nothing, but are not forgotten. */
	readonly muted: boolean;
	readonly stars: string;
}

// Mulberry32 — tiny seeded PRNG, good enough for picking ducks.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// FNV-1a. The CLI prefers `Bun.hash` when it is running under Bun and falls back to
// this; the panel has no Bun, so this branch is the only one — which also means a
// companion hatched in the CLI under Bun is a different creature from the same seed.
function hashString(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
	return arr[Math.floor(rng() * arr.length)];
}

function rollRarity(rng: () => number): CodeMindRarity {
	const total = RARITIES.reduce((sum, rarity) => sum + RARITY_WEIGHTS[rarity], 0);
	let roll = rng() * total;
	for (const rarity of RARITIES) {
		roll -= RARITY_WEIGHTS[rarity];
		if (roll < 0) {
			return rarity;
		}
	}
	return 'common';
}

/** One peak stat, one dump stat, the rest scattered. Rarity bumps the floor. */
function rollStats(rng: () => number, rarity: CodeMindRarity): Record<CodeMindStatName, number> {
	const floor = RARITY_FLOOR[rarity];
	const peak = pick(rng, STAT_NAMES);
	let dump = pick(rng, STAT_NAMES);
	while (dump === peak) {
		dump = pick(rng, STAT_NAMES);
	}

	const stats = {} as Record<CodeMindStatName, number>;
	for (const name of STAT_NAMES) {
		if (name === peak) {
			stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30));
		} else if (name === dump) {
			stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15));
		} else {
			stats[name] = floor + Math.floor(rng() * 40);
		}
	}
	return stats;
}

const SALT = 'friend-2026-401';

let rollCache: { key: string; value: ICodeMindCompanionBones } | undefined;

/**
 * The bones for a seed. Called from the sprite push, the hatch flow and every
 * settings change with the same seed, so the deterministic result is cached the way
 * the CLI caches it for its 500ms sprite tick.
 */
export function rollCompanionBones(seed: string): ICodeMindCompanionBones {
	const key = seed + SALT;
	if (rollCache?.key === key) {
		return rollCache.value;
	}
	const rng = mulberry32(hashString(key));
	const rarity = rollRarity(rng);
	const value: ICodeMindCompanionBones = {
		rarity,
		species: pick(rng, SPECIES),
		eye: pick(rng, EYES),
		hat: rarity === 'common' ? 'none' : pick(rng, HATS),
		shiny: rng() < 0.01,
		stats: rollStats(rng, rarity),
	};
	rollCache = { key, value };
	return value;
}

/**
 * The system-prompt section, verbatim from the CLI. Appended rather than injected as
 * an attachment: the panel has no attachment channel into the preset prompt, and the
 * effect is the same — the main model is told to keep out of the bubble's way.
 */
export function companionIntroText(name: string, species: string): string {
	return `# Companion

A small ${species} named ${name} sits beside the user's input box and occasionally comments in a speech bubble. You're not ${name} — it's a separate watcher.

When the user addresses ${name} directly (by name), its bubble will answer. Your job in that moment is to stay out of the way: respond in ONE line or less, or just answer any part of the message meant for you. Don't explain that you're not ${name} — they know. Don't narrate what ${name} might say — the bubble handles that.`;
}

/** The hatch question. Answered by an isolated one-shot turn, so it carries its own context. */
export function companionHatchPrompt(bones: ICodeMindCompanionBones): string {
	const stats = STAT_NAMES.map(name => `${name} ${bones.stats[name]}`).join(', ');
	return `A ${bones.rarity} ${bones.species}${bones.shiny ? ' (shiny)' : ''} has just hatched beside a programmer's editor. `
		+ `Its eyes are "${bones.eye}"${bones.hat === 'none' ? '' : `, it is wearing a ${bones.hat}`}. Stats: ${stats}.\n\n`
		+ `Give it a name and a personality. The name is one word, easy to type, not a pun on "code" or "AI". `
		+ `The personality is one sentence describing how it reacts to a long day of programming — let the stats show through.\n\n`
		+ `Answer with exactly two lines and nothing else:\nName: <name>\nPersonality: <one sentence>`;
}

/**
 * The bubble question. The CLI fires an observer over the whole message list; the
 * panel sends the last exchange only, because its side questions run in a clean
 * session and a quip is not worth re-sending a transcript for.
 */
export function companionReactionPrompt(companion: ICodeMindCompanion, lastUser: string, lastAgent: string, addressed: boolean): string {
	const clip = (text: string, max: number) => {
		const flat = text.replace(/\s+/g, ' ').trim();
		return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
	};
	const scene = `You are ${companion.name}, a ${companion.rarity} ${companion.species} sitting beside a programmer's editor. `
		+ `Personality: ${companion.personality}\n\n`
		+ `They just said: "${clip(lastUser, 400)}"\n`
		+ `Their coding agent answered: "${clip(lastAgent, 400)}"\n\n`;
	return addressed
		? `${scene}They spoke to you by name. Answer them in one short line, in character. No quotes, no emoji, at most 20 words.`
		: `${scene}Say one short thing about it, in character — a remark, not a summary, and never advice. `
		+ `No quotes, no emoji, at most 12 words. If nothing is worth saying, answer exactly: (nothing)`;
}

/** Pull `Name:` / `Personality:` out of a hatch answer, or nothing if it did not comply. */
export function parseCompanionSoul(text: string): { name: string; personality: string } | undefined {
	const name = /^\s*name\s*:\s*(.+)$/im.exec(text)?.[1]?.trim().replace(/^["'`*]+|["'`*.]+$/g, '');
	const personality = /^\s*personality\s*:\s*(.+)$/im.exec(text)?.[1]?.trim().replace(/^["'`*]+|["'`*]+$/g, '');
	if (!name || !personality) {
		return undefined;
	}
	// A name long enough to break the sprite's name row is a sign the model wrote a
	// sentence instead; take its first word rather than throwing the hatch away.
	const single = name.split(/\s+/)[0].slice(0, 16);
	return { name: single, personality: personality.slice(0, 240) };
}

/** The plain-text card, used for the hatch announcement in the transcript. */
export function describeCompanion(companion: ICodeMindCompanion): string {
	const stats = STAT_NAMES.map(name => `${name} ${String(companion.stats[name]).padStart(3, ' ')}`).join('  ');
	const hat = companion.hat === 'none' ? '' : `, wearing a ${companion.hat}`;
	// Plain text on purpose: the transcript shows system output verbatim (Section 3.17),
	// so `**name**` and `_soul_` would put the asterisks and underscores on screen.
	return `${companion.name} — ${companion.rarity} ${companion.species} ${RARITY_STARS[companion.rarity]}`
		+ `${companion.shiny ? ' ✨ shiny' : ''}${hat}\n\n`
		+ `${companion.personality}\n\n`
		+ `${stats}`;
}
