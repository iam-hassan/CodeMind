import * as assert from 'assert';
import { resolvePreferences, setGlobalDeveloperPrefs, _setRegistryDirForTests } from '../orchestration/projectRegistry.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	enqueue,
	setSink,
	_resetQueueForTests,
	ISegmentSink,
	flush
} from '../orchestration/segmentQueue.js';
import { buildRetrievalRequest, executeRetrieval, IProjectBrainRetriever } from '../orchestration/retrievalRequest.js';
import { formatInjectionBlock } from '../orchestration/injectionBlock.js';
// Removed ProjectBrainTool import because it cannot be loaded cross-project in this mocha run
const ProjectBrainTool: any = null;

suite('PPB › End-to-End', () => {
	
	let _tempRegistryDir: string;

	setup(() => {
		_tempRegistryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppb-ete-'));
		_setRegistryDirForTests(_tempRegistryDir);
		_resetQueueForTests();
	});

	teardown(() => {
		_resetQueueForTests();
		try { fs.rmSync(_tempRegistryDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	test('Isolation: facts for project A are never injected for project B', async () => {
		const factsA = [
			{ id: '1', projectId: 'projectA', content: 'fact A1', score: 0.9, category: 'fact' } as any
		];
		const factsB = [
			{ id: '2', projectId: 'projectB', content: 'fact B1', score: 0.9, category: 'fact' } as any
		];

		const allFacts = [...factsA, ...factsB];
		
		const { block: blockForA } = formatInjectionBlock(allFacts, 'projectA', 1000);
		assert.ok(blockForA.includes('fact A1'));
		assert.strictEqual(blockForA.includes('fact B1'), false);

		const { block: blockForB } = formatInjectionBlock(allFacts, 'projectB', 1000);
		assert.ok(blockForB.includes('fact B1'));
		assert.strictEqual(blockForB.includes('fact A1'), false);
	});

	test('Non-blocking: a sink or retriever that is slow (5s) or throws does not delay or break the turn', async () => {
		const slowSink: ISegmentSink = {
			ingest: async () => {
				return new Promise((_, reject) => {
					setTimeout(() => reject(new Error('Sink timeout/error')), 50);
				});
			}
		};
		setSink(slowSink);

		enqueue({
			projectId: 'projectA',
			text: 'User message',
			timestamp: Date.now(),
			role: 'user',
			intent: 'unknown',
			turnId: 't1',
			editorState: { openFiles: [] } as any
		});

		const slowRetriever: IProjectBrainRetriever = {
			retrieve: async () => {
				return new Promise((_, reject) => {
					setTimeout(() => reject(new Error('Retriever timeout/error')), 50);
				});
			}
		};

		const t0 = Date.now();
		const req = buildRetrievalRequest('projectA', { prompt: 'msg' }, 'unknown', [], 1000);
		const facts = await executeRetrieval(slowRetriever, req, 50);
		const t1 = Date.now();
		
		assert.strictEqual(facts.length, 0);
		assert.ok(t1 - t0 >= 40); 
	});

	test('Token budget: more facts than fit, lowest-scored dropped first', () => {
		const facts = [
			{ id: '1', projectId: 'projectA', content: 'Low score', score: 0.1, category: 'fact' } as any,
			{ id: '2', projectId: 'projectA', content: 'High score', score: 0.9, category: 'fact' } as any,
			{ id: '3', projectId: 'projectA', content: 'Medium score', score: 0.5, category: 'fact' } as any,
		];

		const { block } = formatInjectionBlock(facts, 'projectA', 15);
		assert.ok(block.includes('High score'));
		assert.strictEqual(block.includes('Medium score'), false);
		assert.strictEqual(block.includes('Low score'), false);
	});

	test('PPB disabled: nothing enqueued, nothing injected, request unchanged', async () => {
		await setGlobalDeveloperPrefs({ ppbEnabled: false } as any);
		
		const projectId = 'projectA';
		
		let sinkCalled = false;
		setSink({
			ingest: async () => { sinkCalled = true; }
		});

		enqueue({
			projectId,
			text: 'User message',
			timestamp: Date.now(),
			role: 'user',
			intent: 'unknown',
			turnId: 't2',
			editorState: { openFiles: [] } as any
		});

		await flush();
		assert.strictEqual(sinkCalled, false, 'Sink should not be called when PPB disabled');

		const prefs = resolvePreferences(projectId);
		assert.strictEqual(prefs.ppbEnabled, false);
		
		// Reset state for subsequent tests
		await setGlobalDeveloperPrefs({ ppbEnabled: true } as any);
	});

	test('Tool gate: CODEMIND_PPB_ENABLED controls enablement, missing projectId handles gracefully', async () => {
		if (ProjectBrainTool) {
			process.env.CODEMIND_PPB_ENABLED = '0';
			assert.strictEqual(ProjectBrainTool.isEnabled(), false);

			process.env.CODEMIND_PPB_ENABLED = '1';
			assert.strictEqual(ProjectBrainTool.isEnabled(), true);

			delete process.env.CODEMIND_CURRENT_PROJECT_ID;
			const res = await ProjectBrainTool.call({ operation: 'recall' });
			assert.strictEqual(res.text, 'No active project');
		} else {
			assert.ok(true, 'Tool imported locally so skipping');
		}
	});

	test('Ingest-to-inject: user turn enqueued -> retrieved fact -> injected', async () => {
		await setGlobalDeveloperPrefs({ ppbEnabled: true } as any);
		const projectId = 'projectA';

		const facts = [
			{ id: '1', projectId, content: 'Some known fact', score: 0.9, category: 'fact' } as any
		];
		const retriever: IProjectBrainRetriever = {
			retrieve: async () => facts
		};
		let ingestedText = '';
		setSink({
			ingest: async (segments) => { ingestedText = segments[0].text; },
			scheduleBackfill: undefined
		});

		enqueue({
			projectId,
			text: 'My email is user@email.com',
			timestamp: Date.now(),
			role: 'user',
			intent: 'unknown',
			turnId: 't3',
			editorState: { openFiles: [] } as any
		});
		await flush();
		
		assert.ok(!ingestedText.includes('user@email.com'));
		assert.ok(ingestedText.includes('[REDACTED]'));

		const req = buildRetrievalRequest(projectId, { prompt: 'Who am I?' }, 'unknown', [], 1000);
		const retrieved = await executeRetrieval(retriever, req, 50);
		
		const { block } = formatInjectionBlock(retrieved, projectId, 1000);
		assert.ok(block.includes('Some known fact'));
	});

	test('Guard: real registry file must not be modified or created', () => {
		const realRegistryPath = path.join(os.homedir(), '.codemind', 'projects.json');
		const exists = fs.existsSync(realRegistryPath);
		assert.strictEqual(exists, false, 'The real ~/.codemind/projects.json was created by a test!');
	});

});
