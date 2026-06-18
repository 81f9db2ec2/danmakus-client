import { afterEach, describe, expect, test } from 'bun:test';
import { RuntimeEndpoints } from './RuntimeEndpoints.js';
import { RuntimeConnection } from './RuntimeConnection.js';
import { AccountApiClient } from './AccountApiClient.js';
import type { LiveSessionOutboxItem } from '../types/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const stubFetch = (captured: string[]) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    captured.push(typeof input === 'string' ? input : input.toString());
    return new Response(JSON.stringify({ code: 200, data: { rejected: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
};

const dueRecord: LiveSessionOutboxItem = {
  id: 1,
  streamerUid: 1001,
  eventTsMs: 1710000001000,
  payload: new Uint8Array([1, 2, 3]),
  retryCount: 0,
  nextRetryAtMs: 1710000001000,
};

describe('RuntimeEndpoints 单一地址源', () => {
  test('派生 core-runtime 与 streamer-status 地址', () => {
    const endpoints = new RuntimeEndpoints('https://a.danmakus.com/api/v2/core-runtime');
    expect(endpoints.getCoreRuntimeBaseUrl()).toBe('https://a.danmakus.com/api/v2/core-runtime');
    expect(endpoints.getStreamerStatusBaseUrl()).toBe('https://a.danmakus.com/api/v2/streamer-status');
  });

  test('setRuntimeUrl 空值忽略，保留当前地址', () => {
    const endpoints = new RuntimeEndpoints('https://a.danmakus.com/api/v2/core-runtime');
    endpoints.setRuntimeUrl('');
    expect(endpoints.getCoreRuntimeBaseUrl()).toBe('https://a.danmakus.com/api/v2/core-runtime');
  });

  test('更新一次地址源，上传与同步同时切换（杜绝漏改）', async () => {
    const endpoints = new RuntimeEndpoints('https://old.danmakus.com/api/v2/core-runtime');
    const upload = new RuntimeConnection(
      'https://old.danmakus.com/api/v2/core-runtime',
      true, 5000,
      { Token: 'token', ClientId: 'client-1' },
      undefined,
      endpoints,
    );
    const account = new AccountApiClient(
      'token',
      (input, init) => globalThis.fetch(input, init),
      endpoints,
    );

    // 仅更新地址源这一处
    endpoints.setRuntimeUrl('https://new.danmakus.com/api/v2/core-runtime');

    const captured: string[] = [];
    stubFetch(captured);

    await upload.sendArchiveBatch([dueRecord]);
    await account.syncRuntimeState({ clientId: 'client-1' });

    expect(captured.find(u => u.includes('/upload-danmakus-v5')))
      .toBe('https://new.danmakus.com/api/v2/core-runtime/upload-danmakus-v5');
    expect(captured.find(u => u.includes('/sync')))
      .toStartWith('https://new.danmakus.com/api/v2/core-runtime/sync');
    expect(account.getCoreRuntimeBaseUrl()).toBe('https://new.danmakus.com/api/v2/core-runtime');
  });
});
