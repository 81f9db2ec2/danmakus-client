import type { LiveWsConnection, LiveWsRoomConfig } from '../types/index.js';
import { createWireRawLiveWsConnection } from '../core/WireRawLiveWsConnection.js';

const DEFAULT_BILIBILI_LIVE_TCP_PORT = 2243;

function resolveTcpHost(address: string): string {
  const parsed = new URL(address);
  if (!parsed.hostname) {
    throw new Error(`无法从地址解析 TCP host: ${address}`);
  }
  return parsed.hostname;
}

export async function createCliLiveWsConnection(
  roomId: number,
  options: LiveWsRoomConfig
): Promise<LiveWsConnection> {
  if (!options.address) {
    throw new Error(`房间 ${roomId} 缺少 WS 地址`);
  }
  if (!options.key) {
    throw new Error(`房间 ${roomId} 缺少 WS 鉴权 key`);
  }

  const { LiveTCP } = await import('@laplace.live/ws/server');
  return createWireRawLiveWsConnection(new LiveTCP(roomId, {
    host: resolveTcpHost(options.address),
    port: options.tcpPort ?? DEFAULT_BILIBILI_LIVE_TCP_PORT,
    key: options.key,
    uid: options.uid,
    buvid: options.buvid,
    protover: options.protover ?? 3,
  }));
}
