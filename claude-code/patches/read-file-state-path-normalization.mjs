// Fix the engine bundle's read-state path keys.
//
// Four of the file tools compute a key for `readFileState` — the map that records what
// the agent has read — and they did not agree with each other on Windows:
//
//   Read.call            Yo(file_path)                     absolute path as the model wrote it
//   Write.validateInput  H4(file_path)                     normalized native path
//   Edit.validateInput   isAbsolute(p) ? p : resolve(p)    absolute path as the model wrote it
//   Edit.call            H4(file_path)                     normalized native path
//
// On POSIX all four agree, because a path the model writes is already separator-normalized.
// On Windows `D:/tmp/note.txt` and `D:\tmp\note.txt` are two different keys, so:
//
//   * Read then Write is refused with "File has not been read yet" — Read stored the raw
//     spelling and Write looked up the normalized one; and
//   * Read then Edit gets past validateInput on the raw key and then throws "File has been
//     unexpectedly modified" from Edit.call on the normalized one.
//
// Reading again cannot help: it stores the same mismatched key, so the model has no way out
// from its side. `H4` is the normalizer — it resolves against the cwd, expands `~`, and also
// understands the MSYS `/d/...` spelling — and Write and Edit.call already use it, so the fix
// is to route the two outliers through it as well. All four keys then agree, whichever way
// the model spelled the path.
//
// The bundle lives in `claude-code/node_modules`, which is not tracked, so this script is
// the record of the change and has to be re-run after `bun install`:
//
//   node claude-code/patches/read-file-state-path-normalization.mjs
//
// It is idempotent, and it refuses to guess: if an edit finds neither its original nor its
// patched form, the bundle has moved on and the patch has to be re-derived against it.
// Derived from @anthropic-ai/claude-agent-sdk 0.1.77 (cli.js reports "Version: 2.0.77").
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');

const EDITS = [
	{
		what: 'Read.call records under a normalized key',
		// `Gz1` is isAbsolute and `eD9` is resolve: the original hands back an absolute
		// path as-is. `Yo` goes on to fix up AM/PM screenshot names, which is untouched —
		// it just operates on the normalized path now.
		from: 'function Yo(A){let Q=Gz1(A)?A:eD9(l1(),A),',
		to: 'function Yo(A){let Q=H4(A),',
	},
	{
		what: 'Edit.validateInput looks up under a normalized key',
		// `PW1` is isAbsolute and `Lc5` is resolve, both imported by the Edit tool's own
		// module. Edit.call already normalizes with H4, so this also settles the
		// disagreement between the two halves of the same tool.
		from: 'let Y=PW1(A)?A:Lc5(l1(),A),J=await Z.getAppState();',
		to: 'let Y=H4(A),J=await Z.getAppState();',
	},
];

let src = readFileSync(CLI, 'utf8');

if (!src.includes('function H4(A,Q){')) {
	console.error(`H4, the normalizer the other tools use, is not in ${CLI} — re-derive the patch.`);
	process.exit(1);
}

let applied = 0;
let already = 0;
for (const edit of EDITS) {
	if (src.includes(edit.to)) { already++; continue; }
	const count = src.split(edit.from).length - 1;
	if (count !== 1) {
		// Not one unambiguous site: either the bundle changed or the pattern is no longer
		// specific enough to be safe to rewrite. Either way, stop rather than guess.
		console.error(`Expected exactly one match for "${edit.what}", found ${count} — re-derive the patch.`);
		process.exit(1);
	}
	src = src.replace(edit.from, edit.to);
	applied++;
	console.log(`patched: ${edit.what}`);
}

if (applied) {
	writeFileSync(CLI, src);
	console.log(`wrote ${CLI} (${applied} applied, ${already} already in place)`);
} else {
	console.log('already applied');
}
