import { describe, expect, test } from 'bun:test';
import { DanmakuClient } from './DanmakuClient.js';
import { createInMemoryLiveSessionOutbox } from './InMemoryLiveSessionOutbox.js';

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
  test('应用服务端下发地址后，连接打到新服务器而非默认地址', async () => {
    const client: any = new DanmakuClient({
      clientId: 'client-1',
      accountToken: 'token',
      // 客户端默认地址（桌面端 env.ts 注入的就是这个）
      runtimeUrl: 'https://ukamnads.icu/api/v2/core-runtime',
      liveSessionOutbox: createInMemoryLiveSessionOutbox(),
    });

    // 默认连接的目标
    expect(client.runtimeConnection.runtimeBaseUrl).toBe('https://ukamnads.icu/api/v2/core-runtime');
    expect(client.runtimeConnection.wsConnection.options.runtimeUrl).toBe('https://ukamnads.icu/api/v2/core-runtime');

    // 服务端下发不同地址（模拟全局覆盖后的 core-config）
    await client.applyAccountConfigSnapshot(
      buildRemoteConfig('https://client.danmakus.com/api/v2/core-runtime'),
      'config-tag-1',
    );

    // 重建后的连接应指向新地址
    expect(client.configManager.getConfig().runtimeUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
    expect(client.runtimeConnection.runtimeBaseUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
    expect(client.runtimeConnection.wsConnection.options.runtimeUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
  });
});
