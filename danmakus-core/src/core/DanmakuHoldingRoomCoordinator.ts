import { DanmakuConfig, RuntimeRoomPullShortfallDto } from '../types/index.js';
import { RuntimeConnection } from './RuntimeConnection.js';
import { ScopedLogger } from './Logger.js';
import { StreamerStatusManager } from './StreamerStatusManager.js';

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
  shortfall?: RuntimeRoomPullShortfallDto | null;
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
  getHoldingRoomIds?(): number[];
  setHoldingRoomIds?(roomIds: number[]): void;
  getLastRoomAssigned?(): number | undefined;
  setLastRoomAssigned?(value: number | undefined): void;
  getHoldingRoomShortfall?(): RuntimeRoomPullShortfallDto | null;
  setHoldingRoomShortfall?(value: RuntimeRoomPullShortfallDto | null): void;
  getRoomConnectStartInterval(): number;
  notifyStatusChanged(): void;
  logger: ScopedLogger;
}

const STALE_HOLDING_ROOM_RELEASE_MS = 5 * 60 * 1000;

export class DanmakuHoldingRoomCoordinator {
  private readonly context: DanmakuHoldingRoomContext;
  private holdingRoomIds: number[] = [];
  private holdingRoomRequestRefreshing = false;
  private nextHoldingRoomRequestAt = 0;
  private readonly pendingAssignedRoomIds = new Set<number>();
  private queuedRoomConnects: QueuedRoomConnect[] = [];
  private queuedRoomIds: Set<number> = new Set();
  private roomConnectQueueTimer?: ReturnType<typeof setTimeout>;
  private lastRoomConnectStartAt = 0;
  private lastRoomAssigned?: number;
  private holdingRoomShortfall: RuntimeRoomPullShortfallDto | null = null;
  private readonly holdingRoomDisconnectedAt = new Map<number, number>();

  constructor(context: DanmakuHoldingRoomContext) {
    this.context = context;
    this.holdingRoomIds = context.getHoldingRoomIds ? [...context.getHoldingRoomIds()] : [];
    this.lastRoomAssigned = context.getLastRoomAssigned?.();
    this.holdingRoomShortfall = this.cloneHoldingRoomShortfall(context.getHoldingRoomShortfall?.());
    this.refreshHoldingRoomDisconnectState(Date.now());
  }

  getHoldingRoomIds(): number[] {
    return [...this.holdingRoomIds];
  }

  replaceHoldingRoomIds(roomIds: number[]): void {
    this.setHoldingRoomIds([...roomIds]);
  }

  getLastRoomAssigned(): number | undefined {
    return this.lastRoomAssigned;
  }

  getHoldingRoomShortfall(): RuntimeRoomPullShortfallDto | null {
    return this.cloneHoldingRoomShortfall(this.holdingRoomShortfall);
  }

  getNextHoldingRoomRequestAt(): number {
    return this.nextHoldingRoomRequestAt;
  }

  setNextHoldingRoomRequestAt(value: number): void {
    this.nextHoldingRoomRequestAt = value;
  }

  resetState(): void {
    this.clearQueuedRoomConnects();
    this.setHoldingRoomIds([]);
    this.pendingAssignedRoomIds.clear();
    this.holdingRoomRequestRefreshing = false;
    this.nextHoldingRoomRequestAt = 0;
    this.setLastRoomAssigned(undefined);
    this.setHoldingRoomShortfall(null);
    this.holdingRoomDisconnectedAt.clear();
  }

  removeHoldingRoom(roomId: number): boolean {
    const nextHoldingRoomIds = this.holdingRoomIds.filter(id => id !== roomId);
    if (nextHoldingRoomIds.length === this.holdingRoomIds.length) {
      return false;
    }

    this.setHoldingRoomIds(nextHoldingRoomIds);
    this.pendingAssignedRoomIds.delete(roomId);
    this.context.updateHoldingRooms(nextHoldingRoomIds);
    return true;
  }

