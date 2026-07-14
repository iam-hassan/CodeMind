# CodeMind — VS Code Baseline Upgrade Summary (v1.19.3 → v1.128.0)

This document records the changes made to upgrade the CodeMind VS Code fork from v1.19.3 (January 2018) to v1.128.0 (latest stable, 2025).

## What Was Done

### 1. Cloned Latest VS Code
- Cloned `microsoft/vscode` at tag `1.128.0` (commit `fc3def6774c76082adf699d366f31a557ce5573f`) into `vscode-new/`
- Shallow clone, depth=1

### 2. Applied Phase 0a Telemetry Disablement Changes

The following changes from Phase 0a were re-applied to the new codebase:

#### `product.json`
- Added `"enableTelemetry": false`

#### `src/vs/code/electron-main/app.ts`
- Forced `NullTelemetryService` unconditionally (commented out the `supportsTelemetry` conditional block)
- Commented out `ErrorTelemetry` registration

#### `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts`
- Forced `NullTelemetryService` unconditionally (commented out the telemetry creation block with `OneDataSystemAppender`)
- Note: File moved from `src/vs/code/electron-browser/sharedProcessMain.ts` to `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts`

#### `src/vs/code/node/cliProcessMain.ts`
- Forced `NullTelemetryService` unconditionally (commented out the telemetry creation block)

#### `src/vs/platform/update/common/update.ts`
- Added `NullUpdateService` class that returns no-op/idle values for all update methods

#### `src/vs/workbench/workbench.desktop.main.ts`
- Commented out `survey.contribution.js` import (telemetry surveys)
- Note: File was `workbench.main.ts` in v1.19.3, now split into `workbench.desktop.main.ts` and `workbench.common.main.ts`

#### Extension `package.json` files — removed `aiKey` from:
- `extensions/git/package.json`
- `extensions/github/package.json`
- `extensions/github-authentication/package.json`
- `extensions/html-language-features/package.json`
- `extensions/json-language-features/package.json`
- `extensions/markdown-language-features/package.json`
- `extensions/markdown-math/package.json`
- `extensions/media-preview/package.json`
- `extensions/merge-conflict/package.json`
- `extensions/mermaid-markdown-features/package.json`
- `extensions/microsoft-authentication/package.json`
- `extensions/simple-browser/package.json`
- `extensions/typescript-language-features/package.json`

## Remaining Work

The following Phase 0a changes still need to be applied:

### Extension Gallery Service
- `src/vs/platform/extensionManagement/node/extensionGalleryService.ts` — Force `isEnabled()` to return `false`
- Note: File path may have changed

### Extension Tips Service
- `src/vs/workbench/services/extensionManagement/electron-browser/extensionTipsService.ts` — Stub recommendations
- Note: File path changed from `parts/extensions/electron-browser/`

### Fingerprinting (id.ts)
- `src/vs/base/node/id.ts` — Bypass `getmac`, return random UUID
- Need to verify file still exists at same path

### Experiments Service
- `src/vs/platform/telemetry/common/experiments.ts` — Return empty from `getExperiments()`
- Need to verify file path

### Extension Telemetry Stubs
- TypeScript extension telemetry — need to locate and stub
- Markdown extension telemetry — need to locate and stub
- Note: Extension paths changed (e.g., `markdown` → `markdown-language-features`)

### Build Configuration
- `build/npm/postinstall.js` — Skip telemetry-related extensions
- `build/gulpfile.extensions.js` — Exclude test-only extensions
- `src/tsconfig.json` — Set `noUnusedLocals: false`, `noUnusedParameters: false`

### Version Requirements
- `.nvmrc` needs to be updated from `8.9.2` to `24.17.0`
- Node.js 24.x must be installed to build

## Key Structural Changes from v1.19.3 → v1.128.0

| Area | Old (v1.19.3) | New (v1.128.0) |
|---|---|---|
| Workbench parts | `parts/<name>/` | `contrib/<name>/` |
| Workbench main | `workbench.main.ts` | `workbench.desktop.main.ts` + `workbench.common.main.ts` |
| Shared process | `electron-browser/sharedProcessMain.ts` | `electron-utility/sharedProcess/sharedProcessMain.ts` |
| Build system | `gulpfile.js` (Gulp 3) | `gulpfile.mjs` (ES modules) |
| Package manager | Yarn 1.x | npm (package-lock.json) |
| Extension names | `markdown`, `typescript` | `markdown-language-features`, `typescript-language-features` |
| Telemetry | AppInsights | 1DS (OneDataSystem) |

## Verification

To verify the build:
1. Install Node.js 24.x
2. `cd vscode-new`
3. `npm install`
4. `npm run compile`
5. `./scripts/code.sh` (or `code.bat` on Windows)

The build should complete with 0 errors and launch the editor.

## Notes

- All changes use `CODEMIND-DISABLED:` comments for auditability
- No code was deleted; all disabled logic is preserved as comments
- The upgrade preserves the telemetry disablement semantics from Phase 0a
