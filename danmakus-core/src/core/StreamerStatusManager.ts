import { StreamerConfig, StreamerStatus } from '../types';

const STREAMER_PRIORITY_ORDER = ['high', 'normal', 'low'] as const;

const buildStreamerStatusApiUrl = (hubUrl: string): string => {
  try {
    const parsed = new URL(hubUrl);

    if (parsed.pathname.endsWith('/api/v2/user-hub')) {
      parsed.pathname = parsed.pathname.replace(/\/api\/v2\/user-hub$/, '/api/v2/streamer-status');
      parsed.search = '';
      return parsed.toString();
    }

    if (parsed.pathname.endsWith('/danmakuHub')) {
      parsed.pathname = parsed.pathname.replace(/\/danmakuHub$/, '/api/streamer-status');
      parsed.search = '';
      return parsed.toString();
    }

    if (parsed.pathname.includes('/api/v2/')) {
      parsed.pathname = '/api/v2/streamer-status';
      parsed.search = '';
      return parsed.toString();
    }

    parsed.pathname = '/api/streamer-status';
    parsed.search = '';
    return parsed.toString();
  } catch {
    const normalized = hubUrl.trim();
    if (/\/api\/v2\/user-hub\b/.test(normalized)) {
      return normalized.replace(/\/api\/v2\/user-hub\b/, '/api/v2/streamer-status');
    }
    if (/\/danmakuHub\b/.test(normalized)) {
      return normalized.replace(/\/danmakuHub\b/, '/api/streamer-status');
    }
    return normalized;
  }
};

export class StreamerStatusManager {
  private statusCache: Map<number, StreamerStatus> = new Map();
  private checkTimer?: ReturnType<typeof setInterval>;
  private fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private statusApiUrl: string;
  private serverRooms: number[] = [];
  private lastManualRefreshAt = 0;

  constructor(
    private streamers: StreamerConfig[],
    private checkInterval: number = 30, // 秒
    signalrUrl: string,
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  ) {
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.statusApiUrl = buildStreamerStatusApiUrl(signalrUrl);
  }

  /**
   * 启动状态检查
   */
  start(): void {
    this.checkStreamersStatus();
    this.checkTimer = setInterval(() => {
      this.checkStreamersStatus();
    }, this.checkInterval * 1000);
  }

  /**
   * 停止状态检查
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  refreshNow(): void {
    const now = Date.now();
    if (now - this.lastManualRefreshAt < 2000) {
      return;
    }
    this.lastManualRefreshAt = now;
    void this.checkStreamersStatus();
  }

  /**
   * 检查主播状态
   */
  private async checkStreamersStatus(): Promise<void> {
    const roomIds = this.getTrackedRoomIds();
    if (roomIds.length === 0) {
      this.statusCache.clear();
      this.onStatusUpdated?.([]);
      return;
    }

    try {
      console.log('正在检查主播状态...');

      // 仏服务器获取状态信息
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await this.fetch(this.statusApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ roomIds }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const statuses: StreamerStatus[] = await response.json();
          this.updateStatusCache(statuses);
          this.onStatusUpdated?.(statuses);
          return;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      console.error('检查主播状态失败:', error instanceof Error ? error.message : error);
    }

    // 使用备用方法：直接检查 Bilibili API
    await this.fallbackStatusCheck();
  }

  /**
   * 备用状态检查方法：直接调用B站API
   */
  private async fallbackStatusCheck(): Promise<void> {
    const roomIds = this.getTrackedRoomIds();
    const statuses: StreamerStatus[] = [];

    for (const roomId of roomIds) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
          const response = await this.fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            const result = await response.json();
            if (result && result.code === 0) {
              const data = result.data;
              const status: StreamerStatus = {
                roomId,
                isLive: data.live_status === 1,
                title: data.title,
                username: data.uname,
                viewerCount: data.online,
                liveStartTime: data.live_time ? new Date(data.live_time).getTime() : undefined
              };
              statuses.push(status);
              continue;
            }
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        console.warn(`检查房间 ${roomId} 状态失败:`, error instanceof Error ? error.message : error);
      }

