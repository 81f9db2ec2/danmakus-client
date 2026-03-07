import { DanmakuConfig } from '../types';
import { RuntimeConnection } from './RuntimeConnection';
import { ScopedLogger } from './Logger';
import { StreamerStatusManager } from './StreamerStatusManager';

type RoomPriority = 'high' | 'normal' | 'low' | 'server';

interface ConnectionInfoLike {
  roomId: number;
  priority: RoomPriority;
  connectedAt: number;
}

interface QueuedRoomConnect {
  roomId: number;
  priority: RoomPriority;
}

interface HoldingRoomResult {
  holdingRooms: number[];
  newlyAssignedRooms: number[];
  droppedRooms: number[];
  effectiveCapacity: number;
  nextRequestAfter?: number | null;
}

interface DanmakuHoldingRoomContext {
  isRunning(): boolean;
  isStopping(): boolean;
  getConfig(): DanmakuConfig;
  getRuntimeConnection(): Pick<RuntimeConnection, 'getConnectionState' | 'requestRooms'> | undefined;
  getStatusManager(): StreamerStatusManager | undefined;
  getRecordingRoomIds(): number[];
  getConnections(): Map<number, ConnectionInfoLike>;
  disconnectFromRoom(roomId: number): void;
  connectToRoom(roomId: number, priority: RoomPriority): Promise<void>;
  updateConnections(): void;
  syncRuntimeState(): void;
  refreshStatusNow(): void;
  updateHoldingRooms(roomIds: number[]): void;
  getHoldingRoomIds(): number[];
  setHoldingRoomIds(roomIds: number[]): void;
  getHoldingRoomRequestRefreshing(): boolean;
  setHoldingRoomRequestRefreshing(value: boolean): void;
  getNextHoldingRoomRequestAt(): number;
  setNextHoldingRoomRequestAt(value: number): void;
  getQueuedRoomConnects(): QueuedRoomConnect[];
  setQueuedRoomConnects(value: QueuedRoomConnect[]): void;
  getQueuedRoomIds(): Set<number>;
  getRoomConnectQueueTimer(): ReturnType<typeof setTimeout> | undefined;
  setRoomConnectQueueTimer(value: ReturnType<typeof setTimeout> | undefined): void;
  getLastRoomConnectStartAt(): number;
  setLastRoomConnectStartAt(value: number): void;
  getRoomConnectStartInterval(): number;
  getLastRoomAssigned(): number | undefined;
  setLastRoomAssigned(value: number | undefined): void;
  logger: ScopedLogger;
}

export class DanmakuHoldingRoomCoordinator {
  private readonly context: DanmakuHoldingRoomContext;

  constructor(context: DanmakuHoldingRoomContext) {
    this.context = context;
  }

  applyConnectionsUpdate(): void {
    if (!this.context.isRunning() || this.context.isStopping()) {
      return;
    }

    const config = this.context.getConfig();
    const statusManager = this.ensureStatusManager();
    const runtimeConnected = this.context.getRuntimeConnection()?.getConnectionState() ?? false;

    this.pruneOfflineHoldingRooms(statusManager);
    this.trimHoldingRoomsToCapacity(config.maxConnections);

    const roomsToConnect = statusManager.getRoomsToConnect(
      this.context.getRecordingRoomIds(),
      this.context.getHoldingRoomIds(),
      config.maxConnections
    );
    const currentConnections = Array.from(this.context.getConnections().keys());
    const targetRooms = roomsToConnect.map((room) => room.roomId);

    if (!runtimeConnected) {
      for (const roomId of currentConnections) {
        if (!targetRooms.includes(roomId)) {
          targetRooms.push(roomId);
        }
      }
    }

    for (const queuedRoomId of Array.from(this.context.getQueuedRoomIds())) {
      if (!targetRooms.includes(queuedRoomId)) {
        this.removeQueuedRoomConnect(queuedRoomId);
      }
    }

    for (const roomId of currentConnections) {
      if (!targetRooms.includes(roomId)) {
        this.context.disconnectFromRoom(roomId);
      }
    }

    for (const roomConfig of roomsToConnect) {
      if (!this.context.getConnections().has(roomConfig.roomId)) {
        this.queueRoomConnect(roomConfig.roomId, roomConfig.priority);
      }
    }

    if (runtimeConnected) {
      void this.refreshHoldingRoomsIfNeeded(config.maxConnections);
    }

    this.context.syncRuntimeState();
  }

  pruneOfflineHoldingRooms(statusManager: StreamerStatusManager): void {
    const currentHoldingRoomIds = this.context.getHoldingRoomIds();
    if (currentHoldingRoomIds.length === 0) {
      return;
    }

    const keep: number[] = [];
    const removed: number[] = [];

    for (const roomId of currentHoldingRoomIds) {
      if (!Number.isFinite(roomId) || roomId <= 0) {
        continue;
      }

      const status = statusManager.getStreamerStatus(roomId);
      if (status?.isLive === false) {
        removed.push(roomId);
        continue;
      }

      keep.push(roomId);
    }

    if (removed.length === 0 && this.areRoomIdsEqual(keep, currentHoldingRoomIds)) {
      return;
    }

    this.context.setHoldingRoomIds(keep);
    this.context.updateHoldingRooms(keep);
    for (const roomId of removed) {
      this.removeQueuedRoomConnect(roomId);
      this.context.disconnectFromRoom(roomId);
    }
    if (removed.length > 0) {
      this.context.logger.info(`移除已下播持有房间: ${removed.join(',')}`);
    }
  }

