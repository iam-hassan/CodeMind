# CodeMind — Phase 0a Cleanup Audit Log

This audit log records the exact edits performed to disable and comment out telemetry and Microsoft services. No code is deleted; all disabled logic is marked with `CODEMIND-DISABLED:` comments to simplify auditing and restoration in the future.

---

## 1. Product Config
* **File:** `vscode/product.json`
* **Changes:** Add `"enableTelemetry": false`, and omit or empty telemetry, crash reporter, survey, and update endpoints.

---

## 2. Core Telemetry Wiring & AppInsights

### [app.ts](file:///e:/CodeMind/vscode/src/vs/code/electron-main/app.ts)
* **Action:** Force fallback to `NullTelemetryService` and comment out proxy authentication handler.
* **Code Changes:**
  * Comment out telemetry appender creation and telemetry service conditional instantiation. Register `NullTelemetryService` unconditionally.
  * Comment out `ProxyAuthHandler` instantiation.

### [sharedProcessMain.ts](file:///e:/CodeMind/vscode/src/vs/code/electron-browser/sharedProcessMain.ts)
* **Action:** Disable `AppInsightsAppender` creation and register `NullTelemetryService`.
* **Code Changes:**
  * Comment out the checks and creation of `AppInsightsAppender`.
  * Force registration of `NullTelemetryService`.

### [cliProcessMain.ts](file:///e:/CodeMind/vscode/src/vs/code/node/cliProcessMain.ts)
* **Action:** Disable `AppInsightsAppender` creation and register `NullTelemetryService`.
* **Code Changes:**
  * Comment out `AppInsightsAppender` block.
  * Force registration of `NullTelemetryService`.

### [shell.ts](file:///e:/CodeMind/vscode/src/vs/workbench/electron-browser/shell.ts)
* **Action:** Register `NullTelemetryService` and disable crash reporter/error telemetry.
* **Code Changes:**
  * Force `this.telemetryService = NullTelemetryService`.
  * Comment out `ErrorTelemetry` creation and activation.
  * Comment out conditional block for `CrashReporterService` and register `NullCrashReporterService` directly.

---

## 3. Update Service

### [update.ts](file:///e:/CodeMind/vscode/src/vs/platform/update/common/update.ts)
* **Action:** Add `NullUpdateService` implementation.
* **Code Changes:**
  * Define and export `NullUpdateService` that returns no-op/idle values.

---

## 4. Workbench Contributions

### [workbench.main.ts](file:///e:/CodeMind/vscode/src/vs/workbench/workbench.main.ts)
* **Action:** Comment out feedback, update UI, surveys, and stats contributions.
* **Code Changes:**
  * Comment out imports for `stats.contribution`, `feedback.contribution`, `update.contribution`, `nps.contribution`, and `languageSurveys.contribution`.

---

## 5. Extension Gallery & Tips

### [extensionGalleryService.ts](file:///e:/CodeMind/vscode/src/vs/platform/extensionManagement/node/extensionGalleryService.ts)
* **Action:** Force `isEnabled` to return `false`.
* **Code Changes:**
  * Modify `isEnabled(): boolean` to return `false` directly.

### [extensionTipsService.ts](file:///e:/CodeMind/vscode/src/vs/workbench/parts/extensions/electron-browser/extensionTipsService.ts)
* **Action:** Stub out recommendations and tips.
* **Code Changes:**
  * Stub all public functions (recommendations, workspace recommendations, keymaps, keywords) to return empty lists/promises.

---

## 6. Fingerprinting & Experiments

### [id.ts](file:///e:/CodeMind/vscode/src/vs/base/node/id.ts)
* **Action:** Bypasses `getmac` library and generates a cached random UUID.
* **Code Changes:**
  * Change `getMachineId` to return `TPromise.as(uuid.generateUuid())` without loading `getmac`.

### [experiments.ts](file:///e:/CodeMind/vscode/src/vs/platform/telemetry/common/experiments.ts)
* **Action:** Bypasses telemetry experiments loading.
* **Code Changes:**
  * Return `{}` directly from `ExperimentService.getExperiments()`.

---

## 7. Extension Telemetry (aiKey & Reporters)

### built-in extensions `package.json`
* Remove `"aiKey"` from the following extensions:
  * `extensions/typescript/package.json`
  * `extensions/markdown/package.json`
  * `extensions/git/package.json`
  * `extensions/json/package.json`
  * `extensions/html/package.json`
  * `extensions/merge-conflict/package.json`

### [telemetry.ts (typescript)](file:///e:/CodeMind/vscode/extensions/typescript/src/utils/telemetry.ts)
* Force reporter initialization to resolve to `null`.

### [telemetryReporter.ts (markdown)](file:///e:/CodeMind/vscode/extensions/markdown/src/telemetryReporter.ts)
* Force `loadDefaultTelemetryReporter` to return `nullReporter`.

### [main.ts (git)](file:///e:/CodeMind/vscode/extensions/git/src/main.ts)
* Kept original implementation. Telemetry is disabled via the removal of `"aiKey"` in `package.json` and the global `enableTelemetry` configuration.

### [jsonMain.ts (json)](file:///e:/CodeMind/vscode/extensions/json/client/src/jsonMain.ts)
* Kept original implementation. Telemetry is disabled via the removal of `"aiKey"` in `package.json` and the global `enableTelemetry` configuration.

### [htmlMain.ts (html)](file:///e:/CodeMind/vscode/extensions/html/client/src/htmlMain.ts)
* Kept original implementation. Telemetry is disabled via the removal of `"aiKey"` in `package.json` and the global `enableTelemetry` configuration.
