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
    const client: any = new DanmakuClient({
      clientId: 'client-1',
      accountToken: 'token',
      runtimeUrl: 'https://ukamnads.icu/api/v2/core-runtime',
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
    client.ensureCookieReadyForStartup = async () => undefined;
    client.reportHoldingRoomState = () => true;

    // 拦截真实 ws 拨号避免测试超时
    const originalEnsure = client.ensureRuntimeConnection.bind(client);
    client.ensureRuntimeConnection = () => {
      const conn = originalEnsure();
      conn.connect = async () => true;
      return conn;
    };

    await client.start();

    expect(client.configManager.getConfig().runtimeUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
    expect(client.runtimeConnection.runtimeBaseUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
    expect(client.runtimeConnection.wsConnection.options.runtimeUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
    // 运行态同步/心跳地址也必须跟随，否则 sync 仍打到默认 backend。
    expect(client.accountClient.getCoreRuntimeBaseUrl()).toBe('https://client.danmakus.com/api/v2/core-runtime');

    await client.stop();
  });
});
