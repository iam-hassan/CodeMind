import { setRetriever, setSink, NullRetriever, NoopSegmentSink } from '../tools/ProjectBrainTool/ProjectBrainTool.js';

export function bootstrapPPB() {
	// For Part 2, we just use the default NullRetriever and NoopSegmentSink
	setRetriever(new NullRetriever());
	setSink(new NoopSegmentSink());
}
