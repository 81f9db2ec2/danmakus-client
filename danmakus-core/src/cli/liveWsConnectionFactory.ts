import type { LiveWsConnection, LiveWsRoomConfig } from '../types/index.js';

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

  // 统一使用 WebSocket (WSS) 协议，完全对齐真实 Web 浏览器直播间的连接方式，杜绝裸 TCP 特征
  const { LiveWS } = await import('@laplace.live/ws/client');
  return new LiveWS(roomId, {
    address: options.address,
    key: options.key,
    uid: options.uid,
    buvid: options.buvid,
    protover: options.protover ?? 3,
  }) as LiveWsConnection;
}
