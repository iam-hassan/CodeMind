#!/usr/bin/env bash
#
# Launch the CodeMind development build, on Linux and macOS. On Windows run
# scripts\run.bat.
#
#   scripts/run.sh              open the folder you are standing in
#   scripts/run.sh <folder>     open <folder>
#   scripts/run.sh --help       this text
#
# This runs the compiled workbench out of vscodium/vscode/out through the
# Electron runtime in vscodium/vscode/.build — it is not a packaged
# application. Run scripts/setup.sh first; scripts/setup.sh --compile picks up
# later edits to the panel sources.

set -u -o pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" && pwd )
ROOT=$( cd -- "${SCRIPT_DIR}/.." && pwd )
VSCODE="${ROOT}/vscodium/vscode"

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
	sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'
	exit 0
fi

FOLDER=${1:-$PWD}
[ -d "${FOLDER}" ] || { printf 'run.sh: no such folder: %s\n' "${FOLDER}" >&2; exit 2; }
FOLDER=$( cd -- "${FOLDER}" && pwd )

[ -d "${VSCODE}/out" ] || {
	printf 'run.sh: vscodium/vscode/out is missing — run scripts/setup.sh first.\n' >&2
	exit 1
}

# build/lib/electron.ts renames the runtime after the product, so the name
# differs per platform; take the first one that exists.
BIN=
for candidate in \
	"${VSCODE}/.build/electron/CodeMind.exe" \
	"${VSCODE}/.build/electron/CodeMind.app/Contents/MacOS/Electron" \
	"${VSCODE}/.build/electron/codemind" \
	"${VSCODE}/.build/electron/electron" \
	"${VSCODE}/.build/electron/electron.exe"
do
	[ -f "${candidate}" ] && [ -x "${candidate}" ] && { BIN="${candidate}"; break; }
done

[ -n "${BIN}" ] || {
	printf 'run.sh: no Electron runtime in vscodium/vscode/.build/electron —\n' >&2
	printf '        run scripts/setup.sh (it downloads it).\n' >&2
	exit 1
}

printf 'CodeMind: %s\n' "${BIN#"${ROOT}/"}"
printf 'folder:   %s\n\n' "${FOLDER}"

# cwd has to be the checkout: the workbench loads out/ relative to it, and the
# leading "." tells Electron which app to run — the folder follows it.
cd "${VSCODE}" || exit 1
exec "${BIN}" . "${FOLDER}" "${@:2}"
