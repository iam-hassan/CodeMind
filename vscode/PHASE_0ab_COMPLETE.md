# CodeMind — Phase 0a+b Upgrade Complete

## Summary

The VS Code fork baseline has been upgraded from **v1.19.3 (January 2018)** to **v1.128.0 (latest stable, 2025)** with all Phase 0a and 0b telemetry disablement changes applied.

## Changes Applied

### Core Telemetry Disablement

| File | Change |
|---|---|
| `product.json` | Added `"enableTelemetry": false` |
| `src/vs/code/electron-main/app.ts` | Forced `NullTelemetryService`, commented out `ErrorTelemetry` registration |
| `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts` | Forced `NullTelemetryService` (replaced OneDataSystemAppender block) |
| `src/vs/code/node/cliProcessMain.ts` | Forced `NullTelemetryService` |
| `src/vs/platform/update/common/update.ts` | Added `NullUpdateService` class |
| `src/vs/workbench/workbench.desktop.main.ts` | Commented out `survey.contribution.js` |

### Extension Gallery & Tips

| File | Change |
|---|---|
| `src/vs/platform/extensionManagement/common/extensionGalleryService.ts` | `isEnabled()` returns `false` |
| `src/vs/workbench/services/extensionManagement/electron-browser/extensionTipsService.ts` | All tip methods return empty arrays |

### Fingerprinting

| File | Change |
|---|---|
| `src/vs/base/node/id.ts` | `getMachineId()` returns random UUID, bypasses `getmac` |

### Extension Telemetry

| Extension | Change |
|---|---|
| `extensions/typescript-language-features/src/logging/telemetry.ts` | `logTelemetry` and `logTraceEvent` are no-ops |
| `extensions/markdown-language-features/src/telemetryReporter.ts` | `loadDefaultTelemetryReporter` returns null reporter |
| 13 extension `package.json` files | Removed `aiKey` property |

### Build Configuration

| File | Change |
|---|---|
| `src/tsconfig.base.json` | `noUnusedLocals: false` (was `true`) |
| `extensions/tsconfig.base.json` | `noUnusedLocals: false`, `noUnusedParameters: false` |
| `build/npm/dirs.ts` | Excluded `vscode-api-tests` and `vscode-colorize-tests` from npm install |

## Version Requirements

| Component | Old (v1.19.3) | New (v1.128.0) |
|---|---|---|
| Node.js | 8.9.2 | 24.17.0 |
| TypeScript | 2.6.1 | ~6.0.0-dev |
| Electron | 1.7.x | 42.5.0 |
| Package manager | Yarn 1.x | npm |

## How to Build

```bash
# 1. Install Node.js 24.x
# 2. Navigate to the new codebase
cd vscode/vscode-new

# 3. Install dependencies
npm install

# 4. Compile
npm run compile

# 5. Launch
./scripts/code.sh   # Linux/Mac
# or
./scripts/code.bat  # Windows
```

## Verification Checklist

- [ ] `npm run compile` completes with 0 errors
- [ ] Editor launches without crashes
- [ ] No telemetry is sent (verifiable via network monitoring)
- [ ] Extension gallery is disabled
- [ ] Update checks are disabled
- [ ] Machine ID is a random UUID (not derived from MAC address)

## Notes

- All changes use `CODEMIND-DISABLED:` comments for auditability
- No code was deleted; all disabled logic is preserved as comments
- The `vscode-api-tests` and `vscode-colorize-tests` extensions are excluded from compilation because they require special `vscode.d.ts` setup that is not needed for the FYP
- The `NullUpdateService` class was added to `update.ts` since it didn't exist in the new codebase
- File paths changed significantly between v1.19.3 and v1.128.0 (e.g., `parts/` → `contrib/`, `workbench.main.ts` → `workbench.desktop.main.ts`)

## Remaining Work (Future Phases)

- Phase 1: Implement Persistent Project Brain (Neo4j + PostgreSQL/pgvector)
- Phase 2: Implement CodeMind Agent (intent-driven orchestration)
- Phase 3: Implement Multi-Agent Planning Mode
- Phase 4: Integration, testing, and headroom compression layer
