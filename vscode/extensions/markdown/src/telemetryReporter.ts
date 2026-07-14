/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CODEMIND-DISABLED: VSCodeTelemetryReporter import no longer needed
// import * as vscode from 'vscode';
// import { default as VSCodeTelemetryReporter } from 'vscode-extension-telemetry';

// CODEMIND-DISABLED: IPackageInfo interface no longer needed but kept for reference
interface IPackageInfo {
	name: string;
	version: string;
	aiKey: string;
}

export interface TelemetryReporter {
	dispose(): void;
	sendTelemetryEvent(eventName: string, properties?: {
		[key: string]: string;
	}): void;
}

const nullReporter = new class NullTelemetryReporter implements TelemetryReporter {
	sendTelemetryEvent() { /** noop */ }
	dispose() { /** noop */ }
};

// CODEMIND-DISABLED: ExtensionReporter class no longer needed but kept for reference
class ExtensionReporter implements TelemetryReporter {
	// CODEMIND-DISABLED: telemetry disabled
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	private readonly _reporter: any;

	constructor(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		packageInfo: IPackageInfo
	) {
		// this._reporter = new VSCodeTelemetryReporter(packageInfo.name, packageInfo.version, packageInfo.aiKey);
	}
	sendTelemetryEvent(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		eventName: string,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		properties?: { [key: string]: string }
	) {
		// this._reporter.sendTelemetryEvent(eventName, properties);
	}

	dispose() {
		// this._reporter.dispose();
	}
}

export function loadDefaultTelemetryReporter(): TelemetryReporter {
	// CODEMIND-DISABLED: always return nullReporter
	// Suppress unused warnings for ExtensionReporter and getPackageInfo
	void ExtensionReporter;
	void getPackageInfo;
	return nullReporter;
}

function getPackageInfo(): IPackageInfo | null {
	// CODEMIND-DISABLED: telemetry disabled - function kept for reference
	// const extention = vscode.extensions.getExtension('Microsoft.vscode-markdown');
	// if (extention && extention.packageJSON) {
	// 	return {
	// 		name: extention.packageJSON.name,
	// 		version: extention.packageJSON.version,
	// 		aiKey: extention.packageJSON.aiKey
	// 	};
	// }
	return null;
}
