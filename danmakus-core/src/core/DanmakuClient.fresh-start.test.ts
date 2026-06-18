import { afterEach, describe, expect, test } from 'bun:test';
import { DanmakuClient } from './DanmakuClient.js';
import { createInMemoryLiveSessionOutbox } from './InMemoryLiveSessionOutbox.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

describe('DanmakuClient 全新启动应用服务端 runtimeUrl', () => {
  test('start() 后上传打到服务端下发地址（还原新启动 client 场景）', async () => {
    const captured: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ code: 200, data: { rejected: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client: any = new DanmakuClient({
      clientId: 'client-1',
      accountToken: 'token',
      runtimeUrl: 'https://backend.danmakus.com/api/v2/core-runtime',
      liveSessionOutbox: createInMemoryLiveSessionOutbox(),
    });

    // 仅 mock 网络/锁等副作用，保留真实 prepareAccountConfig → applyAccountConfigSnapshot → 连接重建链路
    // 仅 mock 真实 accountClient 的网络方法，保留 setCoreRuntimeBaseUrl 等真实地址跟随逻辑
    Object.assign(client.accountClient, {
      getCoreConfig: async () => buildRemoteConfig('https://client.danmakus.com/api/v2/core-runtime'),
      getCoreConfigTag: () => 'config-tag-1',
      getUserInfo: async () => ({ id: 42, name: 't', bindedOAuth: [], recievedDanmakusCount: 0 }),
      getRecordingList: async () => ({ data: [], tags: { recordingTag: null, configTag: 'config-tag-1', clientsTag: null } }),
      releaseRuntimeState: async () => undefined,
    });
    client.acquireRuntimeLock = async () => undefined;
    client.ensureCookieReadyForStartup = async () => undefined;
    client.refreshHoldingRoomsIfNeeded = async () => true;
    client.syncRuntimeState = async () => undefined;

    await client.start();

    expect(client.configManager.getConfig().runtimeUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
    expect(client.runtimeConnection.runtimeBaseUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
    // 运行态同步/心跳地址也必须跟随，否则 sync 仍打到默认 backend。
    expect(client.accountClient.getCoreRuntimeBaseUrl()).toBe('https://client.danmakus.com/api/v2/core-runtime');

    captured.length = 0;
    await client.runtimeConnection.sendArchiveBatch([{
      id: 1,
      streamerUid: 1001,
      eventTsMs: 1710000001000,
      payload: new Uint8Array([1, 2, 3]),
      retryCount: 0,
      nextRetryAtMs: 1710000001000,
    }]);

    expect(captured[0]).toBe('https://client.danmakus.com/api/v2/core-runtime/upload-danmakus-v5');

    await client.stop();
  });
});
