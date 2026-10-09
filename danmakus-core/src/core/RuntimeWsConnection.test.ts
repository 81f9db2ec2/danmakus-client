import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  CoreWsOpCode,
  decodeMsgPackPayload,
  decodeWsFrame,
  encodeMsgPackPayload,
  encodeWsFrame,
} from './CoreWebSocketCodec.js';
import { RuntimeWsConnection } from './RuntimeWsConnection.js';
import type { LiveSessionOutboxItem } from '../types/index.js';

describe('RuntimeWsConnection', () => {
  let server: any;
  let port: number;

  beforeEach(() => {
    port = 30000 + Math.floor(Math.random() * 10000);
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
  });

  it('completes auth handshake, uploads archive batch and receives push', async () => {
    let receivedAuth = false;
    let receivedUploadBatch = false;
    let pushReceived = false;
    let authVersion: string | undefined;

    server = Bun.serve({
      port,
      fetch(req, server) {
        if (server.upgrade(req)) {
          return;
        }
        return new Response('Upgrade failed', { status: 500 });
      },
      websocket: {
        message(ws, message) {
          const data = new Uint8Array(message as ArrayBuffer);
          const frame = decodeWsFrame(data);

          if (frame.opCode === CoreWsOpCode.CLIENT_AUTH) {
            receivedAuth = true;
            authVersion = decodeMsgPackPayload<{ version?: string }>(frame.payload).version;
            // 回复 AUTH_RESULT
            const resultPayload = encodeMsgPackPayload({
              success: true,
              serverTime: Date.now(),
            });
            ws.send(encodeWsFrame(CoreWsOpCode.SERVER_AUTH_RESULT, frame.seq, resultPayload));

            // 主动下发一次开播变更 PUSH_STREAMER_STATUS
            const pushPayload = encodeMsgPackPayload({
              updates: [
                {
                  roomId: 123456,
                  isLive: true,
                  title: 'Test Live Stream',
                },
              ],
            });
            ws.send(encodeWsFrame(CoreWsOpCode.SERVER_PUSH_STREAMER_STATUS, 0, pushPayload));
          } else if (frame.opCode === CoreWsOpCode.CLIENT_UPLOAD_DANMAKU) {
            receivedUploadBatch = true;
            // 回复 UPLOAD_ACK
            const ackPayload = encodeMsgPackPayload({
              acceptedCount: 1,
              rejected: [],
            });
            ws.send(encodeWsFrame(CoreWsOpCode.SERVER_UPLOAD_ACK, frame.seq, ackPayload));
          }
        },
      },
    });

    const conn = new RuntimeWsConnection({
      runtimeUrl: `http://127.0.0.1:${port}/api/v2/core-runtime`,
      token: 'test-token',
      clientId: 'client-1',
      version: 'desktop@9.9.9',
      onStreamerStatusPush(updates) {
        if (updates.some((u) => u.roomId === 123456 && u.isLive)) {
          pushReceived = true;
        }
      },
    });

    const ok = await conn.connect();
    expect(ok).toBe(true);
    expect(receivedAuth).toBe(true);
    expect(authVersion).toBe('desktop@9.9.9');

    // 等待 push 接收
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushReceived).toBe(true);

    // 测试发送批次
    const eventTsMs = Date.now();
    const record: LiveSessionOutboxItem = {
      id: 1,
      streamerUid: 84,
      eventTsMs,
      payload: encodeMsgPackPayload({
        streamerUid: 84,
        eventTsMs,
        roomId: 1001,
        danmaku: {
          type: 0,
          sendDate: eventTsMs,
          userName: 'user',
          userId: 1,
          message: 'hi',
          sourceFingerprint: 1n,
        },
      }),
      retryCount: 0,
      nextRetryAtMs: 0,
    };

    const response = await conn.sendArchiveBatch([record]);
    expect(receivedUploadBatch).toBe(true);
    expect(response.rejected).toEqual([]);

    conn.disconnect();
    expect(conn.connected).toBe(false);
  });

  it('automatically reconnects when disconnected unexpectedly', async () => {
    let reconnectedCalled = false;
    let authCount = 0;
    let serverWsRef: any = null;

    server = Bun.serve({
      port,
      fetch(req, server) {
        if (server.upgrade(req)) {
          return;
        }
        return new Response('Upgrade failed', { status: 500 });
      },
      websocket: {
        open(ws) {
          serverWsRef = ws;
        },
        message(ws, message) {
          const data = new Uint8Array(message as ArrayBuffer);
          const frame = decodeWsFrame(data);

          if (frame.opCode === CoreWsOpCode.CLIENT_AUTH) {
            authCount++;
            const resultPayload = encodeMsgPackPayload({
              success: true,
              serverTime: Date.now(),
            });
            ws.send(encodeWsFrame(CoreWsOpCode.SERVER_AUTH_RESULT, frame.seq, resultPayload));
          }
        },
      },
    });

    const conn = new RuntimeWsConnection({
      runtimeUrl: `http://127.0.0.1:${port}/api/v2/core-runtime`,
      token: 'test-token',
      clientId: 'client-1',
      onReconnected() {
        reconnectedCalled = true;
      },
    });

    const ok = await conn.connect();
    expect(ok).toBe(true);
    expect(authCount).toBe(1);

    // 服务端主动关闭连接，模拟网络中断
    if (serverWsRef) {
      serverWsRef.close();
    }

    // 等待重连发生（指数退避约 1000~1500ms）
    const start = Date.now();
    while (!reconnectedCalled && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(reconnectedCalled).toBe(true);
    expect(authCount).toBe(2);
    expect(conn.connected).toBe(true);

    conn.disconnect();
    expect(conn.connected).toBe(false);
  });

  it('keeps retrying after multiple consecutive reconnect failures until server recovers', async () => {
    let allowAuth = true;
    let authCount = 0;
    let reconnectedCalled = false;
    let serverWsRef: any = null;

    server = Bun.serve({
      port,
      fetch(req, server) {
        if (!allowAuth) {
          return new Response('Server temporarily down', { status: 503 });
        }
        if (server.upgrade(req)) {
          return;
        }
        return new Response('Upgrade failed', { status: 500 });
      },
      websocket: {
        open(ws) {
          serverWsRef = ws;
        },
        message(ws, message) {
          const data = new Uint8Array(message as ArrayBuffer);
          const frame = decodeWsFrame(data);

          if (frame.opCode === CoreWsOpCode.CLIENT_AUTH) {
            authCount++;
            const resultPayload = encodeMsgPackPayload({
              success: true,
              serverTime: Date.now(),
            });
            ws.send(encodeWsFrame(CoreWsOpCode.SERVER_AUTH_RESULT, frame.seq, resultPayload));
          }
        },
      },
    });

    const conn = new RuntimeWsConnection({
      runtimeUrl: `http://127.0.0.1:${port}/api/v2/core-runtime`,
      token: 'test-token',
      clientId: 'client-1',
      onReconnected() {
        reconnectedCalled = true;
      },
    });

    const ok = await conn.connect();
    expect(ok).toBe(true);
    expect(authCount).toBe(1);

    // 关闭服务并让后续连接报错
    allowAuth = false;
    if (serverWsRef) {
      serverWsRef.close();
    }

    // 等待 2.5 秒，这期间会经历 1~2 次重连失败
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(conn.connected).toBe(false);

    // 服务恢复
    allowAuth = true;

    // 观察连接自动恢复
    const start = Date.now();
    while (!reconnectedCalled && Date.now() - start < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(reconnectedCalled).toBe(true);
    expect(authCount).toBeGreaterThanOrEqual(2);
    expect(conn.connected).toBe(true);

    conn.disconnect();
    expect(conn.connected).toBe(false);
  });

  it('heartbeat ping attaches state report payload when provider is configured', async () => {
    let receivedStateReports: any[] = [];
    server = Bun.serve({
      port,
      fetch(req, server) {
        if (server.upgrade(req)) {
          return;
        }
        return new Response('Expected upgrade', { status: 400 });
      },
      websocket: {
        message(ws, message) {
          const data = new Uint8Array(message as ArrayBuffer);
          const frame = decodeWsFrame(data);

          if (frame.opCode === CoreWsOpCode.CLIENT_AUTH) {
            const resultPayload = encodeMsgPackPayload({
              success: true,
              serverTime: Date.now(),
            });
            ws.send(encodeWsFrame(CoreWsOpCode.SERVER_AUTH_RESULT, frame.seq, resultPayload));
          } else if (frame.opCode === CoreWsOpCode.CLIENT_STATE_REPORT) {
            if (frame.payload.byteLength > 0) {
              receivedStateReports.push(decodeMsgPackPayload(frame.payload));
            }
          }
        },
      },
    });

    const conn = new RuntimeWsConnection({
      runtimeUrl: `http://127.0.0.1:${port}/api/v2/core-runtime`,
      token: 'test-token',
      clientId: 'client-1',
      getStateReportPayload: () => ({
        holdingRooms: [1280629],
        connectedRooms: [1280629],
        desiredCount: 0,
        capacity: 5,
      }),
    });

    const ok = await conn.connect();
    expect(ok).toBe(true);

    // 触发内部 ping 逻辑
    (conn as any).startPing();
    // 手动调用一次 interval 回调里的逻辑
    const report = (conn as any).options.getStateReportPayload?.();
    expect(report).toBeDefined();
    expect(report.connectedRooms).toEqual([1280629]);
    (conn as any).sendStateReport({ ...report, reason: 'heartbeat-sync' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedStateReports.length).toBeGreaterThan(0);
    expect(receivedStateReports[0].connectedRooms).toEqual([1280629]);
    expect(receivedStateReports[0].reason).toBe('heartbeat-sync');

    conn.disconnect();
  });
});
