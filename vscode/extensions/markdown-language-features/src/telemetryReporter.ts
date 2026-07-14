/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CODEMIND-DISABLED: Telemetry disabled - all imports and classes commented out
// import { default as VSCodeTelemetryReporter } from '@vscode/extension-telemetry';
// import * as vscode from 'vscode';

// CODEMIND-DISABLED: IPackageInfo no longer needed but kept for reference
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

// CODEMIND-DISABLED: ExtensionReporter no longer needed but kept for reference
class ExtensionReporter implements TelemetryReporter {
	readonly #reporter: any;

	constructor(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		packageInfo: IPackageInfo
	) {
		// this.#reporter = new VSCodeTelemetryReporter(packageInfo.aiKey);
	}
	sendTelemetryEvent(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		eventName: string,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		properties?: { [key: string]: string }
	) {
		// this.#reporter.sendTelemetryEvent(eventName, properties);
	}

	dispose() {
		// this.#reporter.dispose();
	}
}

export function loadDefaultTelemetryReporter(): TelemetryReporter {
	// CODEMIND-DISABLED: Always return null reporter
	// Suppress unused warnings
	void ExtensionReporter;
	void getPackageInfo;
	return nullReporter;
}

function getPackageInfo(): IPackageInfo | null {
	// CODEMIND-DISABLED: Telemetry disabled
	// const extension = vscode.extensions.getExtension('Microsoft.vscode-markdown');
	// if (extension?.packageJSON) {
	// 	return {
	// 		name: extension.packageJSON.name,
	// 		version: extension.packageJSON.version,
	// 		aiKey: extension.packageJSON.aiKey
	// 	};
	// }
	return null;
}