  applyConnectionsUpdate(): void {
    if (!this.context.isRunning() || this.context.isStopping()) {
      return;
    }

    const previousHoldingRooms = [...this.holdingRoomIds];
    const now = Date.now();
    const config = this.context.getConfig();
    const statusManager = this.ensureStatusManager();
    const runtimeConnected = this.context.getRuntimeConnection()?.getConnectionState() ?? false;

    this.pruneOfflineHoldingRooms(statusManager);
    this.refreshHoldingRoomDisconnectState(now);
    this.releaseStaleDisconnectedHoldingRooms(now);
    this.trimHoldingRoomsToCapacity(config.maxConnections);

    const roomsToConnect = this.resolveRoomsToConnect(statusManager, config);
    const currentConnections = Array.from(this.context.getConnections().keys());
    const targetRooms = roomsToConnect.map(room => room.roomId);

    if (!runtimeConnected) {
      for (const roomId of currentConnections) {
        if (!targetRooms.includes(roomId)) {
          targetRooms.push(roomId);
        }
      }
    }

    for (const queuedRoomId of Array.from(this.queuedRoomIds)) {
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

    if (!this.areRoomIdsEqual(previousHoldingRooms, this.holdingRoomIds)) {
      this.context.syncRuntimeState();
    }
  }

  pruneOfflineHoldingRooms(statusManager: StreamerStatusManager): void {
    if (this.holdingRoomIds.length === 0) {
      return;
    }

    const keep: number[] = [];
    const removed: number[] = [];

    for (const roomId of this.holdingRoomIds) {
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

    if (removed.length === 0 && this.areRoomIdsEqual(keep, this.holdingRoomIds)) {
      return;
    }

    this.setHoldingRoomIds(keep);
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
    const uniqueRooms = Array.from(new Set(
      this.holdingRoomIds.filter(roomId => Number.isFinite(roomId) && roomId > 0)
    ));
    const capacity = Math.max(0, Math.min(100, Math.floor(maxConnections)));
    const targetSize = capacity;

    if (uniqueRooms.length <= targetSize) {
      if (!this.areRoomIdsEqual(uniqueRooms, this.holdingRoomIds)) {
        this.setHoldingRoomIds(uniqueRooms);
        this.context.updateHoldingRooms(uniqueRooms);
      }
      return;
    }

    const connectedSet = new Set(this.getConnectedHoldingRoomIds());
    const prioritizedRooms = [
      ...uniqueRooms.filter(roomId => connectedSet.has(roomId)),
      ...uniqueRooms.filter(roomId => !connectedSet.has(roomId)),
    ];
    const keep = prioritizedRooms.slice(0, targetSize);
    const dropped = uniqueRooms.filter(roomId => !keep.includes(roomId));

    this.setHoldingRoomIds(keep);
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

    if (this.queuedRoomIds.has(roomId)) {
      const queued = this.queuedRoomConnects.find(item => item.roomId === roomId);
      if (queued) {
        queued.priority = priority;
      }
      return;
    }

    this.queuedRoomConnects = [...this.queuedRoomConnects, { roomId, priority }];
    this.queuedRoomIds.add(roomId);
    this.scheduleQueuedRoomConnect();
  }

  removeQueuedRoomConnect(roomId: number): void {
    if (!this.queuedRoomIds.delete(roomId)) {
      return;
    }
    this.queuedRoomConnects = this.queuedRoomConnects.filter(item => item.roomId !== roomId);
  }

  clearQueuedRoomConnects(): void {
    if (this.roomConnectQueueTimer) {
      clearTimeout(this.roomConnectQueueTimer);
      this.roomConnectQueueTimer = undefined;
    }
    this.queuedRoomConnects = [];
    this.queuedRoomIds.clear();
    this.lastRoomConnectStartAt = 0;
  }

  scheduleQueuedRoomConnect(): void {
    if (
      this.roomConnectQueueTimer
      || this.queuedRoomConnects.length === 0
      || !this.context.isRunning()
      || this.context.isStopping()
    ) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastRoomConnectStartAt;
    const waitMs = this.lastRoomConnectStartAt === 0
      ? 0
      : Math.max(0, this.context.getRoomConnectStartInterval() - elapsed);

    this.roomConnectQueueTimer = setTimeout(() => {
      this.roomConnectQueueTimer = undefined;
      void this.processQueuedRoomConnect();
    }, waitMs);
  }

  async processQueuedRoomConnect(): Promise<void> {
    if (!this.context.isRunning() || this.context.isStopping()) {
      this.clearQueuedRoomConnects();
      return;
    }

    const next = this.queuedRoomConnects.shift();
    if (!next) {
      return;
    }
    this.queuedRoomIds.delete(next.roomId);

    if (!this.context.getConnections().has(next.roomId) && this.isRoomStillDesired(next.roomId)) {
      this.lastRoomConnectStartAt = Date.now();
      await this.context.connectToRoom(next.roomId, next.priority);
    }

    if (this.queuedRoomConnects.length > 0) {
      this.scheduleQueuedRoomConnect();
    }
  }

  isRoomStillDesired(roomId: number): boolean {
    const statusManager = this.context.getStatusManager();
    if (roomId <= 0 || !statusManager) {
      return false;
    }

    const config = this.context.getConfig();
    const roomsToConnect = this.resolveRoomsToConnect(statusManager, config);
    return roomsToConnect.some(item => item.roomId === roomId);
  }

  private resolveRoomsToConnect(
    statusManager: StreamerStatusManager,
    config: DanmakuConfig
  ): { roomId: number; priority: 'high' | 'server' }[] {
    const recordingRooms = this.context.getRecordingRoomIds().filter(roomId => this.holdingRoomIds.includes(roomId));

    return statusManager.getRoomsToConnect(
      recordingRooms,
      this.holdingRoomIds,
      config.maxConnections
    );
  }

  clearHoldingRooms(): void {
    const previousShortfall = this.holdingRoomShortfall;
    if (this.holdingRoomIds.length === 0 && previousShortfall === null) {
      return;
    }

    this.setHoldingRoomShortfall(null);
    if (this.holdingRoomIds.length === 0) {
      this.context.notifyStatusChanged();
      this.context.syncRuntimeState();
      return;
    }

    const removedRooms = [...this.holdingRoomIds];
    this.setHoldingRoomIds([]);
    for (const roomId of removedRooms) {
      this.removeQueuedRoomConnect(roomId);
      this.context.disconnectFromRoom(roomId);
    }

    this.context.updateHoldingRooms([]);
    this.context.refreshStatusNow();
    this.context.updateConnections();
    this.context.notifyStatusChanged();
    this.context.syncRuntimeState();
  }

  getConnectedHoldingRoomIds(): number[] {
    const holdingRoomSet = new Set(this.holdingRoomIds);
    return Array.from(this.context.getConnections().values())
      .filter(connection => holdingRoomSet.has(connection.roomId))
      .map(connection => connection.roomId)
      .filter(roomId => Number.isFinite(roomId) && roomId > 0);
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
    if (!this.isServerAssignmentRequestEnabled()) {
      this.clearHoldingRooms();
      return false;
    }
    if (
      this.holdingRoomRequestRefreshing
      || (!options?.force && Date.now() < this.nextHoldingRoomRequestAt)
    ) {
      return false;
    }
    if (this.hasPendingRoomConnections()) {
      return false;
    }

    const config = this.context.getConfig();
    const overrideValue = Number(config.capacityOverride);
    const capacityOverride = Number.isFinite(overrideValue) && overrideValue > 0
      ? Math.min(100, Math.floor(overrideValue))
      : undefined;
    const capacity = Math.max(0, Math.min(Math.floor(maxConnections), capacityOverride ?? Math.floor(maxConnections), 100));
    const desiredCount = Math.max(0, capacity - this.holdingRoomIds.length);
    if (desiredCount <= 0 && !options?.force) {
      if (this.holdingRoomShortfall !== null) {
        this.setHoldingRoomShortfall(null);
        this.context.notifyStatusChanged();
        this.context.syncRuntimeState();
      }
      return false;
    }

    this.holdingRoomRequestRefreshing = true;
    try {
      const result = await runtimeConnection.requestRooms({
        reason,
        holdingRooms: [...this.holdingRoomIds],
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
      this.holdingRoomRequestRefreshing = false;
    }
  }

  applyHoldingRoomResult(result: HoldingRoomResult): void {
    const previous = Array.from(new Set(this.holdingRoomIds.filter(roomId => Number.isFinite(roomId) && roomId > 0)));
    const next = Array.from(new Set(result.holdingRooms.filter(roomId => Number.isFinite(roomId) && roomId > 0)));
    const previousShortfall = this.holdingRoomShortfall;
    const nextShortfall = this.cloneHoldingRoomShortfall(result.shortfall);
    const removedRooms = previous.filter(roomId => !next.includes(roomId));
    const addedRooms = next.filter(roomId => !previous.includes(roomId));
    const holdingRoomsChanged = !this.areRoomIdsEqual(previous, next);
    const shortfallChanged = !this.areHoldingRoomShortfallsEqual(previousShortfall, nextShortfall);
    const zombieConnectedRooms = Array.from(this.context.getConnections().keys())
      .filter(roomId => Number.isFinite(roomId) && roomId > 0 && !next.includes(roomId));
    const roomsToDisconnect = Array.from(new Set([...removedRooms, ...zombieConnectedRooms]));

    this.setHoldingRoomIds(next);
    this.setHoldingRoomShortfall(nextShortfall);
    for (const roomId of addedRooms) {
      if (!this.context.getConnections().has(roomId)) {
        this.pendingAssignedRoomIds.add(roomId);
      }
    }
    this.nextHoldingRoomRequestAt = typeof result.nextRequestAfter === 'number' && result.nextRequestAfter > 0
      ? result.nextRequestAfter
      : 0;

    const lastAssignedRoom = addedRooms.length > 0
      ? addedRooms[addedRooms.length - 1]
      : (result.newlyAssignedRooms.length > 0 ? result.newlyAssignedRooms[result.newlyAssignedRooms.length - 1] : undefined);
    if (typeof lastAssignedRoom === 'number' && lastAssignedRoom > 0) {
      this.setLastRoomAssigned(lastAssignedRoom);
    }

    if (!holdingRoomsChanged && roomsToDisconnect.length === 0) {
      if (shortfallChanged) {
        this.context.notifyStatusChanged();
        this.context.syncRuntimeState();
      }
      return;
    }

    for (const roomId of roomsToDisconnect) {
      this.removeQueuedRoomConnect(roomId);
      this.context.disconnectFromRoom(roomId);
    }

    this.context.updateHoldingRooms(next);
    this.context.refreshStatusNow();
    this.context.updateConnections();
    this.context.notifyStatusChanged();
    if (holdingRoomsChanged || shortfallChanged) {
      this.context.syncRuntimeState();
    }
  }

  private isServerAssignmentRequestEnabled(config: DanmakuConfig = this.context.getConfig()): boolean {
    return Math.max(0, Math.floor(config.maxConnections)) > 0;
  }

  private cloneHoldingRoomShortfall(shortfall: RuntimeRoomPullShortfallDto | null | undefined): RuntimeRoomPullShortfallDto | null {
    return shortfall
      ? {
          reason: shortfall.reason ?? null,
          missingCount: shortfall.missingCount ?? null,
          candidateCount: shortfall.candidateCount ?? null,
          assignableCandidateCount: shortfall.assignableCandidateCount ?? null,
          blockedBySameAccountCount: shortfall.blockedBySameAccountCount ?? null,
          blockedByOtherAccountsCount: shortfall.blockedByOtherAccountsCount ?? null,
        }
      : null;
  }

  private setHoldingRoomIds(roomIds: number[]): void {
    this.holdingRoomIds = roomIds;
    const roomIdSet = new Set(roomIds);
    for (const trackedRoomId of Array.from(this.holdingRoomDisconnectedAt.keys())) {
      if (!roomIdSet.has(trackedRoomId)) {
        this.holdingRoomDisconnectedAt.delete(trackedRoomId);
      }
    }
    this.prunePendingAssignedRooms(roomIdSet);
    this.context.setHoldingRoomIds?.([...roomIds]);
  }

  private hasPendingRoomConnections(): boolean {
    this.prunePendingAssignedRooms();
    return this.queuedRoomIds.size > 0 || this.pendingAssignedRoomIds.size > 0;
  }

  private prunePendingAssignedRooms(roomIdSet: Set<number> = new Set(this.holdingRoomIds)): void {
    for (const roomId of Array.from(this.pendingAssignedRoomIds)) {
      if (!roomIdSet.has(roomId) || this.context.getConnections().has(roomId)) {
        this.pendingAssignedRoomIds.delete(roomId);
      }
    }
  }

  private setLastRoomAssigned(value: number | undefined): void {
    this.lastRoomAssigned = value;
    this.context.setLastRoomAssigned?.(value);
  }

  private setHoldingRoomShortfall(value: RuntimeRoomPullShortfallDto | null): void {
    const nextValue = this.cloneHoldingRoomShortfall(value);
    this.holdingRoomShortfall = nextValue;
    this.context.setHoldingRoomShortfall?.(nextValue);
  }

  private areHoldingRoomShortfallsEqual(
    left: RuntimeRoomPullShortfallDto | null | undefined,
    right: RuntimeRoomPullShortfallDto | null | undefined
  ): boolean {
    const lhs = left ?? null;
    const rhs = right ?? null;
    return (lhs?.reason ?? null) === (rhs?.reason ?? null)
      && (lhs?.missingCount ?? null) === (rhs?.missingCount ?? null)
      && (lhs?.candidateCount ?? null) === (rhs?.candidateCount ?? null)
      && (lhs?.assignableCandidateCount ?? null) === (rhs?.assignableCandidateCount ?? null)
      && (lhs?.blockedBySameAccountCount ?? null) === (rhs?.blockedBySameAccountCount ?? null)
      && (lhs?.blockedByOtherAccountsCount ?? null) === (rhs?.blockedByOtherAccountsCount ?? null);
  }

  private refreshHoldingRoomDisconnectState(now: number): void {
    const connectedHoldingRoomIds = new Set(this.getConnectedHoldingRoomIds());

    for (const roomId of this.holdingRoomIds) {
      if (connectedHoldingRoomIds.has(roomId)) {
        this.holdingRoomDisconnectedAt.delete(roomId);
        continue;
      }

      if (!this.holdingRoomDisconnectedAt.has(roomId)) {
        this.holdingRoomDisconnectedAt.set(roomId, now);
      }
    }
  }

  private releaseStaleDisconnectedHoldingRooms(now: number): void {
    if (this.holdingRoomIds.length === 0) {
      return;
    }

    const staleRoomIds = this.holdingRoomIds.filter((roomId) => {
      if (this.context.getConnections().has(roomId) || this.queuedRoomIds.has(roomId)) {
        return false;
      }

      const disconnectedAt = this.holdingRoomDisconnectedAt.get(roomId);
      return typeof disconnectedAt === 'number' && now - disconnectedAt >= STALE_HOLDING_ROOM_RELEASE_MS;
    });
    if (staleRoomIds.length === 0) {
      return;
    }

    const staleRoomIdSet = new Set(staleRoomIds);
    const nextHoldingRoomIds = this.holdingRoomIds.filter(roomId => !staleRoomIdSet.has(roomId));
    this.setHoldingRoomIds(nextHoldingRoomIds);
    this.context.updateHoldingRooms(nextHoldingRoomIds);
    this.context.logger.info(`释放长时间未连上的持有房间: ${staleRoomIds.join(',')}`);
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
