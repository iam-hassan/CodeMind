/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// CodeMind composer editing engine — the CLI's own input stack, ported to a
// <textarea>. Two layers sit on top of each other:
//
//   * readline (emacs): Ctrl+B/E/F/K/U/W/Y/D/H/N/P, Alt+B/F/D/Y, a kill ring
//     that accumulates consecutive kills, yank and yank-pop, backslash + Enter
//     continuation, double-Escape to clear, Ctrl+_ undo, Ctrl+S stash, and the
//     Ctrl+X chord prefix with Ctrl+X Ctrl+E (edit-and-execute).
//   * vim NORMAL mode: counts, the d/c/y operators over motions and text
//     objects, f/F/t/T with ;/,, r, ~, J, >>/<<, p/P, D/C/Y, x, and dot-repeat.
//
// Nothing here reads the DOM. The caller hands in a host that can read and write
// the composer text and caret, so the state machine can be reasoned about on its
// own and the textarea stays the only thing that draws.
//
// Where the CLI works in wrapped (visual) lines this works in logical ones: a
// browser does not expose where a <textarea> wrapped a line, and Home/End/Up/Down
// already move by visual line natively.
(function () {
	'use strict';

	// ---------- Grapheme boundaries ----------
	// Every offset the engine produces sits on a grapheme boundary, so an emoji or
	// a combining sequence counts as one character to x, h, l and backspace alike.

	const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
		? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
		: null;
	const wordSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
		? new Intl.Segmenter(undefined, { granularity: 'word' })
		: null;

	// Small FIFO caches: a keystroke walks the same string many times, and an
	// operator walks the text it just produced too.
	const graphemeCaches = new Map();
	const wordCaches = new Map();

	function remember(cache, key, value) {
		if (cache.size >= 4) { cache.delete(cache.keys().next().value); }
		cache.set(key, value);
		return value;
	}

	/** Lookup tables for the grapheme start at, after and before every offset. */
	function tables(text) {
		const hit = graphemeCaches.get(text);
		if (hit) { return hit; }
		const starts = [];
		if (graphemeSegmenter) {
			for (const part of graphemeSegmenter.segment(text)) { starts.push(part.index); }
		} else {
			// No Intl.Segmenter: code points are still better than code units.
			for (let i = 0; i < text.length;) {
				starts.push(i);
				i += String.fromCodePoint(text.codePointAt(i)).length;
			}
		}
		starts.push(text.length);
		const at = new Int32Array(text.length + 1);
		const next = new Int32Array(text.length + 1);
		const prev = new Int32Array(text.length + 1);
		for (let k = 0; k + 1 < starts.length; k++) {
			const from = starts[k];
			const to = starts[k + 1];
			for (let i = from; i < to; i++) {
				at[i] = from;
				next[i] = to;
				prev[i] = i > from ? from : (k > 0 ? starts[k - 1] : 0);
			}
		}
		at[text.length] = text.length;
		next[text.length] = text.length;
		prev[text.length] = starts.length > 1 ? starts[starts.length - 2] : 0;
		return remember(graphemeCaches, text, { starts, at, next, prev });
	}

	function clamp(value, max) { return Math.max(0, Math.min(value, max)); }
	function nextOffset(text, pos) { return tables(text).next[clamp(pos, text.length)]; }
	function prevOffset(text, pos) { return tables(text).prev[clamp(pos, text.length)]; }
	function snap(text, pos) { return tables(text).at[clamp(pos, text.length)]; }
	function graphemeAt(text, pos) {
		return pos < 0 || pos >= text.length ? '' : text.slice(pos, nextOffset(text, pos));
	}
	function lastGrapheme(text) { return text ? text.slice(prevOffset(text, text.length)) : ''; }

	/** The rightmost offset NORMAL mode may rest on: over the last grapheme, not past it. */
	function maxNormalOffset(text) {
		return Math.max(0, text.length - (lastGrapheme(text).length || 1));
	}

	/** Word segments, as the readline layer's word motions see them. */
	function wordBoundaries(text) {
		const hit = wordCaches.get(text);
		if (hit) { return hit; }
		const parts = [];
		if (wordSegmenter) {
			for (const part of wordSegmenter.segment(text)) {
				parts.push({
					start: part.index,
					end: part.index + part.segment.length,
					isWordLike: !!part.isWordLike,
				});
			}
		} else {
			const pattern = /[\p{L}\p{N}\p{M}_]+/gu;
			let match = pattern.exec(text);
			while (match) {
				parts.push({ start: match.index, end: match.index + match[0].length, isWordLike: true });
				match = pattern.exec(text);
			}
		}
		return remember(wordCaches, text, parts);
	}

	// ---------- Character classes ----------
	// Vim's three classes: word characters, whitespace, and everything else.
	const VIM_WORD_CHAR = /^[\p{L}\p{N}\p{M}_]$/u;
	function isWordChar(ch) { return !!ch && VIM_WORD_CHAR.test(ch); }
	function isSpace(ch) { return !!ch && /\s/.test(ch); }
	function isPunct(ch) { return !!ch && !isSpace(ch) && !isWordChar(ch); }
	function classOf(ch) { return isWordChar(ch) ? isWordChar : (isPunct(ch) ? isPunct : null); }

	// ---------- Readline word motions (segmenter-based) ----------

	function nextWord(text, offset) {
		if (offset >= text.length) { return offset; }
		for (const part of wordBoundaries(text)) {
			if (part.isWordLike && part.start > offset) { return part.start; }
		}
		return text.length;
	}

	function prevWord(text, offset) {
		if (offset <= 0) { return 0; }
		let candidate = null;
		for (const part of wordBoundaries(text)) {
			if (!part.isWordLike || part.start >= offset) { continue; }
			if (offset <= part.end) { return part.start; }
			candidate = part.start;
		}
		return candidate === null ? 0 : candidate;
	}

	// ---------- Vim word motions ----------

	function nextVimWord(text, offset) {
		if (offset >= text.length) { return offset; }
		let pos = offset;
		const same = classOf(graphemeAt(text, pos));
		if (same) {
			while (pos < text.length && same(graphemeAt(text, pos))) { pos = nextOffset(text, pos); }
		}
		while (pos < text.length && isSpace(graphemeAt(text, pos))) { pos = nextOffset(text, pos); }
		return pos;
	}

	function endOfVimWord(text, offset) {
		if (offset >= text.length) { return offset; }
		let pos = nextOffset(text, offset);
		while (pos < text.length && isSpace(graphemeAt(text, pos))) { pos = nextOffset(text, pos); }
		if (pos >= text.length) { return text.length; }
		const same = classOf(graphemeAt(text, pos));
		if (same) {
			for (;;) {
				const ahead = nextOffset(text, pos);
				if (ahead >= text.length || !same(graphemeAt(text, ahead))) { break; }
				pos = ahead;
			}
		}
		return pos;
	}

	function prevVimWord(text, offset) {
		if (offset <= 0) { return 0; }
		let pos = prevOffset(text, offset);
		while (pos > 0 && isSpace(graphemeAt(text, pos))) { pos = prevOffset(text, pos); }
		if (isSpace(graphemeAt(text, pos))) { return 0; }
		const same = classOf(graphemeAt(text, pos));
		if (same) {
			while (pos > 0 && same(graphemeAt(text, prevOffset(text, pos)))) { pos = prevOffset(text, pos); }
		}
		return pos;
	}

	function nextWORD(text, offset) {
		let pos = offset;
		while (pos < text.length && !isSpace(graphemeAt(text, pos))) { pos = nextOffset(text, pos); }
		while (pos < text.length && isSpace(graphemeAt(text, pos))) { pos = nextOffset(text, pos); }
		return pos;
	}

	function endOfWORD(text, offset) {
		if (offset >= text.length) { return offset; }
		let pos = offset;
		const ahead = nextOffset(text, pos);
		const alreadyAtEnd = !isSpace(graphemeAt(text, pos))
			&& (ahead >= text.length || isSpace(graphemeAt(text, ahead)));
		if (alreadyAtEnd) { return endOfWORD(text, ahead); }
		if (isSpace(graphemeAt(text, pos))) { pos = nextWORD(text, pos); }
		while (pos < text.length && !isSpace(graphemeAt(text, nextOffset(text, pos)))) {
			pos = nextOffset(text, pos);
		}
		return pos;
	}

	function prevWORD(text, offset) {
		let pos = offset;
		if (isSpace(graphemeAt(text, prevOffset(text, pos)))) { pos = prevOffset(text, pos); }
		while (pos > 0 && isSpace(graphemeAt(text, pos))) { pos = prevOffset(text, pos); }
		if (!isSpace(graphemeAt(text, pos))) {
			while (pos > 0 && !isSpace(graphemeAt(text, prevOffset(text, pos)))) { pos = prevOffset(text, pos); }
		}
		return pos;
	}
	// ---------- Line helpers ----------

	function lineStart(text, offset) { return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1; }
	function lineEnd(text, offset) {
		const found = text.indexOf('\n', offset);
		return found === -1 ? text.length : found;
	}
	function firstNonBlank(text, offset) {
		const from = lineStart(text, offset);
		const match = /\S/.exec(text.slice(from, lineEnd(text, offset)));
		return from + (match ? match.index : 0);
	}
	function upLine(text, offset) {
		const from = lineStart(text, offset);
		if (from === 0) { return 0; }
		const aboveEnd = from - 1;
		const aboveStart = lineStart(text, aboveEnd);
		return snap(text, Math.min(aboveStart + (offset - from), aboveEnd));
	}
	function downLine(text, offset) {
		const from = lineStart(text, offset);
		const to = lineEnd(text, offset);
		if (to >= text.length) { return text.length; }
		const belowStart = to + 1;
		return snap(text, Math.min(belowStart + (offset - from), lineEnd(text, belowStart)));
	}
	function startOfLastLine(text) {
		const found = text.lastIndexOf('\n');
		return found === -1 ? 0 : found + 1;
	}
	/** Start of the 1-indexed logical line `line`, clamped to the buffer. */
	function goToLine(text, line) {
		const lines = text.split('\n');
		const target = clamp(line - 1, lines.length - 1);
		let offset = 0;
		for (let i = 0; i < target; i++) { offset += lines[i].length + 1; }
		return offset;
	}
	function lineIndexAt(text, offset) {
		let index = 0;
		for (let i = 0; i < offset && i < text.length; i++) {
			if (text[i] === '\n') { index++; }
		}
		return index;
	}
	function lineStartOffset(lines, index) {
		return lines.slice(0, index).join('\n').length + (index > 0 ? 1 : 0);
	}

	// ---------- Kill ring ----------
	// Consecutive kills accumulate into one entry, so Ctrl+W Ctrl+W Ctrl+Y yanks
	// both words back in the order they were killed.

	const KILL_RING_MAX_SIZE = 10;
	let killRing = [];
	let killRingIndex = 0;
	let lastActionWasKill = false;
	let yankAnchor = { start: 0, length: 0, active: false };

	function pushToKillRing(text, direction) {
		if (!text) { return; }
		if (lastActionWasKill && killRing.length > 0) {
			killRing[0] = direction === 'prepend' ? text + killRing[0] : killRing[0] + text;
		} else {
			killRing.unshift(text);
			while (killRing.length > KILL_RING_MAX_SIZE) { killRing.pop(); }
		}
		lastActionWasKill = true;
		yankAnchor.active = false;
	}
	function getLastKill() { return killRing[0] || ''; }
	function recordYank(start, length) {
		yankAnchor = { start, length, active: true };
		killRingIndex = 0;
	}
	function yankPop() {
		if (!yankAnchor.active || killRing.length <= 1) { return null; }
		killRingIndex = (killRingIndex + 1) % killRing.length;
		return { text: killRing[killRingIndex] || '', start: yankAnchor.start, length: yankAnchor.length };
	}
	function resetKillAccumulation() { lastActionWasKill = false; }
	function resetYankState() { yankAnchor.active = false; killRingIndex = 0; }

	// ---------- Deletions that feed the kill ring ----------
	// Each returns the new text, the new offset, and what was removed.

	function deleteToLineStart(text, offset) {
		if (offset > 0 && text[offset - 1] === '\n') {
			return { text: text.slice(0, offset - 1) + text.slice(offset), offset: offset - 1, killed: '\n' };
		}
		const from = lineStart(text, offset);
		return { text: text.slice(0, from) + text.slice(offset), offset: from, killed: text.slice(from, offset) };
	}
	function deleteToLineEnd(text, offset) {
		if (text[offset] === '\n') {
			return { text: text.slice(0, offset) + text.slice(offset + 1), offset, killed: '\n' };
		}
		const to = lineEnd(text, offset);
		return { text: text.slice(0, offset) + text.slice(to), offset, killed: text.slice(offset, to) };
	}
	function deleteWordBefore(text, offset) {
		if (offset <= 0) { return { text, offset, killed: '' }; }
		const from = prevWord(text, offset);
		return { text: text.slice(0, from) + text.slice(offset), offset: from, killed: text.slice(from, offset) };
	}
	function deleteWordAfter(text, offset) {
		if (offset >= text.length) { return { text, offset, killed: '' }; }
		const to = nextWord(text, offset);
		return { text: text.slice(0, offset) + text.slice(to), offset, killed: text.slice(offset, to) };
	}

	// ---------- f / F / t / T ----------

	function findCharacter(text, offset, char, type, count) {
		const forward = type === 'f' || type === 't';
		const till = type === 't' || type === 'T';
		let seen = 0;
		if (forward) {
			for (let pos = nextOffset(text, offset); pos < text.length; pos = nextOffset(text, pos)) {
				if (graphemeAt(text, pos) !== char) { continue; }
				if (++seen === count) { return till ? Math.max(offset, prevOffset(text, pos)) : pos; }
			}
			return null;
		}
		if (offset === 0) { return null; }
		for (let pos = prevOffset(text, offset); ; pos = prevOffset(text, pos)) {
			if (graphemeAt(text, pos) === char && ++seen === count) {
				return till ? Math.min(offset, nextOffset(text, pos)) : pos;
			}
			if (pos === 0) { return null; }
		}
	}
	// ---------- Text objects (iw, aw, i(, a", …) ----------

	const PAIRS = {
		'(': ['(', ')'], ')': ['(', ')'], b: ['(', ')'],
		'[': ['[', ']'], ']': ['[', ']'],
		'{': ['{', '}'], '}': ['{', '}'], B: ['{', '}'],
		'<': ['<', '>'], '>': ['<', '>'],
	};
	const QUOTES = ['"', '\'', '`'];

	function findWordObject(text, offset, isInner, isMember) {
		const starts = tables(text).starts;
		const count = starts.length - 1;
		if (count <= 0) { return null; }
		const offsetOf = (index) => (index < count ? starts[index] : text.length);
		const at = (index) => (index >= 0 && index < count ? text.slice(starts[index], starts[index + 1]) : '');
		let index = count - 1;
		for (let i = 0; i < count; i++) {
			if (offset >= starts[i] && offset < starts[i + 1]) { index = i; break; }
		}
		let from = index;
		let to = index;
		const blank = (i) => isSpace(at(i));
		if (isMember(at(index))) {
			while (from > 0 && isMember(at(from - 1))) { from--; }
			while (to < count && isMember(at(to))) { to++; }
		} else if (blank(index)) {
			// A run of whitespace is its own object, inner and around alike.
			while (from > 0 && blank(from - 1)) { from--; }
			while (to < count && blank(to)) { to++; }
			return { start: offsetOf(from), end: offsetOf(to) };
		} else if (isPunct(at(index))) {
			while (from > 0 && isPunct(at(from - 1))) { from--; }
			while (to < count && isPunct(at(to))) { to++; }
		}
		if (!isInner) {
			// `aw` takes the trailing whitespace, or the leading run when there is none.
			if (to < count && blank(to)) {
				while (to < count && blank(to)) { to++; }
			} else if (from > 0 && blank(from - 1)) {
				while (from > 0 && blank(from - 1)) { from--; }
			}
		}
		return { start: offsetOf(from), end: offsetOf(to) };
	}

	function findQuoteObject(text, offset, quote, isInner) {
		const from = lineStart(text, offset);
		const line = text.slice(from, lineEnd(text, offset));
		const marks = [];
		for (let i = 0; i < line.length; i++) {
			if (line[i] === quote) { marks.push(i); }
		}
		if (marks.length < 2) { return null; }
		const column = offset - from;
		for (let i = 0; i + 1 < marks.length; i += 2) {
			const open = marks[i];
			const close = marks[i + 1];
			if (column > close) { continue; }
			return isInner
				? { start: from + open + 1, end: from + close }
				: { start: from + open, end: from + close + 1 };
		}
		return null;
	}

	function findBracketObject(text, offset, open, close, isInner) {
		let openPos = -1;
		let scanFrom = offset;
		if (graphemeAt(text, offset) === open) {
			openPos = offset;
		} else if (graphemeAt(text, offset) === close) {
			scanFrom = prevOffset(text, offset);
		}
		if (openPos === -1) {
			let depth = 0;
			for (let pos = scanFrom; ; pos = prevOffset(text, pos)) {
				const ch = graphemeAt(text, pos);
				if (ch === close) {
					depth++;
				} else if (ch === open) {
					if (depth === 0) { openPos = pos; break; }
					depth--;
				}
				if (pos === 0) { break; }
			}
		}
		if (openPos === -1) { return null; }
		let depth = 0;
		for (let pos = nextOffset(text, openPos); pos < text.length; pos = nextOffset(text, pos)) {
			const ch = graphemeAt(text, pos);
			if (ch === open) {
				depth++;
			} else if (ch === close) {
				if (depth === 0) {
					return isInner
						? { start: nextOffset(text, openPos), end: pos }
						: { start: openPos, end: nextOffset(text, pos) };
				}
				depth--;
			}
		}
		return null;
	}

	function findTextObject(text, offset, scope, type) {
		const isInner = scope === 'inner';
		if (type === 'w') { return findWordObject(text, offset, isInner, isWordChar); }
		if (type === 'W') { return findWordObject(text, offset, isInner, (ch) => !!ch && !isSpace(ch)); }
		if (QUOTES.includes(type)) { return findQuoteObject(text, offset, type, isInner); }
		const pair = PAIRS[type];
		return pair ? findBracketObject(text, offset, pair[0], pair[1], isInner) : null;
	}
	// ---------- Vim motions ----------

	const MOTIONS = {
		h: (text, offset) => prevOffset(text, offset),
		l: (text, offset) => nextOffset(text, offset),
		j: downLine,
		k: upLine,
		gj: downLine,
		gk: upLine,
		w: nextVimWord,
		b: prevVimWord,
		e: endOfVimWord,
		W: nextWORD,
		B: prevWORD,
		E: endOfWORD,
		'0': (text, offset) => lineStart(text, offset),
		'^': firstNonBlank,
		'$': (text, offset) => lineEnd(text, offset),
		G: (text) => startOfLastLine(text),
	};

	/** Apply `key` `count` times, stopping early once it no longer moves. */
	function resolveMotion(key, text, offset, count) {
		const motion = MOTIONS[key];
		if (!motion) { return offset; }
		let result = offset;
		for (let i = 0; i < count; i++) {
			const moved = motion(text, result);
			if (moved === result) { break; }
			result = moved;
		}
		return result;
	}

	function isInclusiveMotion(key) { return key.length === 1 && 'eE$'.includes(key); }
	function isLinewiseMotion(key) { return (key.length === 1 && 'jkG'.includes(key)) || key === 'gg'; }

	// ---------- Operators ----------

	const OPERATORS = { d: 'delete', c: 'change', y: 'yank' };
	const SIMPLE_MOTIONS = new Set(['h', 'l', 'j', 'k', 'w', 'b', 'e', 'W', 'B', 'E', '0', '^', '$']);
	const FIND_KEYS = new Set(['f', 'F', 't', 'T']);
	const TEXT_OBJ_SCOPES = { i: 'inner', a: 'around' };
	const TEXT_OBJ_TYPES = new Set(['w', 'W', '"', '\'', '`', '(', ')', 'b', '[', ']', '{', '}', 'B', '<', '>']);
	const MAX_VIM_COUNT = 10000;

	/**
	 * The span an operator+motion covers. Vim's rules, in the CLI's order: `cw`
	 * behaves like `ce`, j/k/G are linewise, e/E/$ include the character landed on.
	 */
	function operatorRange(op, motion, count, text, offset, target) {
		let from = Math.min(offset, target);
		let to = Math.max(offset, target);
		let linewise = false;
		if (op === 'change' && (motion === 'w' || motion === 'W')) {
			let pos = offset;
			for (let i = 0; i < count - 1; i++) {
				pos = motion === 'w' ? nextVimWord(text, pos) : nextWORD(text, pos);
			}
			const wordEnd = motion === 'w' ? endOfVimWord(text, pos) : endOfWORD(text, pos);
			to = nextOffset(text, wordEnd);
		} else if (isLinewiseMotion(motion)) {
			linewise = true;
			const newline = text.indexOf('\n', to);
			if (newline === -1) {
				to = text.length;
				if (from > 0 && text[from - 1] === '\n') { from -= 1; }
			} else {
				to = newline + 1;
			}
		} else if (isInclusiveMotion(motion) && offset <= target) {
			to = nextOffset(text, to);
		}
		return { from, to, linewise };
	}

	function applyOperator(op, from, to, ctx, linewise) {
		const text = ctx.text;
		let content = text.slice(from, to);
		if (linewise && !content.endsWith('\n')) { content += '\n'; }
		ctx.setRegister(content, !!linewise);
		if (op === 'yank') {
			ctx.setOffset(from);
			return;
		}
		const updated = text.slice(0, from) + text.slice(to);
		ctx.setText(updated);
		if (op === 'delete') {
			ctx.setOffset(Math.min(from, maxNormalOffset(updated)));
		} else {
			ctx.enterInsert(from);
		}
	}

	function executeOperatorMotion(op, motion, count, ctx) {
		const text = ctx.text;
		const offset = ctx.offset;
		const target = resolveMotion(motion, text, offset, count);
		const range = operatorRange(op, motion, count, text, offset, target);
		applyOperator(op, range.from, range.to, ctx, range.linewise);
		ctx.recordChange({ type: 'operator', op, motion, count });
	}

	function executeOperatorTextObject(op, scope, type, count, ctx) {
		const found = findTextObject(ctx.text, ctx.offset, scope, type);
		if (!found) { return; }
		applyOperator(op, found.start, found.end, ctx, false);
		ctx.recordChange({ type: 'operatorTextObj', op, scope, objType: type, count });
	}

	function executeOperatorFind(op, findType, char, count, ctx) {
		const text = ctx.text;
		const offset = ctx.offset;
		const target = findCharacter(text, offset, char, findType, count);
		ctx.setLastFind(findType, char);
		if (target === null) { return; }
		// A find is always inclusive of the character it stopped on.
		const from = Math.min(offset, target);
		const to = nextOffset(text, Math.max(offset, target));
		applyOperator(op, from, to, ctx, false);
		ctx.recordChange({ type: 'operatorFind', op, findType, char, count });
	}
	/** dd / cc / yy. The register always ends in a newline so `p` knows it is linewise. */
	function executeLineOp(op, count, ctx) {
		const text = ctx.text;
		const offset = ctx.offset;
		const lines = text.split('\n');
		const current = lineIndexAt(text, offset);
		const affected = Math.max(1, Math.min(count, lines.length - current));
		const from = lineStart(text, offset);
		let to = from;
		for (let i = 0; i < affected; i++) {
			const newline = text.indexOf('\n', to);
			to = newline === -1 ? text.length : newline + 1;
		}
		let content = text.slice(from, to);
		if (!content.endsWith('\n')) { content += '\n'; }
		ctx.setRegister(content, true);
		if (op === 'yank') {
			ctx.setOffset(from);
		} else if (op === 'delete') {
			// Deleting the last line takes the newline that preceded it.
			let cut = from;
			if (to >= text.length && cut > 0 && text[cut - 1] === '\n') { cut -= 1; }
			const updated = text.slice(0, cut) + text.slice(to);
			ctx.setText(updated);
			ctx.setOffset(Math.min(cut, maxNormalOffset(updated)));
		} else if (lines.length === 1) {
			// `cc` on a one-line buffer empties it.
			ctx.setText('');
			ctx.enterInsert(0);
		} else {
			const updated = lines.slice(0, current).concat([''], lines.slice(current + affected)).join('\n');
			ctx.setText(updated);
			ctx.enterInsert(from);
		}
		ctx.recordChange({ type: 'operator', op, motion: op[0], count });
	}

	function forward(text, offset, count) {
		let to = offset;
		for (let i = 0; i < count && to < text.length; i++) { to = nextOffset(text, to); }
		return to;
	}

	function executeX(count, ctx) {
		const text = ctx.text;
		const offset = ctx.offset;
		if (offset >= text.length) { return; }
		const to = forward(text, offset, count);
		ctx.setRegister(text.slice(offset, to), false);
		const updated = text.slice(0, offset) + text.slice(to);
		ctx.setText(updated);
		ctx.setOffset(Math.min(offset, maxNormalOffset(updated)));
		ctx.recordChange({ type: 'x', count });
	}

	function executeReplace(char, count, ctx) {
		const text = ctx.text;
		const offset = ctx.offset;
		if (offset >= text.length) { return; }
		const to = forward(text, offset, count);
		const replacement = char.repeat(count);
		ctx.setText(text.slice(0, offset) + replacement + text.slice(to));
		ctx.setOffset(offset + replacement.length - char.length);
		ctx.recordChange({ type: 'replace', char, count });
	}

	function executeToggleCase(count, ctx) {
		const text = ctx.text;
		const offset = ctx.offset;
		if (offset >= text.length) { return; }
		const to = forward(text, offset, count);
		const flipped = text.slice(offset, to).replace(/\p{L}/gu, (ch) => {
			const upper = ch.toUpperCase();
			return ch === upper ? ch.toLowerCase() : upper;
		});
		const updated = text.slice(0, offset) + flipped + text.slice(to);
		ctx.setText(updated);
		ctx.setOffset(Math.min(offset + flipped.length, maxNormalOffset(updated)));
		ctx.recordChange({ type: 'toggleCase', count });
	}

	/** J: pull the next line up, glued with a single space. */
	function executeJoin(count, ctx) {
		let text = ctx.text;
		let landing = ctx.offset;
		for (let i = 0; i < Math.max(1, count - 1); i++) {
			const to = lineEnd(text, landing);
			if (to >= text.length) { break; }
			const head = text.slice(0, to);
			const tail = text.slice(to + 1).replace(/^[ \t]+/, '');
			const glue = tail && head && !/\s$/.test(head) ? ' ' : '';
			text = head + glue + tail;
			landing = to;
		}
		ctx.setText(text);
		ctx.setOffset(Math.min(landing, maxNormalOffset(text)));
		ctx.recordChange({ type: 'join', count });
	}

	function executePaste(after, count, ctx) {
		const register = ctx.getRegister();
		if (!register) { return; }
		const text = ctx.text;
		const offset = ctx.offset;
		const payload = register.repeat(count);
		if (register.endsWith('\n')) {
			if (!after) {
				const from = lineStart(text, offset);
				const updated = text.slice(0, from) + payload + text.slice(from);
				ctx.setText(updated);
				ctx.setOffset(firstNonBlank(updated, from));
			} else {
				const to = lineEnd(text, offset);
				const updated = to >= text.length
					? text + '\n' + payload.slice(0, -1)
					: text.slice(0, to + 1) + payload + text.slice(to + 1);
				ctx.setText(updated);
				ctx.setOffset(firstNonBlank(updated, Math.min(to + 1, updated.length)));
			}
		} else {
			const insertAt = after ? nextOffset(text, offset) : offset;
			const updated = text.slice(0, insertAt) + payload + text.slice(insertAt);
			ctx.setText(updated);
			ctx.setOffset(prevOffset(updated, insertAt + payload.length));
		}
		ctx.recordChange({ type: 'paste', after, count });
	}

	function executeIndent(direction, count, ctx) {
		const text = ctx.text;
		const lines = text.split('\n');
		const first = lineIndexAt(text, ctx.offset);
		const last = Math.min(first + count - 1, lines.length - 1);
		for (let i = first; i <= last; i++) {
			lines[i] = direction === '>' ? '  ' + lines[i] : lines[i].replace(/^ {1,2}/, '');
		}
		const updated = lines.join('\n');
		ctx.setText(updated);
		ctx.setOffset(firstNonBlank(updated, lineStartOffset(lines, first)));
		ctx.recordChange({ type: 'indent', direction, count });
	}

	function executeOpenLine(above, ctx) {
		const text = ctx.text;
		const offset = ctx.offset;
		if (above) {
			const from = lineStart(text, offset);
			ctx.setText(text.slice(0, from) + '\n' + text.slice(from));
			ctx.enterInsert(from);
		} else {
			const to = lineEnd(text, offset);
			ctx.setText(text.slice(0, to) + '\n' + text.slice(to));
			ctx.enterInsert(to + 1);
		}
		ctx.recordChange({ type: 'openLine', above });
	}

	function executeRepeatFind(reverse, count, ctx) {
		const last = ctx.getLastFind();
		if (!last) { return; }
		const flip = { f: 'F', F: 'f', t: 'T', T: 't' };
		const type = reverse ? flip[last.type] : last.type;
		const target = findCharacter(ctx.text, ctx.offset, last.char, type, count);
		if (target !== null) { ctx.setOffset(target); }
	}

	/** G and gg: with an explicit count, that line; without, the last or first one. */
	function executeGoToLine(count, toLast, ctx) {
		ctx.setOffset(count === 1
			? (toLast ? startOfLastLine(ctx.text) : 0)
			: goToLine(ctx.text, count));
	}
	// ---------- NORMAL-mode state machine ----------
	// One state per pending prefix: a count, an operator, an operator's own count,
	// a pending f/F/t/T, a text-object scope, `g`, `r`, and `>`/`<`.

	const IDLE = { type: 'idle' };
	const DIGIT = /^[0-9]$/;

	function handleNormalInput(input, count, ctx) {
		if (OPERATORS[input]) { return { type: 'operator', op: OPERATORS[input], count }; }
		if (SIMPLE_MOTIONS.has(input)) {
			ctx.setOffset(resolveMotion(input, ctx.text, ctx.offset, count));
			return IDLE;
		}
		if (FIND_KEYS.has(input)) { return { type: 'find', findType: input, count }; }
		switch (input) {
			case 'g': return { type: 'g', count };
			case 'r': return { type: 'replace', count };
			case '>': case '<': return { type: 'indent', direction: input, count };
			case '~': executeToggleCase(count, ctx); break;
			case 'x': executeX(count, ctx); break;
			case 'J': executeJoin(count, ctx); break;
			case 'p': executePaste(true, count, ctx); break;
			case 'P': executePaste(false, count, ctx); break;
			case 'D': executeOperatorMotion('delete', '$', count, ctx); break;
			case 'C': executeOperatorMotion('change', '$', count, ctx); break;
			case 'Y': executeLineOp('yank', count, ctx); break;
			case 'G': executeGoToLine(count, true, ctx); break;
			case '.': ctx.replayLastChange(); break;
			case ';': executeRepeatFind(false, count, ctx); break;
			case ',': executeRepeatFind(true, count, ctx); break;
			case 'u': ctx.undo(); break;
			case 'i': ctx.enterInsert(ctx.offset); break;
			case 'I': ctx.enterInsert(firstNonBlank(ctx.text, ctx.offset)); break;
			case 'a': ctx.enterInsert(nextOffset(ctx.text, ctx.offset)); break;
			case 'A': ctx.enterInsert(lineEnd(ctx.text, ctx.offset)); break;
			case 'o': executeOpenLine(false, ctx); break;
			case 'O': executeOpenLine(true, ctx); break;
			default: break;
		}
		return IDLE;
	}

	/** What an operator does with the key that follows it. */
	function handleOperatorTarget(op, count, input, ctx) {
		if (SIMPLE_MOTIONS.has(input)) { executeOperatorMotion(op, input, count, ctx); return IDLE; }
		if (FIND_KEYS.has(input)) { return { type: 'find', findType: input, count, op }; }
		if (TEXT_OBJ_SCOPES[input]) { return { type: 'textObject', op, count, scope: TEXT_OBJ_SCOPES[input] }; }
		if (input === 'g') { return { type: 'g', count, op }; }
		if (input === 'G') { executeOperatorMotion(op, 'G', count, ctx); return IDLE; }
		return IDLE;
	}

	function transition(state, input, ctx) {
		switch (state.type) {
			case 'count':
				if (DIGIT.test(input)) {
					return { type: 'count', count: Math.min(state.count * 10 + Number(input), MAX_VIM_COUNT) };
				}
				return handleNormalInput(input, state.count, ctx);

			case 'operator':
				// `dd`, `cc`, `yy` — the operator repeated is its line-wise form.
				if (input === state.op[0]) { executeLineOp(state.op, state.count, ctx); return IDLE; }
				if (/^[1-9]$/.test(input)) {
					return { type: 'operatorCount', op: state.op, count: state.count, motionCount: Number(input) };
				}
				return handleOperatorTarget(state.op, state.count, input, ctx);

			case 'operatorCount':
				if (DIGIT.test(input)) {
					return {
						type: 'operatorCount', op: state.op, count: state.count,
						motionCount: Math.min(state.motionCount * 10 + Number(input), MAX_VIM_COUNT),
					};
				}
				return handleOperatorTarget(state.op, state.count * state.motionCount, input, ctx);

			case 'find': {
				if (!input) { return IDLE; }
				if (state.op) {
					executeOperatorFind(state.op, state.findType, input, state.count, ctx);
					return IDLE;
				}
				ctx.setLastFind(state.findType, input);
				const target = findCharacter(ctx.text, ctx.offset, input, state.findType, state.count);
				if (target !== null) { ctx.setOffset(target); }
				return IDLE;
			}

			case 'textObject':
				if (TEXT_OBJ_TYPES.has(input)) {
					executeOperatorTextObject(state.op, state.scope, input, state.count, ctx);
				}
				return IDLE;

			case 'g': {
				const motion = input === 'g' ? 'gg' : (input === 'j' || input === 'k' ? 'g' + input : null);
				if (!motion) { return IDLE; }
				if (state.op) {
					executeOperatorMotion(state.op, motion, state.count, ctx);
				} else if (motion === 'gg') {
					executeGoToLine(state.count, false, ctx);
				} else {
					ctx.setOffset(resolveMotion(motion, ctx.text, ctx.offset, state.count));
				}
				return IDLE;
			}

			case 'replace':
				// Escape or Backspace cancels a pending `r`.
				if (input) { executeReplace(input, state.count, ctx); }
				return IDLE;

			case 'indent':
				if (input === state.direction) { executeIndent(state.direction, state.count, ctx); }
				return IDLE;

			default:
				if (/^[1-9]$/.test(input)) { return { type: 'count', count: Number(input) }; }
				return handleNormalInput(input, 1, ctx);
		}
	}

	/** Re-run the last change for `.`, with recording disabled so it stays the last change. */
	function replayChange(change, ctx) {
		switch (change.type) {
			case 'insert': {
				const text = ctx.text;
				const at = ctx.offset;
				ctx.setText(text.slice(0, at) + change.text + text.slice(at));
				ctx.setOffset(at + change.text.length);
				break;
			}
			case 'operator':
				// A line-wise dd/cc/yy records its own key as the motion.
				if (change.motion === change.op[0]) {
					executeLineOp(change.op, change.count, ctx);
				} else {
					executeOperatorMotion(change.op, change.motion, change.count, ctx);
				}
				break;
			case 'operatorTextObj': executeOperatorTextObject(change.op, change.scope, change.objType, change.count, ctx); break;
			case 'operatorFind': executeOperatorFind(change.op, change.findType, change.char, change.count, ctx); break;
			case 'replace': executeReplace(change.char, change.count, ctx); break;
			case 'x': executeX(change.count, ctx); break;
			case 'toggleCase': executeToggleCase(change.count, ctx); break;
			case 'indent': executeIndent(change.direction, change.count, ctx); break;
			case 'openLine': executeOpenLine(change.above, ctx); break;
			case 'join': executeJoin(change.count, ctx); break;
			case 'paste': executePaste(change.after, change.count, ctx); break;
			default: break;
		}
	}
	function updateYankLength(length) { yankAnchor.length = length; }

	/**
	 * Normalize a DOM keydown into the shape the CLI's handlers expect. `meta` is
	 * Alt, the way a terminal reports the Meta prefix; `cmd` keeps Command on macOS
	 * distinct so it can be accepted for the word-wise motions.
	 */
	function describeKey(event) {
		const raw = event.key;
		let letter = '';
		if (/^Key[A-Z]$/.test(event.code)) {
			letter = event.code.slice(3).toLowerCase();
		} else if (raw.length === 1) {
			letter = raw.toLowerCase();
		}
		return {
			raw,
			char: raw.length === 1 ? raw : '',
			letter,
			ctrl: event.ctrlKey,
			meta: event.altKey,
			cmd: event.metaKey,
			shift: event.shiftKey,
		};
	}

	const MOTION_FOR_ARROW = { ArrowLeft: 'h', ArrowRight: 'l', ArrowUp: 'k', ArrowDown: 'j' };
	const MOTION_STATES = ['idle', 'count', 'operator', 'operatorCount'];
	const DOUBLE_PRESS_MS = 1500;
	const UNDO_LIMIT = 200;
	/** Keys that only ever arrive as one half of a chord, never as a keystroke of their own. */
	const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead']);

	/**
	 * Bind the engine to one composer. `host` reads and writes the text, the caret
	 * and the mode indicator; everything else lives here.
	 *
	 * Two host callbacks are optional because they reach outside the composer:
	 * `stash()` parks the draft (it carries the attachment chips, which the panel
	 * owns) and `externalEditor()` hands the text to a real editor through the
	 * workbench. Both return true when they took the key.
	 */
	function createEditor(host) {
		let vimEnabled = false;
		let mode = 'insert';
		let vimState = IDLE;
		let visualAnchor = 0;
		let visualOffset = 0;
		let searching = false;
		let searchPattern = '';
		let insertStart = null;
		let lastChange = null;
		let lastFind = null;
		let replaying = false;
		let escapeAt = 0;
		let ctrlCAt = 0;
		// Ctrl+X arms a one-key chord prefix: `chordPending` outlives the Ctrl+X
		// keystroke, `chordActive` is true only for the key straight after it.
		let chordPending = false;
		let chordActive = false;
		const register = { content: '', linewise: false };
		const undoStack = [];
		const redoStack = [];

		function pushUndo(text, offset) {
			undoStack.push({ text, offset });
			if (undoStack.length > UNDO_LIMIT) { undoStack.shift(); }
			redoStack.length = 0;
		}

		function currentOffset() { return mode === 'visual' ? visualOffset : host.getOffset(); }

		function move(offset) {
			if (mode === 'visual') {
				visualOffset = offset;
				syncVisual();
			} else {
				host.setCaret(offset, offset);
			}
		}

		function syncVisual() {
			const text = host.getText();
			const from = Math.min(visualAnchor, visualOffset);
			const to = Math.min(nextOffset(text, Math.max(visualAnchor, visualOffset)), text.length);
			host.setCaret(from, to);
		}

		function insertText(str) {
			const text = host.getText();
			const offset = host.getOffset();
			host.apply(text.slice(0, offset) + str + text.slice(offset), offset + str.length);
		}
		// ---------- Readline layer ----------

		function kill(deleteFn, direction) {
			const text = host.getText();
			const result = deleteFn(text, host.getOffset());
			if (result.killed) { pushToKillRing(result.killed, direction); }
			if (result.text !== text) {
				pushUndo(text, host.getOffset());
				host.apply(result.text, result.offset);
			}
		}

		function edit(deleteFn) {
			const text = host.getText();
			const result = deleteFn(text, host.getOffset());
			if (result.text !== text) {
				pushUndo(text, host.getOffset());
				host.apply(result.text, result.offset);
			}
		}

		function yank() {
			const content = getLastKill();
			if (!content) { return; }
			const text = host.getText();
			const offset = host.getOffset();
			pushUndo(text, offset);
			host.apply(text.slice(0, offset) + content + text.slice(offset), offset + content.length);
			recordYank(offset, content.length);
		}

		/** Alt+Y cycles the yank back through older kill-ring entries. */
		function handleYankPop() {
			const popped = yankPop();
			if (!popped) { return; }
			const text = host.getText();
			const updated = text.slice(0, popped.start) + popped.text + text.slice(popped.start + popped.length);
			host.apply(updated, popped.start + popped.text.length);
			updateYankLength(popped.text.length);
		}

		function upOrHistory() {
			const text = host.getText();
			const offset = host.getOffset();
			const moved = upLine(text, offset);
			if (moved !== offset) { host.setCaret(moved, moved); return true; }
			return host.historyUp();
		}

		function downOrHistory() {
			const text = host.getText();
			const offset = host.getOffset();
			const moved = downLine(text, offset);
			if (moved !== offset) { host.setCaret(moved, moved); return true; }
			return host.historyDown();
		}

		function handleEnter(k) {
			const text = host.getText();
			const offset = host.getOffset();
			// A trailing backslash continues the line instead of sending.
			if (offset > 0 && text[offset - 1] === '\\') {
				host.apply(text.slice(0, offset - 1) + '\n' + text.slice(offset), offset);
				return true;
			}
			if (k.meta || k.shift) { insertText('\n'); return true; }
			host.submit();
			return true;
		}
		function deleteGrapheme(backwards) {
			const text = host.getText();
			const offset = host.getOffset();
			const from = backwards ? prevOffset(text, offset) : offset;
			const to = backwards ? offset : nextOffset(text, offset);
			if (from === to) { return; }
			pushUndo(text, offset);
			host.apply(text.slice(0, from) + text.slice(to), from);
		}

		function handleCtrl(k) {
			const text = host.getText();
			const offset = host.getOffset();
			switch (k.letter) {
				case 'b': move(prevOffset(text, offset)); return true;
				case 'f': move(nextOffset(text, offset)); return true;
				case 'e':
					// Ctrl+X Ctrl+E is readline's edit-and-execute-command; on its own
					// Ctrl+E is end of line.
					if (chordActive) { return openExternalEditor(); }
					move(lineEnd(text, offset));
					return true;
				case 'g': return openExternalEditor();
				case 's': return toggleStash();
				case 'x':
					// Ctrl+X cuts the selection, exactly as it does in any text box. With
					// nothing selected there is nothing to cut, so it arms the CLI's chord
					// prefix instead of being swallowed.
					if (host.hasSelection()) { return false; }
					chordPending = true;
					host.notify('Ctrl+X …  Ctrl+E edits the prompt in an editor');
					return true;
				case 'h': deleteGrapheme(true); return true;
				case 'd':
					// Ctrl+D on an empty composer would exit the CLI; here it does nothing.
					if (text) { deleteGrapheme(false); }
					return true;
				case 'k':
					// Empty composer: leave Ctrl+K to the panel's focus-and-prefill shortcut.
					if (!text) { return false; }
					kill(deleteToLineEnd, 'append');
					return true;
				case 'u':
					// Ctrl+X Ctrl+U is readline's other undo; on its own Ctrl+U kills to
					// the start of the line.
					if (chordActive) { return undoEdit(); }
					kill(deleteToLineStart, 'prepend');
					return true;
				case 'w': kill(deleteWordBefore, 'prepend'); return true;
				case 'y': yank(); return true;
				case 'n': return downOrHistory();
				case 'p': return upOrHistory();
				case 'c': {
					// While a turn runs, or with a selection, Ctrl+C keeps its other jobs.
					if (host.isBusy() || host.hasSelection()) { return false; }
					if (!text) { return false; }
					const now = Date.now();
					if (now - ctrlCAt < DOUBLE_PRESS_MS) {
						ctrlCAt = 0;
						host.clearInput();
					} else {
						ctrlCAt = now;
						host.notify('Press Ctrl+C again to clear');
					}
					return true;
				}
				default: return false;
			}
		}

		function handleMeta(k) {
			const text = host.getText();
			const offset = host.getOffset();
			switch (k.letter) {
				case 'b': move(prevWord(text, offset)); return true;
				case 'f': move(nextWord(text, offset)); return true;
				case 'd': edit(deleteWordAfter); return true;
				case 'y': handleYankPop(); return true;
				default: return false;
			}
		}

		/**
		 * Readline-level undo — the CLI's `chat:undo` (Ctrl+_ / Ctrl+Shift+-). Vim's
		 * `u` walks the same two stacks, so the two undo paths interleave cleanly.
		 */
		function undoEdit() {
			const previous = undoStack.pop();
			if (!previous) { return false; }
			redoStack.push({ text: host.getText(), offset: host.getOffset() });
			host.apply(previous.text, previous.offset);
			return true;
		}

		/** Park or bring back the draft (Ctrl+S). The host owns the stash. */
		function toggleStash() {
			return host.stash ? host.stash() : false;
		}

		/** Hand the prompt to a real editor (Ctrl+G, Ctrl+X Ctrl+E). */
		function openExternalEditor() {
			return host.externalEditor ? host.externalEditor() : false;
		}

		function handleEscape() {
			// With vim on, Escape leaves insert mode — clearing the composer is what a
			// second Escape does from NORMAL, which handleVim owns.
			if (vimEnabled && mode === 'insert') { setMode('normal'); return true; }
			const text = host.getText();
			if (!text) { return false; }
			const now = Date.now();
			if (now - escapeAt < DOUBLE_PRESS_MS) {
				escapeAt = 0;
				host.clearInput();
			} else {
				escapeAt = now;
				host.notify('Press Escape again to clear');
			}
			return true;
		}
		/** The CLI's mapKey order: escape, word-wise arrows, backspace/delete, ctrl, return, meta. */
		function handleReadline(k) {
			const text = host.getText();
			const offset = host.getOffset();
			if (k.raw === 'Escape') { return handleEscape(); }
			if ((k.ctrl || k.meta || k.cmd) && k.raw === 'ArrowLeft') { move(prevWord(text, offset)); return true; }
			if ((k.ctrl || k.meta || k.cmd) && k.raw === 'ArrowRight') { move(nextWord(text, offset)); return true; }
			if (k.raw === 'Backspace') {
				if (k.ctrl || k.meta || k.cmd) { kill(deleteWordBefore, 'prepend'); return true; }
				return false;
			}
			if (k.raw === 'Delete') {
				if (k.meta || k.cmd) { kill(deleteToLineEnd, 'append'); return true; }
				return false;
			}
			// The CLI's chat:undo. A terminal sends Ctrl+_ for it, which a keyboard
			// reports as Ctrl+Shift+Minus. Plain Ctrl+Minus is deliberately not taken:
			// it is the window's zoom-out, and readline's other undo — Ctrl+X Ctrl+U —
			// is there for layouts where `_` is awkward to reach.
			if (k.ctrl && k.raw === '_') { return undoEdit(); }
			if (k.ctrl && !k.meta && k.letter) { return handleCtrl(k); }
			if (k.raw === 'Enter') { return handleEnter(k); }
			if (k.meta && !k.ctrl && k.letter) { return handleMeta(k); }
			return false;
		}

		// ---------- Mode ----------

		function setMode(next, options) {
			const silent = options && options.silent;
			if (next === 'insert' && mode !== 'insert') {
				insertStart = { text: host.getText(), offset: host.getOffset() };
			} else if (mode === 'insert' && next !== 'insert' && !silent) {
				finishInsert();
			}
			if (next !== 'insert') { insertStart = null; }
			mode = next;
			if (next === 'visual') {
				visualAnchor = host.getOffset();
				visualOffset = visualAnchor;
				syncVisual();
			}
			vimState = IDLE;
			searching = false;
			host.onVimMode(mode);
			host.onVimStatus(null);
		}

		/**
		 * Leaving insert mode records what was typed, so `.` can repeat it, and steps
		 * the cursor left one character the way vim does.
		 */
		function finishInsert() {
			const text = host.getText();
			const offset = host.getOffset();
			if (insertStart && offset > insertStart.offset
				&& text.slice(0, insertStart.offset) === insertStart.text.slice(0, insertStart.offset)) {
				const typed = text.slice(insertStart.offset, offset);
				if (typed) { lastChange = { type: 'insert', text: typed }; }
			}
			if (offset > 0 && text[offset - 1] !== '\n') {
				const back = prevOffset(text, offset);
				host.setCaret(back, back);
			}
		}
		// ---------- Vim layer ----------

		/** The mutable view of the buffer the ported operators write through. */
		function makeCtx(state) {
			return {
				get text() { return state.text; },
				get offset() { return state.offset; },
				setText(value) { state.text = value; },
				setOffset(value) { state.offset = clamp(value, state.text.length); },
				enterInsert(value) { state.offset = clamp(value, state.text.length); state.insert = true; },
				getRegister() { return register.content; },
				setRegister(content, linewise) { register.content = content; register.linewise = linewise; },
				getLastFind() { return lastFind; },
				setLastFind(type, char) { lastFind = { type, char }; },
				recordChange(change) { if (!replaying) { lastChange = change; } },
				replayLastChange() {
					if (!lastChange || replaying) { return; }
					replaying = true;
					try { replayChange(lastChange, this); } finally { replaying = false; }
				},
				undo() {
					const previous = undoStack.pop();
					if (!previous) { return; }
					redoStack.push({ text: state.text, offset: state.offset });
					state.text = previous.text;
					state.offset = clamp(previous.offset, previous.text.length);
					state.skipUndo = true;
				},
			};
		}

		/** Feed one key into the NORMAL-mode state machine and write back the result. */
		function runVim(input) {
			const before = host.getText();
			const anchor = currentOffset();
			const state = { text: before, offset: anchor, insert: false, skipUndo: false };
			vimState = transition(vimState, input, makeCtx(state)) || IDLE;
			if (state.text !== before) {
				if (!state.skipUndo) {
					undoStack.push({ text: before, offset: anchor });
					if (undoStack.length > UNDO_LIMIT) { undoStack.shift(); }
					redoStack.length = 0;
				}
				host.apply(state.text, state.offset);
				if (mode === 'visual') { mode = 'normal'; host.onVimMode(mode); }
			} else if (mode === 'visual') {
				visualOffset = state.offset;
				syncVisual();
			} else {
				host.setCaret(state.offset, state.offset);
			}
			if (state.insert) { setMode('insert'); }
			host.onVimStatus(pendingLabel());
		}

		/** What the indicator shows while a command is half-typed. */
		function pendingLabel() {
			const count = (value) => (value > 1 ? String(value) : '');
			switch (vimState.type) {
				case 'count': return String(vimState.count);
				case 'operator': return count(vimState.count) + vimState.op[0];
				case 'operatorCount': return count(vimState.count) + vimState.op[0] + vimState.motionCount;
				case 'find': return (vimState.op ? vimState.op[0] : '') + vimState.findType;
				case 'textObject': return vimState.op[0] + (vimState.scope === 'inner' ? 'i' : 'a');
				case 'g': return (vimState.op ? vimState.op[0] : '') + 'g';
				case 'replace': return 'r';
				case 'indent': return vimState.direction;
				default: return null;
			}
		}

		function redo() {
			const next = redoStack.pop();
			if (!next) { return; }
			undoStack.push({ text: host.getText(), offset: host.getOffset() });
			host.apply(next.text, next.offset);
		}
		// `/pattern` with n/N is a GUI addition on top of the CLI's command set.
		function findNext(direction) {
			if (!searchPattern) { return; }
			const text = host.getText();
			const from = currentOffset();
			let index;
			if (direction > 0) {
				index = text.indexOf(searchPattern, from + 1);
				if (index < 0) { index = text.indexOf(searchPattern); }
			} else {
				index = text.lastIndexOf(searchPattern, Math.max(0, from - 1));
				if (index < 0) { index = text.lastIndexOf(searchPattern); }
			}
			if (index >= 0) { move(index); }
		}

		function handleSearchKey(k) {
			if (k.raw === 'Enter') {
				searching = false;
				host.onVimStatus(null);
				findNext(1);
				return true;
			}
			if (k.raw === 'Escape') {
				searching = false;
				searchPattern = '';
				host.onVimStatus(null);
				return true;
			}
			if (k.raw === 'Backspace') {
				searchPattern = searchPattern.slice(0, -1);
				host.onVimStatus('/' + searchPattern);
				return true;
			}
			if (k.char) {
				searchPattern += k.char;
				host.onVimStatus('/' + searchPattern);
			}
			return true;
		}

		/** Visual mode is a GUI addition too; the CLI has only INSERT and NORMAL. */
		function leaveVisual() {
			const caret = visualOffset;
			setMode('normal');
			host.setCaret(caret, caret);
		}

		function handleVisual(k) {
			const ch = k.char;
			if (!ch) { return false; }
			if (ch === 'v') { leaveVisual(); return true; }
			if (ch === 'o') {
				const swap = visualAnchor;
				visualAnchor = visualOffset;
				visualOffset = swap;
				syncVisual();
				return true;
			}
			if ('dxycp~><J'.includes(ch)) { runVisualOp(ch); return true; }
			return false;
		}
		function runVisualOp(ch) {
			const text = host.getText();
			const from = Math.min(visualAnchor, visualOffset);
			const to = Math.min(nextOffset(text, Math.max(visualAnchor, visualOffset)), text.length);
			if (ch === 'y') {
				register.content = text.slice(from, to);
				register.linewise = false;
				setMode('normal');
				host.setCaret(from, from);
				return;
			}
			pushUndo(text, from);
			if (ch === '>' || ch === '<' || ch === 'J' || ch === '~') {
				const state = { text, offset: from, insert: false, skipUndo: false };
				const ctx = makeCtx(state);
				if (ch === 'J') {
					executeJoin(lineIndexAt(text, to) - lineIndexAt(text, from) + 1, ctx);
				} else if (ch === '~') {
					let units = 0;
					for (let pos = from; pos < to; pos = nextOffset(text, pos)) { units++; }
					executeToggleCase(units, ctx);
				} else {
					executeIndent(ch, lineIndexAt(text, to) - lineIndexAt(text, from) + 1, ctx);
				}
				host.apply(state.text, state.offset);
				setMode('normal');
				return;
			}
			if (ch === 'p') {
				const updated = text.slice(0, from) + register.content + text.slice(to);
				host.apply(updated, Math.min(from + register.content.length, maxNormalOffset(updated)));
				setMode('normal');
				return;
			}
			register.content = text.slice(from, to);
			register.linewise = false;
			const updated = text.slice(0, from) + text.slice(to);
			if (ch === 'c') {
				host.apply(updated, from);
				setMode('insert');
			} else {
				host.apply(updated, Math.min(from, maxNormalOffset(updated)));
				setMode('normal');
			}
		}

		function handleVim(k) {
			if (searching) { return handleSearchKey(k); }
			if (k.raw === 'Escape') {
				if (mode === 'visual') { leaveVisual(); } else { vimState = IDLE; host.onVimStatus(null); }
				return true;
			}
			// Ctrl+R redoes; every other ctrl key falls through to readline, as in the CLI.
			if (k.ctrl && !k.meta && k.letter === 'r') { redo(); return true; }
			if (k.ctrl || k.cmd) { return false; }
			if (k.raw === 'Enter') { return false; }

			const expectsMotion = MOTION_STATES.includes(vimState.type);
			const arrow = MOTION_FOR_ARROW[k.raw];
			if (arrow) {
				// Idle arrows keep their normal job — caret movement and input history.
				if (vimState.type === 'idle' && mode !== 'visual') { return false; }
				runVim(arrow);
				return true;
			}
			if (k.raw === 'Backspace') {
				runVim(expectsMotion ? 'h' : '');
				return true;
			}
			if (expectsMotion && vimState.type !== 'count' && k.raw === 'Delete') { runVim('x'); return true; }
			if (!k.char) { return false; }
			if (vimState.type === 'idle') {
				if (mode === 'visual' && handleVisual(k)) { return true; }
				if (k.char === 'v') { setMode('visual'); return true; }
				if (k.char === '/') { searching = true; searchPattern = ''; host.onVimStatus('/'); return true; }
				if (k.char === 'n') { findNext(1); return true; }
				if (k.char === 'N') { findNext(-1); return true; }
			}
			runVim(k.char);
			return true;
		}
		/**
		 * Entry point. Returns true when the key was consumed, in which case the
		 * default action has already been prevented.
		 */
		function handleKey(event) {
			if (event.isComposing) { return false; }
			const k = describeKey(event);
			// A modifier arriving on its own is not a keystroke: it must not break a run
			// of kills, end a yank, or spend the Ctrl+X chord that is waiting for the
			// key after it.
			if (MODIFIER_KEYS.has(k.raw)) { return false; }
			// A chord prefix reaches exactly one key. Reading it here — before anything
			// dispatches — is what stops a stale Ctrl+X from arming a later Ctrl+E.
			chordActive = chordPending;
			chordPending = false;
			// Consecutive kills accumulate; anything else breaks the run.
			const killKey = (k.ctrl && !k.meta && !!k.letter && 'kuw'.includes(k.letter))
				|| ((k.ctrl || k.meta || k.cmd) && (k.raw === 'Backspace' || k.raw === 'Delete'));
			const yankKey = (k.ctrl || k.meta) && k.letter === 'y';
			if (!killKey) { resetKillAccumulation(); }
			if (!yankKey) { resetYankState(); }
			// While a turn is running, Escape belongs to the interrupt shortcut.
			if (k.raw === 'Escape' && host.isBusy()) { return false; }
			if (vimEnabled && mode !== 'insert' && handleVim(k)) {
				event.preventDefault();
				return true;
			}
			if (handleReadline(k)) {
				event.preventDefault();
				return true;
			}
			return false;
		}

		return {
			handleKey,
			setVimEnabled(enabled) {
				vimEnabled = !!enabled;
				setMode(vimEnabled ? 'normal' : 'insert', { silent: true });
			},
			setVimMode(next) { setMode(next, { silent: true }); },
			getVimMode() { return mode; },
			isVimEnabled() { return vimEnabled; },
		};
	}

	window.CodeMindInput = { createEditor };
})();