  trimHoldingRoomsToCapacity(maxConnections: number): void {
    const currentHoldingRoomIds = this.context.getHoldingRoomIds();
    const uniqueRooms = Array.from(new Set(
      currentHoldingRoomIds.filter((roomId) => Number.isFinite(roomId) && roomId > 0)
    ));
    const capacity = Math.max(0, Math.min(100, Math.floor(maxConnections)));
    const targetSize = capacity;

    if (uniqueRooms.length <= targetSize) {
      if (!this.areRoomIdsEqual(uniqueRooms, currentHoldingRoomIds)) {
        this.context.setHoldingRoomIds(uniqueRooms);
        this.context.updateHoldingRooms(uniqueRooms);
      }
      return;
    }

    const connectedSet = new Set(this.getConnectedHoldingRoomIds());
    const prioritizedRooms = [
      ...uniqueRooms.filter((roomId) => connectedSet.has(roomId)),
      ...uniqueRooms.filter((roomId) => !connectedSet.has(roomId)),
    ];
    const keep = prioritizedRooms.slice(0, targetSize);
    const dropped = uniqueRooms.filter((roomId) => !keep.includes(roomId));

    this.context.setHoldingRoomIds(keep);
    this.context.updateHoldingRooms(keep);
    for (const roomId of dropped) {
      this.removeQueuedRoomConnect(roomId);
      this.context.disconnectFromRoom(roomId);
    }
    if (dropped.length > 0) {
      this.context.logger.info(`本地持有房间超出剩余槽位，已释放: max=${targetSize}, droppedRooms=${dropped.join(',')}`);
    }
  }

  queueRoomConnect(roomId: number, priority: RoomPriority): void {
    if (!this.context.isRunning() || this.context.isStopping() || roomId <= 0) {
      return;
    }

    if (this.context.getConnections().has(roomId)) {
      return;
    }

    const queuedRoomIds = this.context.getQueuedRoomIds();
    const queuedRoomConnects = this.context.getQueuedRoomConnects();
    if (queuedRoomIds.has(roomId)) {
      const queued = queuedRoomConnects.find(item => item.roomId === roomId);
      if (queued) {
        queued.priority = priority;
      }
      return;
    }

    this.context.setQueuedRoomConnects([...queuedRoomConnects, { roomId, priority }]);
    queuedRoomIds.add(roomId);
    this.scheduleQueuedRoomConnect();
  }

  removeQueuedRoomConnect(roomId: number): void {
    const queuedRoomIds = this.context.getQueuedRoomIds();
    if (!queuedRoomIds.delete(roomId)) {
      return;
    }
    this.context.setQueuedRoomConnects(this.context.getQueuedRoomConnects().filter(item => item.roomId !== roomId));
  }

  clearQueuedRoomConnects(): void {
    const timer = this.context.getRoomConnectQueueTimer();
    if (timer) {
      clearTimeout(timer);
      this.context.setRoomConnectQueueTimer(undefined);
    }
    this.context.setQueuedRoomConnects([]);
    this.context.getQueuedRoomIds().clear();
    this.context.setLastRoomConnectStartAt(0);
  }

  scheduleQueuedRoomConnect(): void {
    if (
      this.context.getRoomConnectQueueTimer()
      || this.context.getQueuedRoomConnects().length === 0
      || !this.context.isRunning()
      || this.context.isStopping()
    ) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.context.getLastRoomConnectStartAt();
    const waitMs = this.context.getLastRoomConnectStartAt() === 0
      ? 0
      : Math.max(0, this.context.getRoomConnectStartInterval() - elapsed);

    this.context.setRoomConnectQueueTimer(setTimeout(() => {
      this.context.setRoomConnectQueueTimer(undefined);
      void this.processQueuedRoomConnect();
    }, waitMs));
  }

  async processQueuedRoomConnect(): Promise<void> {
    if (!this.context.isRunning() || this.context.isStopping()) {
      this.clearQueuedRoomConnects();
      return;
    }

    const queuedRoomConnects = [...this.context.getQueuedRoomConnects()];
    const next = queuedRoomConnects.shift();
    if (!next) {
      return;
    }
    this.context.setQueuedRoomConnects(queuedRoomConnects);
    this.context.getQueuedRoomIds().delete(next.roomId);

    if (!this.context.getConnections().has(next.roomId) && this.isRoomStillDesired(next.roomId)) {
      this.context.setLastRoomConnectStartAt(Date.now());
      await this.context.connectToRoom(next.roomId, next.priority);
    }

    if (this.context.getQueuedRoomConnects().length > 0) {
      this.scheduleQueuedRoomConnect();
    }
  }

