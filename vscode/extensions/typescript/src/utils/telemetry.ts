/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import VsCodeTelemetryReporter from 'vscode-extension-telemetry';

interface IPackageInfo {
	name: string;
	version: string;
	aiKey: string;
}

export default class TelemetryReporter {
	private _packageInfo: IPackageInfo | null;
	private _reporter: VsCodeTelemetryReporter | null;

	// CODEMIND-DISABLED: suppress unused warnings from commented-out telemetry
	dispose() {
		if (this._reporter) {
			this._reporter.dispose();
			this._reporter = null;
		}
	}

	constructor(
		private readonly clientVersionDelegate: () => string
	) { }

	public logTelemetry(eventName: string, properties?: { [prop: string]: string }) {
		// CODEMIND-DISABLED: telemetry disabled - noop
		void this.reporter;
	}

	private get reporter(): VsCodeTelemetryReporter | null {
		// CODEMIND-DISABLED: force reporter to null
		this._reporter = null;
		return this._reporter;
	}

	private get packageInfo(): IPackageInfo | null {
		// CODEMIND-DISABLED: telemetry disabled - return null
		if (this._packageInfo !== undefined) {
			return this._packageInfo;
		}
		const packagePath = path.join(__dirname, '..', '..', 'package.json');
		const extensionPackage = require(packagePath);
		if (extensionPackage) {
			this._packageInfo = {
				name: extensionPackage.name,
				version: extensionPackage.version,
				aiKey: extensionPackage.aiKey
			};
		} else {
			this._packageInfo = null;
		}

		return this._packageInfo;
	}
}