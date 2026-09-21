import * as assert from 'assert';
import { buildRetrievalRequest, executeRetrieval } from '../orchestration/retrievalRequest.js';
import { buildEditorState } from '../orchestration/editorState.js';

suite('PPB › retrievalRequest', () => {
	test('buildRetrievalRequest formats correctly', () => {
		const req: any = { prompt: 'hello', attachments: [{ path: 'file1.ts' }, 'file2.ts'] };
		const history: any[] = [{ role: 'user', content: 'prev' }];
		const result = buildRetrievalRequest('uuid-A', req, 'fact', history, 1500);

		assert.strictEqual(result.projectId, 'uuid-A');
		assert.strictEqual(result.query, 'hello');
		assert.strictEqual(result.intent, 'fact');
		assert.deepStrictEqual(result.openFiles, ['file1.ts', 'file2.ts']);
		assert.strictEqual(result.recentTurns.length, 1);
		assert.strictEqual(result.maxTokenBudget, 1500);
	});

	test('buildEditorState formats correctly', () => {
		const req: any = { cwd: '/test/cwd', attachments: ['file1.ts'] };
		const result = buildEditorState(req, 'fact');

		assert.strictEqual(result.cwd, '/test/cwd');
		assert.strictEqual(result.intent, 'fact');
		assert.deepStrictEqual(result.openFiles, ['file1.ts']);
	});

	test('executeRetrieval returns empty array on timeout', async () => {
		const slowRetriever = {
			retrieve: async () => new Promise<any>((resolve) => setTimeout(() => resolve([{ id: '1' }]), 50))
		};
		const result = await executeRetrieval(slowRetriever as any, {} as any, 10);
		assert.deepStrictEqual(result, []);
	});

	test('executeRetrieval returns empty array on throw', async () => {
		const throwingRetriever = {
			retrieve: async () => { throw new Error('Failed'); }
		};
		const result = await executeRetrieval(throwingRetriever as any, {} as any, 100);
		assert.deepStrictEqual(result, []);
	});
});
