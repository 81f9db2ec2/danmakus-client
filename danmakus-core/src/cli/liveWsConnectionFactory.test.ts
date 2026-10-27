import { describe, expect, it } from 'bun:test';
import { createCliLiveWsConnection } from './liveWsConnectionFactory.js';

describe('createCliLiveWsConnection', () => {
  it('throws when address or key is missing', async () => {
    await expect(createCliLiveWsConnection(12345, { address: '', key: 'abc' } as any)).rejects.toThrow('缺少 WS 地址');
    await expect(createCliLiveWsConnection(12345, { address: 'wss://broadcastlv.chat.bilibili.com/sub', key: '' } as any)).rejects.toThrow('缺少 WS 鉴权 key');
  });

  it('creates LiveWS connection over WebSocket (WSS)', async () => {
    const conn = await createCliLiveWsConnection(12345, {
      address: 'wss://broadcastlv.chat.bilibili.com:2245/sub',
      key: 'test_token',
      uid: 1001,
      buvid: 'test_buvid',
      protover: 3,
    });

    expect(conn).toBeDefined();
    expect(typeof (conn as any).addEventListener).toBe('function');
    expect(typeof (conn as any).close).toBe('function');
    try {
      (conn as any).close();
    } catch {
      // ignore
    }
  });
});
