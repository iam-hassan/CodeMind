import * as assert from 'assert';
import {
	isDependencyFile,
	isTopLevelStructureChange,
	detectRepoChanges,
	triggerLearningLoop
} from '../orchestration/learningLoop.js';

suite('PPB › learningLoop', () => {

	test('isDependencyFile recognizes package files', () => {
		assert.strictEqual(isDependencyFile('package.json'), true);
		assert.strictEqual(isDependencyFile('src/package.json'), true);
		assert.strictEqual(isDependencyFile('requirements.txt'), true);
		assert.strictEqual(isDependencyFile('main.ts'), false);
	});

	test('isTopLevelStructureChange recognizes root files and top-level folders', () => {
		assert.strictEqual(isTopLevelStructureChange('Makefile'), true);
		assert.strictEqual(isTopLevelStructureChange('/Makefile'), true);
		assert.strictEqual(isTopLevelStructureChange('src/index.ts'), true, 'one slash is a top level folder');
		assert.strictEqual(isTopLevelStructureChange('/src/index.ts'), true);
		assert.strictEqual(isTopLevelStructureChange('src/components/index.ts'), false, 'two slashes is not top level');
	});

	test('detectRepoChanges extracts files from tools', () => {
		const tools = [
			{ name: 'FileWrite', inputJson: JSON.stringify({ file_path: 'package.json' }) },
			{ name: 'Bash', inputJson: JSON.stringify({ command: 'ls' }) }
		];
		const res = detectRepoChanges(tools);
		assert.ok(res);
		assert.strictEqual(res.scope, 'dependency');
		assert.deepStrictEqual(res.changedPaths, ['package.json']);
	});

	test('triggerLearningLoop fires on first turn', () => {
		let fired = false;
		const sink = {
			ingest: async () => {},
			scheduleBackfill: (pId: string, opts: any) => {
				assert.strictEqual(opts.scope, 'project');
				fired = true;
			}
		};
		triggerLearningLoop(undefined, 'p1', [], 1, sink);
		assert.strictEqual(fired, true);
	});

	test('triggerLearningLoop fires on high cost', () => {
		let fired = false;
		const sink = {
			ingest: async () => {},
			scheduleBackfill: (pId: string, opts: any) => {
				assert.strictEqual(opts.scope, 'project');
				fired = true;
			}
		};
		triggerLearningLoop({ total_cost_usd: 0.05 }, 'p1', [], 2, sink);
		assert.strictEqual(fired, true);
	});

	test('triggerLearningLoop fires on 10th turn', () => {
		let fired = false;
		const sink = {
			ingest: async () => {},
			scheduleBackfill: (pId: string, opts: any) => {
				assert.strictEqual(opts.scope, 'project');
				fired = true;
			}
		};
		triggerLearningLoop({ total_cost_usd: 0.005 }, 'p1', [], 10, sink);
		assert.strictEqual(fired, true);
	});

	test('triggerLearningLoop does not fire if no conditions met', () => {
		let fired = false;
		const sink = {
			ingest: async () => {},
			scheduleBackfill: () => { fired = true; }
		};
		triggerLearningLoop({ total_cost_usd: 0.005 }, 'p1', [], 2, sink);
		assert.strictEqual(fired, false);
	});

	test('triggerLearningLoop throws are caught', () => {
		const sink = {
			ingest: async () => {},
			scheduleBackfill: () => { throw new Error('Failed'); }
		};
		// Should not throw
		triggerLearningLoop(undefined, 'p1', [], 1, sink);
	});

});
