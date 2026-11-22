import { bootstrapPPBFromEnv, setRetriever, setSink, NullRetriever, NoopSegmentSink } from '../tools/ProjectBrainTool/ProjectBrainTool.js';

/**
 * A7 — bind the Project Brain tool to the live backend the engine advertised
 * (CODEMIND_PPB_BACKEND_URL / CODEMIND_PPB_BACKEND_TOKEN). When no backend is advertised the tool
 * keeps its null adapters (no behaviour change).
 */
export function bootstrapPPB() {
	if (bootstrapPPBFromEnv()) {
		return;
	}
	setRetriever(new NullRetriever());
	setSink(new NoopSegmentSink());
}
