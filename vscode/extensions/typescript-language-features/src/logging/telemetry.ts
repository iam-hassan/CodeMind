/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExperimentationTelemetryReporter } from '../experimentTelemetryReporter';

export interface TelemetryProperties {
	readonly [prop: string]: string | number | boolean | undefined;
}

export interface TelemetryReporter {
	logTelemetry(eventName: string, properties?: TelemetryProperties): void;
	logTraceEvent(tracePoint: string, correlationId: string, command?: string): void;
}

export class VSCodeTelemetryReporter implements TelemetryReporter {
	constructor(
		private readonly reporter: IExperimentationTelemetryReporter | undefined,
		private readonly clientVersionDelegate: () => string
	) { }

	public logTelemetry(_eventName: string, _properties: { [prop: string]: string } = {}) {
		// CODEMIND-DISABLED: Telemetry disabled - noop
		// Original implementation posted events via the reporter.
		// if (!reporter) { return; }
		// properties['version'] = this.clientVersionDelegate();
		// reporter.postEventObj(eventName, properties);
	}

	public logTraceEvent(_point: string, _traceId: string, _data?: string): void {
		// CODEMIND-DISABLED: Telemetry disabled - noop
		// Original implementation logged trace events.
	}
}
