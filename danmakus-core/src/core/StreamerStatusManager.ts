import { StreamerStatus } from '../types/index.js';
import { ScopedLogger } from './Logger.js';
import { fetchBackendApiWithFallback } from './BackendApiFallback.js';
import { wrapBilibiliFetch } from './BilibiliUserAgent.js';

const buildStreamerStatusApiUrl = (runtimeUrl: string): string => {
  try {
    const parsed = new URL(runtimeUrl);

    if (parsed.pathname.endsWith('/api/v2/core-runtime')) {
      parsed.pathname = parsed.pathname.replace(/\/api\/v2\/core-runtime$/, '/api/v2/streamer-status');
      parsed.search = '';
      return parsed.toString();
    }

    if (parsed.pathname.endsWith('/api/core-runtime')) {
      parsed.pathname = parsed.pathname.replace(/\/api\/core-runtime$/, '/api/streamer-status');
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
    const normalized = runtimeUrl.trim();
    if (/\/api\/v2\/core-runtime\b/.test(normalized)) {
      return normalized.replace(/\/api\/v2\/core-runtime\b/, '/api/v2/streamer-status');
    }
    if (/\/api\/core-runtime\b/.test(normalized)) {
      return normalized.replace(/\/api\/core-runtime\b/, '/api/streamer-status');
    }
    return normalized;
  }
};

export class StreamerStatusManager {
  private statusCache: Map<number, StreamerStatus> = new Map();
  private checkTimer?: ReturnType<typeof setInterval>;
  private fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private statusApiUrl: string;
  private holdingRooms: number[] = [];
  private recordingRooms: number[] = [];
  private lastManualRefreshAt = 0;

  constructor(
    private checkInterval: number = 30, // 秒
    runtimeUrl: string,
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    private logger: ScopedLogger = new ScopedLogger('StreamerStatusManager')
  ) {
    this.fetch = wrapBilibiliFetch(fetchImpl);
    this.statusApiUrl = buildStreamerStatusApiUrl(runtimeUrl);
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
      this.logger.debug('正在检查主播状态...');

      // 仏服务器获取状态信息
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetchBackendApiWithFallback(this.fetch, this.statusApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ roomIds }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const rawStatuses = await response.json() as StreamerStatus[];
          const statuses = Array.isArray(rawStatuses)
            ? rawStatuses.map(status => ({
              roomId: Number(status.roomId) > 0 ? Math.floor(Number(status.roomId)) : 0,
              uId: typeof status.uId === 'number' && status.uId > 0
                ? Math.floor(status.uId)
                : undefined,
              isLive: Boolean(status.isLive),
              title: status.title,
              username: status.username,
              faceUrl: status.faceUrl,
              viewerCount: typeof status.viewerCount === 'number' ? status.viewerCount : undefined,
              liveStartTime: typeof status.liveStartTime === 'number' ? status.liveStartTime : undefined,
            }))
            : [];
          this.updateStatusCache(statuses);
          this.onStatusUpdated?.(statuses);
          return;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      this.logger.error('检查主播状态失败:', error instanceof Error ? error.message : error);
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
      const cached = this.statusCache.get(roomId);
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
          const response = await this.fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            const result = await response.json();
            if (result && result.code === 0) {
              const data = result.data;
              const status: StreamerStatus = {
                roomId,
                uId: typeof data.uid === 'number' ? data.uid : undefined,
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
        this.logger.warn(`检查房间 ${roomId} 状态失败:`, error instanceof Error ? error.message : error);
      }

      // 外部状态源不可达时，保留缓存状态，避免把“未知”误判为“下播”
      if (cached) {
        statuses.push({ ...cached, roomId });
      }
    }

    // 本轮没有拿到任何可用状态时，保持现有缓存与连接，不触发状态变更广播
    if (statuses.length === 0) {
      this.logger.warn('主播状态检查全部失败，保留上一轮状态');
      return;
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
      const mergedStatus: StreamerStatus = {
        ...cachedStatus,
        ...status,
        uId: status.uId ?? cachedStatus?.uId,
        username: status.username ?? cachedStatus?.username,
        title: status.title ?? cachedStatus?.title,
        faceUrl: status.faceUrl ?? cachedStatus?.faceUrl,
        viewerCount: status.viewerCount ?? cachedStatus?.viewerCount,
        liveStartTime: status.liveStartTime ?? cachedStatus?.liveStartTime
      };

      // 检查是否有状态变化
      if (!cachedStatus || cachedStatus.isLive !== mergedStatus.isLive) {
        if (mergedStatus.isLive && !cachedStatus?.isLive) {
          this.logger.info(`主播 ${mergedStatus.username || mergedStatus.roomId} 开始直播`);
        } else if (!mergedStatus.isLive && cachedStatus?.isLive) {
          this.logger.info(`主播 ${mergedStatus.username || mergedStatus.roomId} 结束直播`);
        }
      }

      this.statusCache.set(status.roomId, mergedStatus);
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
   * 根据直播状态获取应该连接的房间
   */
  getRoomsToConnect(
    recordingRooms: number[],
    holdingRooms: number[],
    maxConnections: number
  ): { roomId: number; priority: 'high' | 'server'; }[] {
    const rooms: { roomId: number; priority: 'high' | 'server'; }[] = [];
    const normalizedRecordingRooms = Array.from(new Set(
      recordingRooms.map(r => Number(r)).filter(r => Number.isFinite(r) && r > 0)
    ));
    const normalizedServerRooms = Array.from(new Set(
      holdingRooms.map(r => Number(r)).filter(r => Number.isFinite(r) && r > 0)
    ));

    for (const roomId of normalizedRecordingRooms) {
      if (rooms.length >= maxConnections) {
        break;
      }
      const status = this.statusCache.get(roomId);
      if (status?.isLive) {
        rooms.push({ roomId, priority: 'high' });
      }
    }

    for (const roomId of normalizedServerRooms) {
      if (rooms.length >= maxConnections) {
        break;
      }
      if (rooms.some(r => r.roomId === roomId)) {
        continue;
      }
      const status = this.statusCache.get(roomId);
      if (status?.isLive) {
        rooms.push({ roomId, priority: 'server' });
      }
    }

    return rooms;
  }

  updateHoldingRooms(rooms: number[]): void {
    const normalized = rooms
      .map(r => Number(r))
      .filter(r => Number.isFinite(r) && r > 0);
    this.holdingRooms = Array.from(new Set(normalized));
  }

  updateRecordingRooms(rooms: number[]): void {
    const normalized = rooms
      .map(r => Number(r))
      .filter(r => Number.isFinite(r) && r > 0);
    this.recordingRooms = Array.from(new Set(normalized));
  }

  private getTrackedRoomIds(): number[] {
    const all = [...this.recordingRooms, ...this.holdingRooms]
      .map(r => Number(r))
      .filter(r => Number.isFinite(r) && r > 0);
    return Array.from(new Set(all));
  }

  // 状态更新回调
  onStatusUpdated?: (statuses: StreamerStatus[]) => void;
}
