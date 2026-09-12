import { afterEach, describe, expect, test } from 'bun:test';
import { DanmakuClient } from './DanmakuClient.js';
import { createInMemoryLiveSessionOutbox } from './InMemoryLiveSessionOutbox.js';

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

const buildRemoteConfig = (runtimeUrl: string) => ({
  maxConnections: 5,
  runtimeUrl,
  autoReconnect: true,
  reconnectInterval: 5000,
  statusCheckInterval: 30,
  streamers: [],
  requestServerRooms: false,
  allowedAreas: [],
  allowedParentAreas: [],
});

describe('DanmakuClient 服务端下发 runtimeUrl', () => {
  test('应用服务端下发地址后，上传打到新服务器而非默认地址', async () => {
    const client: any = new DanmakuClient({
      clientId: 'client-1',
      accountToken: 'token',
      // 客户端默认地址（桌面端 env.ts 注入的就是这个）
      runtimeUrl: 'https://ukamnads.icu/api/v2/core-runtime',
      liveSessionOutbox: createInMemoryLiveSessionOutbox(),
    });

    // 默认连接的上传目标
    expect(client.runtimeConnection.runtimeBaseUrl).toBe('https://ukamnads.icu/api/v2/core-runtime');

    // 服务端下发不同地址（模拟全局覆盖后的 core-config）
    await client.applyAccountConfigSnapshot(
      buildRemoteConfig('https://client.danmakus.com/api/v2/core-runtime'),
      'config-tag-1',
    );

    // 重建后的连接应指向新地址
    expect(client.configManager.getConfig().runtimeUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
    expect(client.runtimeConnection.runtimeBaseUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');

    // 实际发一次归档上传，断言请求 URL
    const captured: string[] = [];
    stubFetch(captured);
    await client.runtimeConnection.sendArchiveBatch([{
      id: 1,
      streamerUid: 1001,
      eventTsMs: 1710000001000,
      payload: new Uint8Array([1, 2, 3]),
      retryCount: 0,
      nextRetryAtMs: 1710000001000,
    }]);

    expect(captured[0]).toBe('https://client.danmakus.com/api/v2/core-runtime/upload-danmakus-v5');
  });
});
