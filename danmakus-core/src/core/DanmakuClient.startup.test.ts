import { describe, expect, test } from 'bun:test';
import { DanmakuClient } from './DanmakuClient';

const remoteConfig = {
  maxConnections: 5,
  runtimeUrl: 'https://ukamnads.icu/api/v2/core-runtime',
  autoReconnect: true,
  reconnectInterval: 5000,
  statusCheckInterval: 30,
  cookieCloudKey: null,
  cookieCloudPassword: null,
  cookieCloudHost: null,
  cookieRefreshInterval: 3600,
  streamers: [],
  requestServerRooms: true,
  allowedAreas: [],
  allowedParentAreas: []
};

describe('DanmakuClient startup', () => {
  test('reloads user info and recording list on every start', async () => {
    const client: any = new DanmakuClient({
      clientId: 'client-id',
      accountToken: 'token',
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      maxConnections: 5,
      requestServerRooms: false,
      streamers: []
    });

    const updatedRecordingRooms: number[][] = [];
    const statusManager = {
      start: () => undefined,
      stop: () => undefined,
      updateHoldingRooms: () => undefined,
      updateRecordingRooms: (rooms: number[]) => {
        updatedRecordingRooms.push([...rooms]);
      },
      getAllStatuses: () => [],
      getRoomsToConnect: () => [],
      refreshNow: () => undefined,
      getStreamerStatus: () => undefined,
    };
    const runtimeConnection = {
      connect: async () => true,
      disconnect: async () => undefined,
      getConnectionState: () => true,
      sendMessages: async () => 0,
      requestRooms: async () => null,
      onConnected: undefined,
      onReconnected: undefined,
      onDisconnected: undefined,
      onSessionInvalid: undefined,
    };
    let getUserInfoCallCount = 0;
    let getRecordingListCallCount = 0;

    client.initializeManagers = () => {
      client.statusManager = statusManager;
      client.runtimeConnection = runtimeConnection;
    };
    client.initializeManagers();
    client.acquireRuntimeLock = async () => undefined;
    client.ensureCookieReadyForStartup = async () => undefined;
    client.refreshHoldingRoomsIfNeeded = async () => true;
    client.syncRuntimeState = async () => undefined;
    client.accountClient = {
      getCoreConfig: async () => remoteConfig,
      getCoreConfigTag: () => 'config-tag',
      getUserInfo: async () => {
        getUserInfoCallCount += 1;
        return {
          id: 42,
          name: '测试用户',
          bindedOAuth: [],
          recievedDanmakusCount: 0,
        };
      },
      getRecordingList: async () => {
        getRecordingListCallCount += 1;
        return {
          data: [
            {
              channel: {
                uId: 1001,
                roomId: 2233,
                uName: '测试主播',
                faceUrl: '',
                isLiving: true,
              },
              setting: {
                isPublic: true,
              },
              todayDanmakusCount: 0,
              providedDanmakuDataCount: 0,
              providedMessageCount: 0,
            },
          ],
          tags: {
            recordingTag: 'recording-tag',
            configTag: 'config-tag',
            clientsTag: null,
          },
        };
      },
      releaseRuntimeState: async () => undefined,
    };

    await client.start();

    expect(getUserInfoCallCount).toBe(1);
    expect(getRecordingListCallCount).toBe(1);
    expect(client.recordingRoomIds).toEqual([2233]);
    expect(client.getControlState().userInfo?.id).toBe(42);
    expect(client.getControlState().recordings.map((item: any) => item.channel.roomId)).toEqual([2233]);

    await client.stop();
    expect(client.recordingRoomIds).toEqual([]);

    await client.start();

    expect(getUserInfoCallCount).toBe(2);
    expect(getRecordingListCallCount).toBe(2);
    expect(client.recordingRoomIds).toEqual([2233]);
    expect(updatedRecordingRooms).toContainEqual([2233]);
  });

  test('derives runtime auth headers from account token and client id', async () => {
    const client: any = new DanmakuClient({
      clientId: 'client-id',
      accountToken: 'token',
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      maxConnections: 5,
      streamers: []
    });

    const connected = await client.runtimeConnection.connect();

    expect(connected).toBe(true);
    expect(client.runtimeConnection.getConnectionState()).toBe(true);
  });

  test('fails fast with clear error when no cookie source is available', async () => {
    const requests: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);

      if (url === 'https://ukamnads.icu/api/v2/account/core-config') {
        return new Response(JSON.stringify({ code: 200, data: remoteConfig }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url === 'https://ukamnads.icu/api/v2/account/info') {
        return new Response(JSON.stringify({
          code: 200,
          data: {
            id: 1,
            name: '测试用户',
            bindedOAuth: [],
            recievedDanmakusCount: 0,
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url === 'https://ukamnads.icu/api/v2/account/recording') {
        return new Response(JSON.stringify({ code: 200, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url === 'https://ukamnads.icu/api/v2/core-runtime/sync') {
        return new Response(JSON.stringify({ code: 200, data: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url === 'https://ukamnads.icu/api/v2/core-runtime/state?clientId=client-id') {
        return new Response(JSON.stringify({ code: 200, data: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
    };

    const client = new DanmakuClient({
      clientId: 'client-id',
      accountToken: 'token',
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      fetchImpl,
      maxConnections: 5,
      streamers: []
    });

    await expect(client.start()).rejects.toThrow('未提供可用的 Bilibili Cookie');
    expect(requests).toEqual([
      'GET https://ukamnads.icu/api/v2/account/core-config',
      'GET https://ukamnads.icu/api/v2/account/info',
      'GET https://ukamnads.icu/api/v2/account/recording',
      'POST https://ukamnads.icu/api/v2/core-runtime/sync',
      'DELETE https://ukamnads.icu/api/v2/core-runtime/state?clientId=client-id'
    ]);
  });

  test('falls back to api.danmakus.com for account and runtime api calls when ukamnads is unavailable', async () => {
    const requests: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);

      if (url.startsWith('https://ukamnads.icu/api/')) {
        return new Response('bad gateway', { status: 502 });
      }

      if (url === 'https://api.danmakus.com/api/v2/account/core-config') {
        return new Response(JSON.stringify({ code: 200, data: remoteConfig }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url === 'https://api.danmakus.com/api/v2/account/info') {
        return new Response(JSON.stringify({
          code: 200,
          data: {
            id: 1,
            name: '测试用户',
            bindedOAuth: [],
            recievedDanmakusCount: 0,
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url === 'https://api.danmakus.com/api/v2/account/recording') {
        return new Response(JSON.stringify({ code: 200, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url === 'https://api.danmakus.com/api/v2/core-runtime/sync') {
        return new Response(JSON.stringify({ code: 200, data: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url === 'https://api.danmakus.com/api/v2/core-runtime/state?clientId=client-id') {
        return new Response(JSON.stringify({ code: 200, data: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
    };

    const client = new DanmakuClient({
      clientId: 'client-id',
      accountToken: 'token',
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      fetchImpl,
      maxConnections: 5,
      streamers: []
    });

    await expect(client.start()).rejects.toThrow('未提供可用的 Bilibili Cookie');
    expect(requests).toEqual([
      'GET https://ukamnads.icu/api/v2/account/core-config',
      'GET https://api.danmakus.com/api/v2/account/core-config',
      'GET https://ukamnads.icu/api/v2/account/info',
      'GET https://api.danmakus.com/api/v2/account/info',
      'GET https://ukamnads.icu/api/v2/account/recording',
      'GET https://api.danmakus.com/api/v2/account/recording',
      'POST https://ukamnads.icu/api/v2/core-runtime/sync',
      'POST https://api.danmakus.com/api/v2/core-runtime/sync',
      'DELETE https://ukamnads.icu/api/v2/core-runtime/state?clientId=client-id',
      'DELETE https://api.danmakus.com/api/v2/core-runtime/state?clientId=client-id'
    ]);
  });

  test('resolves live ws auth config from bilibili api when provider is absent', async () => {
    const client: any = new DanmakuClient({
      clientId: 'client-id',
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      maxConnections: 5,
      streamers: [],
      cookieProvider: () => 'DedeUserID=10021741; buvid3=test-buvid;',
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.startsWith('https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket')) {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              ticket: 'ticket',
              created_at: 1,
              ttl: 3600,
              nav: {
                img: 'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz123456.png',
                sub: 'https://i0.hdslb.com/bfs/wbi/uvwxyzabcdefghijklmnopqrstuvwxyz1234.png'
              }
            }
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (url.startsWith('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo')) {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              token: 'test-token',
              host_list: [{ host: 'broadcastlv.chat.bilibili.com', wss_port: 443 }]
            }
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (url === 'https://api.live.bilibili.com/room/v1/Room/room_init?id=6154037') {
          return new Response(JSON.stringify({ code: 0, data: { room_id: 6154037 } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        throw new Error(`unexpected request: ${url}`);
      }
    });

    const options = await client.resolveLiveWsConnectionOptions(6154037);

    expect(options.roomId).toBe(6154037);
    expect(options.key).toBe('test-token');
    expect(options.address).toBe('wss://broadcastlv.chat.bilibili.com/sub');
    expect(options.uid).toBe(10021741);
    expect(options.buvid).toBe('test-buvid');
  });
});
