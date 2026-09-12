import { afterEach, describe, expect, test } from 'bun:test';
import { RuntimeConnection } from './RuntimeConnection.js';
import type { LiveSessionOutboxItem } from '../types/index.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const dueRecords: LiveSessionOutboxItem[] = [{
  id: 1,
  streamerUid: 1001,
  eventTsMs: 1710000001000,
  payload: new Uint8Array([1, 2, 3]),
  retryCount: 0,
  nextRetryAtMs: 1710000001000,
}];

const stubFetch = (captured: string[]) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    captured.push(typeof input === 'string' ? input : input.toString());
    return new Response(JSON.stringify({ code: 200, data: { rejected: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
};

describe('RuntimeConnection 上传地址', () => {
  test('使用构造时传入的 runtimeUrl 作为上传目标', async () => {
    const captured: string[] = [];
    stubFetch(captured);

    const connection = new RuntimeConnection(
      'https://client.danmakus.com/api/v2/core-runtime',
      true,
      5000,
      { Token: 'token', ClientId: 'client-1' },
    );

    await connection.sendArchiveBatch(dueRecords);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe('https://client.danmakus.com/api/v2/core-runtime/upload-danmakus-v5');
  });

  test('不同 runtimeUrl 切换到不同上传服务器', async () => {
    const captured: string[] = [];
    stubFetch(captured);

    const connection = new RuntimeConnection(
      'https://upload-2.danmakus.com/api/v2/core-runtime',
      true,
      5000,
      { Token: 'token', ClientId: 'client-1' },
    );

    await connection.sendArchiveBatch(dueRecords);

    expect(captured[0]).toStartWith('https://upload-2.danmakus.com/');
    expect(captured[0]).not.toStartWith('https://ukamnads.icu/');
  });
});
