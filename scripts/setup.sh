#!/usr/bin/env bash
#
# First-time setup for a CodeMind development build, on Linux and macOS.
# On Windows run scripts\setup.bat, which checks the same things and then hands
# over to this script through Git Bash.
#
#   scripts/setup.sh             full setup
#   scripts/setup.sh --check     check the prerequisites and stop
#   scripts/setup.sh --compile   re-overlay the CodeMind sources and recompile
#   scripts/setup.sh --help      this text
#
# A clone carries the CodeMind sources and the VSCodium base, but not the VS Code
# checkout they are built against, nor anything installed or compiled. This
# script produces the four things that are missing:
#
#   vscodium/vscode/            the Microsoft VS Code checkout, at the commit
#                               pinned in vscodium/upstream/stable.json, with
#                               VSCodium's patches applied and vscodium/src/stable
#                               (which carries the agent panel) overlaid on top
#   vscodium/vscode/out/        the compiled workbench
#   vscodium/vscode/.build/     the Electron runtime the dev build runs in
#   claude-code/node_modules/   the Claude Agent SDK the agent engine imports
#
# The first run downloads a VS Code checkout and its dependencies and then
# compiles the workbench. Budget an hour and several GB of disk.

set -u -o pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" && pwd )
ROOT=$( cd -- "${SCRIPT_DIR}/.." && pwd )
CODIUM="${ROOT}/vscodium"
ENGINE="${ROOT}/claude-code"

MODE=full
for arg in "$@"; do
	case "${arg}" in
		--check) MODE=check ;;
		--compile) MODE=compile ;;
		-h|--help) sed -n '3,26p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
		*) printf 'setup.sh: unknown argument %s (try --help)\n' "${arg}" >&2; exit 2 ;;
	esac
done

step() { printf '\n== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }
die()  { printf '\nsetup.sh: %s\n' "$1" >&2; exit 1; }

# --------------------------------------------------------------------------
# Prerequisites
# --------------------------------------------------------------------------
# Everything here is a tool the build itself shells out to, so a missing one
# fails somewhere deep inside npm or gulp; check up front instead and say what
# each one is for.

MISSING=0
FIRST_VERSION=

have() { command -v "$1" >/dev/null 2>&1; }

version_of() {
	FIRST_VERSION=$("$1" --version 2>&1 | head -1 | tr -d '\r' | cut -c1-58)
}

need() { # need <command> <what the build uses it for> <how to install it>
	if have "$1"; then
		version_of "$1"
		printf '   ok       %-7s %s\n' "$1" "${FIRST_VERSION}"
	else
		printf '   MISSING  %-7s %s\n' "$1" "$2"
		note "         install: $3"
		MISSING=$(( MISSING + 1 ))
	fi
}

# The workbench's own floor, from vscodium/vscode's .nvmrc once it exists and
# from VSCodium's otherwise. Node below this fails in the middle of npm ci.
NODE_FLOOR=$(tr -d ' \t\r\n' < "${CODIUM}/.nvmrc" 2>/dev/null || true)
NODE_FLOOR=${NODE_FLOOR:-24.15.0}

check_node() {
	local have_v lowest
	if ! have node; then
		printf '   MISSING  %-7s runs the build and the editor\n' "node"
		note "         install: https://nodejs.org — ${NODE_FLOOR} or newer"
		MISSING=$(( MISSING + 1 ))
		return
	fi
	have_v=$(node --version 2>/dev/null | tr -d 'v \t\r\n')
	lowest=$(printf '%s\n%s\n' "${have_v}" "${NODE_FLOOR}" | sort -V | head -1)
	if [ "${lowest}" = "${NODE_FLOOR}" ]; then
		printf '   ok       %-7s v%s\n' "node" "${have_v}"
	else
		printf '   TOO OLD  %-7s v%s — the workbench needs %s or newer\n' "node" "${have_v}" "${NODE_FLOOR}"
		MISSING=$(( MISSING + 1 ))
	fi
}

check_python() {
	# node-gyp builds VS Code's native modules (keytar, spdlog, watcher) and
	# calls whichever of these it finds first. On Windows both names can resolve
	# to the Microsoft Store's stub, which prints an advert instead of a version,
	# so test the output rather than trusting the name.
	local candidate out
	for candidate in python3 python; do
		have "${candidate}" || continue
		out=$("${candidate}" --version 2>&1 | head -1 | tr -d '\r')
		case "${out}" in
			Python\ 3*)
				printf '   ok       %-7s %s (as %s)\n' "python3" "${out}" "${candidate}"
				return 0
				;;
		esac
	done
	printf '   MISSING  %-7s node-gyp builds the native modules with it\n' "python3"
	note "         install: https://www.python.org/downloads/ — 3.8 or newer,"
	note "         on PATH as python3 or python"
	MISSING=$(( MISSING + 1 ))
}