  isRoomStillDesired(roomId: number): boolean {
    const statusManager = this.context.getStatusManager();
    if (roomId <= 0 || !statusManager) {
      return false;
    }

    const config = this.context.getConfig();
    const roomsToConnect = statusManager.getRoomsToConnect(
      this.context.getRecordingRoomIds(),
      this.context.getHoldingRoomIds(),
      config.maxConnections
    );
    return roomsToConnect.some(item => item.roomId === roomId);
  }

  clearHoldingRooms(): void {
    const currentHoldingRoomIds = this.context.getHoldingRoomIds();
    if (currentHoldingRoomIds.length === 0) {
      return;
    }

    const removedRooms = [...currentHoldingRoomIds];
    this.context.setHoldingRoomIds([]);
    for (const roomId of removedRooms) {
      this.removeQueuedRoomConnect(roomId);
      this.context.disconnectFromRoom(roomId);
    }

    this.context.updateHoldingRooms([]);
    this.context.refreshStatusNow();
    this.context.updateConnections();
    this.context.syncRuntimeState();
  }

  getConnectedHoldingRoomIds(): number[] {
    return Array.from(this.context.getConnections().values())
      .filter((connection) => connection.priority === 'server')
      .map((connection) => connection.roomId)
      .filter((roomId) => Number.isFinite(roomId) && roomId > 0);
  }

  async refreshHoldingRoomsIfNeeded(
    maxConnections: number,
    reason: string = 'capacity-refresh',
    options?: { force?: boolean }
  ): Promise<boolean> {
    const runtimeConnection = this.context.getRuntimeConnection();
    if (!runtimeConnection?.getConnectionState()) {
      return false;
    }
    if (!this.isHoldingRoomRequestEnabled()) {
      this.clearHoldingRooms();
      return false;
    }
    if (
      this.context.getHoldingRoomRequestRefreshing()
      || (!options?.force && Date.now() < this.context.getNextHoldingRoomRequestAt())
    ) {
      return false;
    }

    const config = this.context.getConfig();
    const overrideValue = Number(config.capacityOverride);
    const capacityOverride = Number.isFinite(overrideValue) && overrideValue > 0
      ? Math.min(100, Math.floor(overrideValue))
      : undefined;
    const capacity = Math.max(0, Math.min(Math.floor(maxConnections), capacityOverride ?? Math.floor(maxConnections), 100));
    const desiredCount = Math.max(0, capacity - this.context.getHoldingRoomIds().length);
    if (desiredCount <= 0 && !options?.force) {
      return false;
    }

    this.context.setHoldingRoomRequestRefreshing(true);
    try {
      const result = await runtimeConnection.requestRooms({
        reason,
        holdingRooms: [...this.context.getHoldingRoomIds()],
        connectedRooms: this.getConnectedHoldingRoomIds(),
        desiredCount,
        capacityOverride,
      });
      if (!result) {
        return false;
      }
      this.applyHoldingRoomResult(result);
      return true;
    } finally {
      this.context.setHoldingRoomRequestRefreshing(false);
    }
  }

  applyHoldingRoomResult(result: HoldingRoomResult): void {
    const previous = Array.from(new Set(this.context.getHoldingRoomIds().filter((roomId) => Number.isFinite(roomId) && roomId > 0)));
    const next = Array.from(new Set(result.holdingRooms.filter((roomId) => Number.isFinite(roomId) && roomId > 0)));
    const removedRooms = previous.filter((roomId) => !next.includes(roomId));
    const addedRooms = next.filter((roomId) => !previous.includes(roomId));

    this.context.setHoldingRoomIds(next);
    this.context.setNextHoldingRoomRequestAt(
      typeof result.nextRequestAfter === 'number' && result.nextRequestAfter > 0
        ? result.nextRequestAfter
        : 0
    );

    const lastAssignedRoom = addedRooms.length > 0
      ? addedRooms[addedRooms.length - 1]
      : (result.newlyAssignedRooms.length > 0 ? result.newlyAssignedRooms[result.newlyAssignedRooms.length - 1] : undefined);
    if (typeof lastAssignedRoom === 'number' && lastAssignedRoom > 0) {
      this.context.setLastRoomAssigned(lastAssignedRoom);
    }

    for (const roomId of removedRooms) {
      this.removeQueuedRoomConnect(roomId);
      this.context.disconnectFromRoom(roomId);
    }

    this.context.updateHoldingRooms(next);
    this.context.refreshStatusNow();
    this.context.updateConnections();
    this.context.syncRuntimeState();
  }

  private isHoldingRoomRequestEnabled(config: DanmakuConfig = this.context.getConfig()): boolean {
    return (config.requestServerRooms ?? true) && Math.max(0, Math.floor(config.maxConnections)) > 0;
  }

  private ensureStatusManager(): StreamerStatusManager {
    const statusManager = this.context.getStatusManager();
    if (!statusManager) {
      throw new Error('状态管理器尚未初始化');
    }
    return statusManager;
  }

  private areRoomIdsEqual(left: number[], right: number[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((roomId, index) => roomId === right[index]);
  }
}
