/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the IF-12 ranked-result cache (spec §8/§10).
 *
 * A fake Redis client keeps the tests hermetic: no server, no Docker. Live Redis is covered by
 * `integration/stack.integration.test.ts` (PPB_TEST_INFRA=1).
 */

import assert from 'assert';
import type { RetrievalRequest, RetrievedFact } from '../../orchestration/retrievalRequest.js';
import {
	NoopRetrievalCache,
	RedisRetrievalCache,
	createRetrievalCache,
	retrievalCacheEntryKey,
	retrievalCacheSignature,
	retrievalCacheVersionKey,
	type RedisLike
} from '../../ppb/storage/redis.js';
import { loadPpbConfig } from '../../ppb/config.js';

class FakeRedis implements RedisLike {
	readonly store = new Map<string, string>();
	readonly ttls = new Map<string, number>();
	failAll = false;

	private _check(): void {
		if (this.failAll) {
			throw new Error('connect ECONNREFUSED 127.0.0.1:56379');
		}
	}

	async get(key: string): Promise<string | null> {
		this._check();
		return this.store.get(key) ?? null;
	}

	async set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown> {
		this._check();
		assert.strictEqual(mode, 'EX');
		this.store.set(key, value);
		this.ttls.set(key, ttlSeconds);
		return 'OK';
	}

	async incr(key: string): Promise<number> {
		this._check();
		const next = Number.parseInt(this.store.get(key) ?? '0', 10) + 1;
		this.store.set(key, String(next));
		return next;
	}

	async expire(key: string, seconds: number): Promise<number> {
		this._check();
		this.ttls.set(key, seconds);
		return 1;
	}
}

function fact(id: string, projectId = 'projectA', content = `content for ${id}`): RetrievedFact {
	return { id, content, score: 0.9, category: 'fact', projectId, sourceRef: `${projectId}:${id}` };
}

function request(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
	return {
		projectId: 'projectA', query: 'postgres store', intent: 'architecture', openFiles: [],
		recentTurns: [], maxResults: 5, maxTokenBudget: 2000, ...overrides
	};
}

function cacheWith(client: FakeRedis, ttlSeconds = 60): RedisRetrievalCache {
	return new RedisRetrievalCache({ url: 'redis://localhost:56379', ttlSeconds, client });
}

suite('PPB ranked-result cache (IF-12, spec §8/§10)', () => {

	test('round-trips a ranked list and applies the configured TTL', async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis, 90);
		const facts = [fact('m1'), fact('m2')];

		await cache.set('projectA', 'sig-1', facts);
		const loaded = await cache.get('projectA', 'sig-1');

		assert.deepStrictEqual(loaded, facts);
		const entry = retrievalCacheEntryKey('projectA', 0, 'sig-1');
		assert.strictEqual(redis.ttls.get(entry), 90, 'entry must expire');
	});

	test('a miss returns undefined (never a throw)', async () => {
		const cache = cacheWith(new FakeRedis());
		assert.strictEqual(await cache.get('projectA', 'absent'), undefined);
	});

	test('invalidate bumps a versioned key, so old entries are unreachable', async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis);
		await cache.set('projectA', 'sig-1', [fact('m1')]);
		assert.ok(await cache.get('projectA', 'sig-1'));

		await cache.invalidate('projectA');
		assert.strictEqual(redis.store.get(retrievalCacheVersionKey('projectA')), '1');
		assert.strictEqual(await cache.get('projectA', 'sig-1'), undefined, 'stale generation must miss');

		await cache.set('projectA', 'sig-1', [fact('m2')]);
		assert.deepStrictEqual(await cache.get('projectA', 'sig-1'), [fact('m2')]);
	});

	test('invalidation is project-scoped', async () => {
		const cache = cacheWith(new FakeRedis());
		await cache.set('projectA', 'sig-1', [fact('a', 'projectA')]);
		await cache.set('projectB', 'sig-1', [fact('b', 'projectB')]);

		await cache.invalidate('projectA');

		assert.strictEqual(await cache.get('projectA', 'sig-1'), undefined);
		assert.deepStrictEqual(await cache.get('projectB', 'sig-1'), [fact('b', 'projectB')]);
	});

	test('a cached entry for another project is rejected on read (§2 isolation)', async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis);
		await cache.set('projectA', 'sig-1', [fact('a', 'projectA')]);

		// Simulate a polluted/stale key holding project B's data.
		redis.store.set(retrievalCacheEntryKey('projectA', 0, 'sig-1'), JSON.stringify([fact('b', 'projectB')]));

		assert.strictEqual(await cache.get('projectA', 'sig-1'), undefined);
	});

	test('corrupt payloads degrade to a miss', async () => {
		const redis = new FakeRedis();
		const cache = cacheWith(redis);
		redis.store.set(retrievalCacheEntryKey('projectA', 0, 'sig-1'), '{not json');
		assert.strictEqual(await cache.get('projectA', 'sig-1'), undefined);
	});

	test('Redis failures degrade gracefully and never throw (§9.4/§24)', async () => {
		const redis = new FakeRedis();
		redis.failAll = true;
		const cache = cacheWith(redis);

		assert.strictEqual(await cache.get('projectA', 'sig-1'), undefined);
		await cache.set('projectA', 'sig-1', [fact('m1')]);
		await cache.invalidate('projectA');
		assert.strictEqual(cache.enabled, false, 'the cache disables itself after a failure');
	});

	test('signature is stable across open-file order and changes with the request/profile', () => {
		const base = retrievalCacheSignature(request({ openFiles: ['b.ts', 'a.ts'] }));
		assert.strictEqual(base, retrievalCacheSignature(request({ openFiles: ['a.ts', 'b.ts'] })));
		assert.notStrictEqual(base, retrievalCacheSignature(request({ query: 'different' })));
		assert.notStrictEqual(base, retrievalCacheSignature(request({ maxTokenBudget: 500 })));
		assert.notStrictEqual(base, retrievalCacheSignature(request(), { version: 'v2', weights: { x: 1 }, topK: 5 }));
	});

	test('NoopRetrievalCache is inert, and the factory respects the disable flag', async () => {
		assert.strictEqual(NoopRetrievalCache.enabled, false);
		assert.strictEqual(await NoopRetrievalCache.get('projectA', 'x'), undefined);
		await NoopRetrievalCache.set('projectA', 'x', [fact('m1')]);
		await NoopRetrievalCache.invalidate('projectA');
		await NoopRetrievalCache.close();

		assert.strictEqual(createRetrievalCache(loadPpbConfig({ PPB_REDIS_CACHE: '0' })).enabled, false);
		assert.strictEqual(createRetrievalCache(loadPpbConfig({ PPB_REDIS_URL: '' })).enabled, false);
	});
});