platform_notes() {
	case "$(uname -s)" in
		Linux)
			note "Linux also needs the headers the native modules link against:"
			note "  apt: build-essential libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev"
			note "  dnf: @development-tools libX11-devel libxkbfile-devel libsecret-devel krb5-devel"
			;;
		Darwin)
			note "macOS also needs the Xcode command line tools: xcode-select --install"
			;;
		MINGW*|MSYS*|CYGWIN*)
			note "Windows also needs the Visual Studio Build Tools with the"
			note "\"Desktop development with C++\" workload, for the native modules."
			;;
	esac
}

step "Prerequisites"
need git    "clones the pinned VS Code source"                      "https://git-scm.com/downloads"
check_node
need npm    "installs the workbench dependencies"                   "ships with node"
need jq     "the prepare step rewrites product.json with it"        "https://jqlang.github.io/jq/download/"
need curl   "downloads the Electron runtime"                        "https://curl.se/download.html"
check_python
need bun    "installs the Claude Agent SDK from claude-code/bun.lock" "https://bun.sh"
platform_notes

if [ "${MISSING}" -gt 0 ]; then
	die "${MISSING} prerequisite(s) missing or too old — install them and run this again."
fi
note "all prerequisites present"

step "Repository layout"
for required in \
	"${CODIUM}/get_repo.sh" \
	"${CODIUM}/prepare_vscode.sh" \
	"${CODIUM}/upstream/stable.json" \
	"${ENGINE}/package.json"
do
	[ -f "${required}" ] || die "${required#"${ROOT}/"} is missing — is this a complete clone?"
done
PANEL="${CODIUM}/src/stable/src/vs/workbench/contrib/codemindAgent"
[ -d "${PANEL}" ] || die "${PANEL#"${ROOT}/"} is missing — the agent panel sources are not in this clone."
note "CodeMind sources, VSCodium base and engine all present"
note "will build VS Code $(jq -r '.tag' "${CODIUM}/upstream/stable.json") ($(jq -r '.commit' "${CODIUM}/upstream/stable.json" | cut -c1-10))"

if [ "${MODE}" = check ]; then
	printf '\nPrerequisite check only (--check) — nothing was built.\n'
	exit 0
fi

# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------
# The variables below are the ones VSCodium's own scripts read; they are the
# same set dev/build.sh exports, so this produces the same tree that script
# would. DISABLE_UPDATE stays "no" because turning it on makes
# prepare_vscode.sh rename a tracked patch file (00-update-disable.patch.yet),
# which would leave every clone with a dirty working tree.

codium_env() {
	export APP_NAME="CodeMind"
	export APP_NAME_LC="codemind"
	export ASSETS_REPOSITORY="VSCodium/vscodium"
	export BINARY_NAME="codemind"
	export ORG_NAME="CodeMind"
	export GH_REPO_PATH="VSCodium/vscodium"
	export CI_BUILD="no"
	export DISABLE_UPDATE="no"
	export SHOULD_BUILD="yes"
	export SKIP_ASSETS="yes"
	export VSCODE_LATEST="no"
	export VSCODE_QUALITY="stable"
	export VSCODE_SKIP_NODE_VERSION_CHECK="yes"
	export NODE_OPTIONS="--max-old-space-size=8192"

	# get_repo.sh and version.sh test these before setting them.
	export RELEASE_VERSION="${RELEASE_VERSION:-}"
	export MS_TAG="${MS_TAG:-}"
	export MS_COMMIT="${MS_COMMIT:-}"
	export GITHUB_ENV="${GITHUB_ENV:-}"
	export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}"

	case "${OSTYPE:-}" in
		darwin*)         export OS_NAME="osx" ;;
		msys*|cygwin*)   export OS_NAME="windows" ;;
		*)               export OS_NAME="linux" ;;
	esac

	case "$( uname -m )" in
		aarch64|arm64)  export VSCODE_ARCH="arm64" ;;
		ppc64le)        export VSCODE_ARCH="ppc64le" ;;
		riscv64)        export VSCODE_ARCH="riscv64" ;;
		loongarch64)    export VSCODE_ARCH="loong64" ;;
		s390x)          export VSCODE_ARCH="s390x" ;;
		*)              export VSCODE_ARCH="x64" ;;
	esac
}