      // 创建默认状态
      const status: StreamerStatus = {
        roomId,
        isLive: false
      };
      statuses.push(status);
    }

    this.updateStatusCache(statuses);
    this.onStatusUpdated?.(statuses);
  }

  /**
   * 更新状态缓存
   */
  private updateStatusCache(statuses: StreamerStatus[]): void {
    for (const status of statuses) {
      const cachedStatus = this.statusCache.get(status.roomId);

      // 检查是否有状态变化
      if (!cachedStatus || cachedStatus.isLive !== status.isLive) {
        if (status.isLive && !cachedStatus?.isLive) {
          console.log(`🎬 主播 ${status.username || status.roomId} 开始直播`);
        } else if (!status.isLive && cachedStatus?.isLive) {
          console.log(`📴 主播 ${status.username || status.roomId} 结束直播`);
        }
      }

      this.statusCache.set(status.roomId, status);
    }
  }

  /**
   * 获取正在直播的主播
   */
  getLiveStreamers(): StreamerStatus[] {
    const liveStreamers: StreamerStatus[] = [];

    for (const [_roomId, status] of this.statusCache) {
      if (status.isLive) {
        liveStreamers.push(status);
      }
    }

    // 按开播时间排序（早开播的优先）
    return liveStreamers.sort((a, b) => {
      const timeA = a.liveStartTime || 0;
      const timeB = b.liveStartTime || 0;
      return timeA - timeB;
    });
  }

  /**
   * 获取指定房间的状态
   */
  getStreamerStatus(roomId: number): StreamerStatus | undefined {
    return this.statusCache.get(roomId);
  }

  /**
   * 获取所有状态
   */
  getAllStatuses(): StreamerStatus[] {
    return Array.from(this.statusCache.values());
  }

  /**
   * 根据优先级和直播状态获取应该连接的房间
   */
  getRoomsToConnect(
    streamers: StreamerConfig[],
    serverAssignedRooms: number[],
    maxConnections: number
  ): { roomId: number; priority: 'high' | 'normal' | 'low' | 'server' }[] {
    const rooms: { roomId: number; priority: 'high' | 'normal' | 'low' | 'server' }[] = [];

    // 获取正在直播的主播
    const liveStreamers = this.getLiveStreamers();

    // 按优先级排序：高优先级 > 普通优先级 > 低优先级
    for (const priority of STREAMER_PRIORITY_ORDER) {
      const streamersOfPriority = streamers.filter(s => s.priority === priority);

      for (const streamer of streamersOfPriority) {
        const status = liveStreamers.find(ls => ls.roomId === streamer.roomId);
        if (status && rooms.length < maxConnections) {
          rooms.push({ roomId: streamer.roomId, priority });
        }
      }
    }

    // 如果还有空余连接数，添加服务器分配的房间
    if (rooms.length < maxConnections) {
      for (const roomId of serverAssignedRooms) {
        if (rooms.length >= maxConnections) break;
        if (!rooms.find(r => r.roomId === roomId)) {
          const status = this.statusCache.get(roomId);
          if (status?.isLive) {
            rooms.push({ roomId, priority: 'server' });
          }
        }
      }
    }

    return rooms;
  }

  /**
   * 更新主播配置
   */
  updateStreamers(streamers: StreamerConfig[]): void {
    this.streamers = streamers;
  }

  updateServerRooms(rooms: number[]): void {
    const normalized = rooms
      .map(r => Number(r))
      .filter(r => Number.isFinite(r) && r > 0);
    this.serverRooms = Array.from(new Set(normalized));
  }

  private getTrackedRoomIds(): number[] {
    const streamerIds = this.streamers.map(s => s.roomId);
    const all = [...streamerIds, ...this.serverRooms]
      .map(r => Number(r))
      .filter(r => Number.isFinite(r) && r > 0);
    return Array.from(new Set(all));
  }

  // 状态更新回调
  onStatusUpdated?: (statuses: StreamerStatus[]) => void;
}