codium_env

step "VS Code source (vscodium/vscode)"
if [ ! -d "${CODIUM}/vscode/.git" ]; then
	if [ "${MODE}" = compile ]; then
		die "--compile needs an existing vscodium/vscode; run setup.sh with no arguments first."
	fi
	note "fetching the pinned commit, applying VSCodium's patches, overlaying"
	note "vscodium/src/stable, and installing the workbench dependencies —"
	note "this is the slow part, and it prints VSCodium's own build output."
	(
		set +u   # VSCodium's scripts read several variables they never set
		cd "${CODIUM}" || exit 1
		. get_repo.sh
		. version.sh
		# Same cache dev/build.sh keeps, so its -s (skip source) mode works later.
		{
			echo "MS_TAG=\"${MS_TAG}\""
			echo "MS_COMMIT=\"${MS_COMMIT}\""
			echo "RELEASE_VERSION=\"${RELEASE_VERSION}\""
			echo "BUILD_SOURCEVERSION=\"${BUILD_SOURCEVERSION}\""
		} > dev/build.env
		. prepare_vscode.sh
	) || die "fetching or preparing vscodium/vscode failed (output above). Delete
   vscodium/vscode and run this again to start that step over."
	note "checkout prepared"
else
	note "already present — re-overlaying vscodium/src/stable onto it"
	# gulp does not sync the overlay, so every build has to copy it again.
	( cd "${CODIUM}" && cp -rp src/stable/* vscode/ ) \
		|| die "could not copy vscodium/src/stable over vscodium/vscode."
fi

step "Workbench dependencies (vscodium/vscode/node_modules)"
if [ -d "${CODIUM}/vscode/node_modules" ]; then
	note "already installed"
else
	# Only reached when a prepared checkout lost its node_modules; the first-run
	# path above installs them inside prepare_vscode.sh.
	(
		set +u
		cd "${CODIUM}/vscode" || exit 1
		export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
		npm ci
	) || die "npm ci failed in vscodium/vscode (output above)."
fi

step "Electron runtime (vscodium/vscode/.build/electron)"
if [ -d "${CODIUM}/vscode/.build/electron" ]; then
	note "already downloaded"
else
	( set +u; cd "${CODIUM}/vscode" && npm run electron ) \
		|| die "downloading Electron failed (output above)."
fi

step "Compile the workbench (vscodium/vscode/out)"
note "a few minutes on a warm machine, longer on the first run"
( set +u; cd "${CODIUM}/vscode" && npm run compile-client ) \
	|| die "the workbench did not compile (output above)."

if [ "${MODE}" != compile ]; then
	step "Claude Agent SDK (claude-code/node_modules)"
	( cd "${ENGINE}" && bun install ) || die "bun install failed in claude-code (output above)."
	# The SDK resolves read-state paths against the process working directory,
	# which breaks the panel's read-before-edit bookkeeping. This re-applies the
	# local fix; it is idempotent, and it has to run after every bun install.
	( cd "${ENGINE}" && node patches/read-file-state-path-normalization.mjs ) \
		|| die "could not apply claude-code/patches/read-file-state-path-normalization.mjs."
fi

# --------------------------------------------------------------------------

case "$( uname -s )" in
	MINGW*|MSYS*|CYGWIN*) BIN="vscodium/vscode/.build/electron/CodeMind.exe" ;;
	Darwin)               BIN="vscodium/vscode/.build/electron/CodeMind.app/Contents/MacOS/Electron" ;;
	*)                    BIN="vscodium/vscode/.build/electron/codemind" ;;
esac

step "Done"
note "run it:            scripts/run.sh [folder]"
note "or directly:       cd vscodium/vscode && ./${BIN#vscodium/vscode/} ."
note "recompile after editing the panel sources:  scripts/setup.sh --compile"
note ""
note "The panel needs an Anthropic API key, which it asks for on first use and"
note "keeps in the editor's own secret storage. Nothing writes it to this tree."
printf '\n'
