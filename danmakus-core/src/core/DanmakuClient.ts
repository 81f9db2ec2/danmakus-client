import EventEmitter from 'eventemitter3';
import { LiveWS } from 'bilibili-live-danmaku';
import { ConfigManager } from './ConfigManager';
import { CookieManager } from './CookieManager';
import { SignalRConnection } from './SignalRConnection';
import { StreamerStatusManager } from './StreamerStatusManager';
import { AccountApiClient } from './AccountApiClient';
import {
  DanmakuMessage,
  DanmakuClientEvents,
  DanmakuConfig,
  CliOptions,
  LiveWsConnection,
  LiveWsRoomConfig,
  StreamerStatus,
  CoreRuntimeStateDto,
  CoreConnectionInfoDto,
  ErrorCategory,
  ClientErrorRecord
} from '../types';
import { ScopedLogger, normalizeLogLevel } from './Logger';

const HEARTBEAT_MIN_INTERVAL = 2000;
const MESSAGE_QUEUE_MIN_SIZE = 100;
const MESSAGE_RETRY_MIN_DELAY = 200;
const MESSAGE_RETRY_MIN_ATTEMPTS = 1;
const MESSAGE_BATCH_MIN_SIZE = 1;
const MESSAGE_BATCH_MAX_SIZE = 200;
const LOCK_RETRY_MIN_COUNT = 1;
const LOCK_RETRY_MIN_DELAY = 200;
const ERROR_HISTORY_MIN_LIMIT = 10;
const ROOM_CONNECT_START_INTERVAL = 10_000;
const QUEUE_OVERFLOW_LOG_INTERVAL_MS = 10_000;
const SERVER_ROOM_OFFLINE_EVICT_HITS = 1;
const SERVER_ROOM_ASSIGN_GRACE_MS = 60_000;

function generateClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(16).slice(2);
  return `client-${Date.now().toString(36)}-${random}`;
}

interface ConnectionInfo {
  connection: LiveWsConnection;
  roomId: number;
  priority: 'high' | 'normal' | 'low' | 'server';
  connectedAt: number;
}

interface QueuedMessage {
  message: DanmakuMessage;
  retryCount: number;
  nextRetryAt: number;
}

interface QueuedRoomConnect {
  roomId: number;
  priority: 'high' | 'normal' | 'low' | 'server';
}

interface ClientErrorContext {
  category?: ErrorCategory;
  code?: string;
  recoverable?: boolean;
  roomId?: number;
}

type CookieSource = 'biliLocal' | 'cookieCloud';
type LiveWsConnectionOptions = {
  roomId?: number;
  address?: string;
  key?: string;
  uid?: number;
  buvid?: string;
  protover?: 1 | 2 | 3;
};

export class DanmakuClient extends EventEmitter {
  private logger: ScopedLogger;
  private configManager: ConfigManager;
  private cookieManager?: CookieManager;
  private cookieProvider?: () => string | null | undefined;
  private liveWsConfigProvider?: (roomId: number) => Promise<LiveWsRoomConfig | null | undefined>;
  private liveWsConnectionFactory?: (roomId: number, options: LiveWsRoomConfig) => Promise<LiveWsConnection>;
  private signalrConnection?: SignalRConnection;
  private statusManager?: StreamerStatusManager;
  private accountClient?: AccountApiClient;
  private clientId: string;
  private connections: Map<number, ConnectionInfo> = new Map();
  private serverAssignedRooms: number[] = [];
  private serverRoomOfflineHits: Map<number, number> = new Map();
  private serverRoomAssignedAt: Map<number, number> = new Map();
  private serverRoomLiveConfirmed: Set<number> = new Set();
  private lastServerRoomRequestAt = 0;
  private isRunning: boolean = false;
  private updateConnectionsTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private accountConfigRefreshTimer?: ReturnType<typeof setInterval>;
  private accountConfigRefreshing = false;
  private isStopping = false;
  private messageCount = 0;
  private lastRoomAssigned?: number;
  private lastError?: string;
  private lastHeartbeat = 0;
  private pendingMessages: QueuedMessage[] = [];
  private messageDispatchTimer?: ReturnType<typeof setTimeout>;
  private messageDispatching = false;
  private roomConnectStartInterval = ROOM_CONNECT_START_INTERVAL;
  private queuedRoomConnects: QueuedRoomConnect[] = [];
  private queuedRoomIds: Set<number> = new Set();
  private roomConnectQueueTimer?: ReturnType<typeof setTimeout>;
  private lastRoomConnectStartAt = 0;
  private messageQueueMaxSize = 2000;
  private queueOverflowLastLogAt = 0;
  private queueOverflowSuppressedCount = 0;
  private messageRetryBaseDelay = 1000;
  private messageRetryMaxDelay = 30_000;
  private messageRetryMaxAttempts = 6;
  private messageBatchSize = 20;
  private heartbeatInterval = 5000;
  private lockAcquireRetryCount = 4;
  private lockAcquireRetryDelay = 1200;
  private lockAcquireForceTakeover = false;
  private errorHistoryLimit = 50;
  private recentErrors: ClientErrorRecord[] = [];
  private signalrClientRegistering = false;
  private lastSignalrClientRegisterAt = 0;
  private suppressSignalrAutoRegister = false;

  constructor(config: Partial<DanmakuConfig> = {}) {
    super();

    this.logger = new ScopedLogger('DanmakuClient', normalizeLogLevel(config.logLevel, 'info'));
    this.clientId = config.clientId || generateClientId();
    this.cookieProvider = config.cookieProvider;
    this.liveWsConfigProvider = config.liveWsConfigProvider;
    this.liveWsConnectionFactory = config.liveWsConnectionFactory;

    this.configManager = new ConfigManager({
      ...config,
      clientId: this.clientId
    });
    this.configManager.validate();
    this.applyRuntimeTunings(this.configManager.getConfig());

    if (config.accountToken) {
      this.accountClient = new AccountApiClient(
        config.accountToken,
        config.accountApiBase,
        config.fetchImpl
      );
    }

    this.initializeManagers();
  }

  applyCliOptions(options: CliOptions): void {
    if (this.isRunning) {
      throw new Error('客户端运行中不可更新 CLI 配置');
    }
    this.configManager.updateFromCliOptions(options);
    this.configManager.validate();
    this.applyRuntimeTunings(this.configManager.getConfig());
    this.initializeManagers();
  }

  private initializeManagers(): void {
    const finalConfig = this.configManager.getConfig();
    this.applyRuntimeTunings(finalConfig);

    if (this.cookieManager) {
      this.cookieManager.stopPeriodicUpdate();
    }

    this.cookieManager = this.configManager.hasCookieCloudConfig()
      ? new CookieManager(
        finalConfig.cookieCloudKey!,
        finalConfig.cookieCloudPassword!,
        finalConfig.cookieCloudHost,
        finalConfig.cookieRefreshInterval,
        finalConfig.fetchImpl
      )
      : undefined;

    if (this.signalrConnection) {
      void this.signalrConnection.disconnect().catch(() => undefined);
    }

    this.signalrConnection = new SignalRConnection(
      finalConfig.signalrUrl,
      finalConfig.autoReconnect,
      finalConfig.reconnectInterval,
      finalConfig.signalrHeaders,
      this.logger.child('SignalR')
    );
    this.setupSignalREvents();

    if (this.statusManager) {
      this.statusManager.stop();
    }

    this.statusManager = new StreamerStatusManager(
      finalConfig.statusCheckInterval,
      finalConfig.signalrUrl,
      finalConfig.fetchImpl,
      this.logger.child('StatusManager')
    );
    this.statusManager.updateServerRooms(this.serverAssignedRooms);
    this.setupStatusManagerEvents();
  }

  /**
   * 设置SignalR事件处理
   */
  private setupSignalREvents(): void {
    if (!this.signalrConnection) {
      return;
    }

    this.signalrConnection.onRoomAssigned = (roomId: number) => {
      if (this.serverAssignedRooms.includes(roomId)) {
        return;
      }
      this.logger.info(`收到服务器分配的房间: ${roomId}`);
      this.serverAssignedRooms.push(roomId);
      this.serverRoomOfflineHits.delete(roomId);
      this.serverRoomAssignedAt.set(roomId, Date.now());
      this.serverRoomLiveConfirmed.delete(roomId);
      this.trimServerAssignedRoomsToCapacity(this.configManager.getConfig().maxConnections);
      this.statusManager?.updateServerRooms(this.serverAssignedRooms);
      this.statusManager?.refreshNow();
      this.lastRoomAssigned = roomId;
      this.updateConnections();
      void this.syncRuntimeState();
      this.emit('roomAssigned', roomId);
    };

    this.signalrConnection.onRoomReplaced = (oldRoomId: number, newRoomId: number) => {
      this.logger.info(`收到服务器替换指令: ${oldRoomId} -> ${newRoomId}`);
      this.applyServerRoomReplacement(oldRoomId, newRoomId);
    };

    this.signalrConnection.onRoomUnassigned = (roomId: number) => {
      if (!this.serverAssignedRooms.includes(roomId)) {
        return;
      }

      this.logger.info(`收到服务器取消分配指令: ${roomId}`);
      this.serverAssignedRooms = this.serverAssignedRooms.filter(id => id !== roomId);
      this.serverRoomOfflineHits.delete(roomId);
      this.serverRoomAssignedAt.delete(roomId);
      this.serverRoomLiveConfirmed.delete(roomId);
      this.statusManager?.updateServerRooms(this.serverAssignedRooms);
      this.statusManager?.refreshNow();
      this.disconnectFromRoom(roomId);
      this.updateConnections();
      void this.syncRuntimeState();
    };

    this.signalrConnection.onConnected = () => {
      this.triggerSignalRClientRegistration('connected');
      this.scheduleMessageDispatch(0);
    };

    this.signalrConnection.onReconnected = () => {
      this.triggerSignalRClientRegistration('reconnected');
      this.scheduleMessageDispatch(0);
    };
  }

  private applyServerRoomReplacement(oldRoomId: number, newRoomId: number): void {
    if (oldRoomId <= 0 || newRoomId <= 0) {
      return;
    }

    this.serverAssignedRooms = this.serverAssignedRooms.filter(id => id !== oldRoomId);
    if (!this.serverAssignedRooms.includes(newRoomId)) {
      this.serverAssignedRooms.push(newRoomId);
    }
    this.serverRoomOfflineHits.delete(oldRoomId);
    this.serverRoomOfflineHits.delete(newRoomId);
    this.serverRoomAssignedAt.delete(oldRoomId);
    this.serverRoomAssignedAt.set(newRoomId, Date.now());
    this.serverRoomLiveConfirmed.delete(oldRoomId);
    this.serverRoomLiveConfirmed.delete(newRoomId);
    this.trimServerAssignedRoomsToCapacity(this.configManager.getConfig().maxConnections);
    this.lastRoomAssigned = newRoomId;

    const statusManager = this.statusManager;
    statusManager?.updateServerRooms(this.serverAssignedRooms);
    statusManager?.refreshNow();

    this.disconnectFromRoom(oldRoomId);
    if (!this.connections.has(newRoomId)) {
      this.queueRoomConnect(newRoomId, 'server');
    }

    this.updateConnections();
    void this.syncRuntimeState();
    this.emit('roomReplaced', { oldRoomId, newRoomId });
  }

  /**
   * 设置状态管理器事件处理
   */
  private setupStatusManagerEvents(): void {
    if (!this.statusManager) {
      return;
    }

    this.statusManager.onStatusUpdated = (statuses: StreamerStatus[]) => {
      this.logger.info(`更新主播状态: ${statuses.filter(s => s.isLive).length}/${statuses.length} 在线`);
      this.updateConnections();
      this.emit('streamerStatusUpdated', statuses);
    };
  }

  /**
   * 启动客户端
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('客户端已在运行中');
      return;
    }

    try {
      this.isStopping = false;
      this.logger.info('正在启动弹幕客户端... (v_hot_reload)');

      await this.prepareAccountConfig();
      await this.acquireRuntimeLock();

      // 启动CookieManager
      if (this.cookieManager) {
        this.logger.info('启动Cookie管理器...');
        this.cookieManager.startPeriodicUpdate();
      }

      // 连接SignalR
      this.logger.info('连接到SignalR服务器...');
      const signalrConnection = this.ensureSignalRConnection();
      const signalrConnected = await signalrConnection.connect();
      if (!signalrConnected) {
        throw new Error('无法连接到SignalR服务器');
      }

      // 首次注册前先强制同步空连接态，清理同 clientId 旧心跳残留导致的容量误判
      await this.syncRuntimeState({
        isRunning: true,
        signalrConnected: true,
        connectedRooms: [],
        connectionInfo: [],
        serverAssignedRooms: [],
        lastRoomAssigned: null
      }, { force: true, strict: true });

      // 注册客户端
      const registerSuccess = await signalrConnection.registerClient(this.buildRegisterRoomIds());
      if (!registerSuccess) {
        throw new Error('SignalR客户端注册失败');
      }
      this.isRunning = true;
      this.messageCount = 0;

      // 启动状态管理器
      this.logger.info('启动状态检查器...');
      const statusManager = this.ensureStatusManager();
      statusManager.updateServerRooms(this.serverAssignedRooms);
      statusManager.start();
      this.startAccountConfigRefresh();

      this.logger.info('弹幕客户端启动成功');
      await this.syncRuntimeState();
      this.ensureHeartbeat();
      this.scheduleMessageDispatch(0);

    } catch (error) {
      this.logger.error('启动弹幕客户端失败:', error);
      this.recordError(error, { category: 'config', code: 'CLIENT_START_FAILED' });
      await this.stop({ suppressReleaseErrors: true });
      throw error;
    }
  }

  /**
   * 停止客户端
   */
  async stop(options?: { suppressReleaseErrors?: boolean }): Promise<void> {
    this.logger.info('正在停止弹幕客户端...');
    this.isStopping = true;
    this.isRunning = false;

    this.stopAccountConfigRefresh();

    if (this.updateConnectionsTimer) {
      clearTimeout(this.updateConnectionsTimer);
      this.updateConnectionsTimer = undefined;
    }
    this.clearQueuedRoomConnects();

    // 停止状态管理器
    this.statusManager?.stop();

    // 停止所有直播间连接
    for (const [roomId, connInfo] of this.connections) {
      try {
        connInfo.connection.close();
      } catch (error) {
        this.logger.error(`关闭房间 ${roomId} 连接失败:`, error);
      }
    }
    this.connections.clear();

    // 停止CookieManager
    if (this.cookieManager) {
      this.cookieManager.stopPeriodicUpdate();
    }

    // 断开SignalR连接
    await this.signalrConnection?.disconnect();
    this.serverAssignedRooms = [];
    this.serverRoomOfflineHits.clear();
    this.serverRoomAssignedAt.clear();
    this.serverRoomLiveConfirmed.clear();
    this.statusManager?.updateServerRooms([]);
    this.messageCount = 0;
    this.lastRoomAssigned = undefined;
    this.lastError = undefined;
    this.recentErrors = [];
    this.clearMessageDispatch();
    this.pendingMessages = [];
    this.queueOverflowLastLogAt = 0;
    this.queueOverflowSuppressedCount = 0;
    this.clearHeartbeat();
    await this.syncRuntimeState();
    if (this.accountClient) {
      try {
        await this.accountClient.releaseRuntimeState(this.clientId);
      } catch (releaseError) {
        this.recordError(releaseError, { category: 'lock', code: 'LOCK_RELEASE_FAILED', recoverable: true });
        if (options?.suppressReleaseErrors) {
          this.logger.warn('释放核心锁失败', releaseError);
        } else {
          this.isStopping = false;
          throw releaseError;
        }
      }
    }
    this.isStopping = false;
    this.logger.info('弹幕客户端已停止');
  }

  /**
   * 更新连接状态
   */
  private updateConnections(): void {
    if (!this.isRunning || this.isStopping) {
      return;
    }

    if (this.updateConnectionsTimer) {
      clearTimeout(this.updateConnectionsTimer);
    }

    this.updateConnectionsTimer = setTimeout(() => {
      this.updateConnectionsTimer = undefined;
      this.applyConnectionsUpdate();
    }, 300);
  }

  private applyConnectionsUpdate(): void {
    if (!this.isRunning || this.isStopping) {
      return;
    }

    const config = this.configManager.getConfig();
    const statusManager = this.ensureStatusManager();
    const signalrConnected = this.signalrConnection?.getConnectionState() ?? false;
    // SignalR 断线期间，保留现有服务端分配，避免因状态查询抖动导致房间被误断开。
    if (signalrConnected) {
      this.evictInactiveServerAssignedRooms(statusManager);
    }
    this.trimServerAssignedRoomsToCapacity(config.maxConnections);

    // 获取应该连接的房间
    const roomsToConnect = statusManager.getRoomsToConnect(
      this.serverAssignedRooms,
      config.maxConnections
    );

    // 当前连接的房间
    const currentConnections = Array.from(this.connections.keys());
    const targetRooms = roomsToConnect.map(r => r.roomId);

    if (!signalrConnected) {
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

    // 断开不需要的连接
    for (const roomId of currentConnections) {
      if (!targetRooms.includes(roomId)) {
        this.disconnectFromRoom(roomId);
      }
    }

    // 建立新的连接
    for (const roomConfig of roomsToConnect) {
      if (!this.connections.has(roomConfig.roomId)) {
        this.queueRoomConnect(roomConfig.roomId, roomConfig.priority);
      }
    }

    // 定期向服务器请求分配/替换（由服务端根据容量与优先级决策）
    const shouldRequestServerRooms = (config.requestServerRooms ?? true)
      && this.shouldRequestServerRooms(config.maxConnections);
    const syncPromise = this.syncRuntimeState();
    if (shouldRequestServerRooms) {
      void syncPromise.finally(() => {
        this.maybeRequestServerRoomAssignment();
      });
      return;
    }

    void syncPromise;
  }

  private evictInactiveServerAssignedRooms(statusManager: StreamerStatusManager): number[] {
    if (this.serverAssignedRooms.length === 0) {
      return [];
    }

    const keep: number[] = [];
    const removed: number[] = [];

    for (const roomId of this.serverAssignedRooms) {
      if (!Number.isFinite(roomId) || roomId <= 0) {
        continue;
      }

      if (this.connections.has(roomId)) {
        this.serverRoomOfflineHits.delete(roomId);
        keep.push(roomId);
        continue;
      }

      const status = statusManager.getStreamerStatus(roomId);
      if (!status) {
        keep.push(roomId);
        continue;
      }

      if (status.isLive) {
        this.serverRoomOfflineHits.delete(roomId);
        this.serverRoomLiveConfirmed.add(roomId);
        keep.push(roomId);
        continue;
      }

      // 新分配但尚未确认在线的房间，给一个保护窗口防止误判导致首轮抖动
      if (!this.serverRoomLiveConfirmed.has(roomId)) {
        const assignedAt = this.serverRoomAssignedAt.get(roomId) ?? 0;
        if (assignedAt > 0 && Date.now() - assignedAt < SERVER_ROOM_ASSIGN_GRACE_MS) {
          keep.push(roomId);
          continue;
        }
      }

      const hits = (this.serverRoomOfflineHits.get(roomId) ?? 0) + 1;
      if (hits < SERVER_ROOM_OFFLINE_EVICT_HITS) {
        this.serverRoomOfflineHits.set(roomId, hits);
        keep.push(roomId);
        continue;
      }

      this.serverRoomOfflineHits.delete(roomId);
      this.serverRoomAssignedAt.delete(roomId);
      this.serverRoomLiveConfirmed.delete(roomId);
      this.removeQueuedRoomConnect(roomId);
      removed.push(roomId);
    }

    for (const roomId of Array.from(this.serverRoomOfflineHits.keys())) {
      if (!keep.includes(roomId)) {
        this.serverRoomOfflineHits.delete(roomId);
      }
    }
    for (const roomId of Array.from(this.serverRoomAssignedAt.keys())) {
      if (!keep.includes(roomId)) {
        this.serverRoomAssignedAt.delete(roomId);
      }
    }
    for (const roomId of Array.from(this.serverRoomLiveConfirmed.keys())) {
      if (!keep.includes(roomId)) {
        this.serverRoomLiveConfirmed.delete(roomId);
      }
    }

    if (removed.length > 0) {
      this.serverAssignedRooms = keep;
      statusManager.updateServerRooms(this.serverAssignedRooms);
      this.logger.info(`移除已下播房间分配: ${removed.join(',')}`);
    }

    return removed;
  }

  private shouldRequestServerRooms(maxConnections: number): boolean {
    const capacity = Math.max(0, Math.floor(maxConnections));
    if (capacity <= 0) {
      return false;
    }

    const assignedRooms = Array.from(
      new Set(this.serverAssignedRooms.filter(roomId => Number.isFinite(roomId) && roomId > 0))
    );

    // 还有待连接的服务器分配房间时，先等待其处理结果，避免重复请求
    if (assignedRooms.some(roomId => !this.connections.has(roomId))) {
      return false;
    }

    if (this.queuedRoomConnects.length > 0) {
      return false;
    }

    return true;
  }

  private trimServerAssignedRoomsToCapacity(maxConnections: number): void {
    const uniqueRooms = Array.from(
      new Set(this.serverAssignedRooms.filter(roomId => Number.isFinite(roomId) && roomId > 0))
    );

    const targetSize = Math.max(0, Math.floor(maxConnections));
    if (uniqueRooms.length <= targetSize) {
      if (uniqueRooms.length !== this.serverAssignedRooms.length) {
        this.serverAssignedRooms = uniqueRooms;
        this.statusManager?.updateServerRooms(this.serverAssignedRooms);
      }
      return;
    }

    const connectedSet = new Set(this.connections.keys());
    const keep: number[] = [];

    for (const roomId of uniqueRooms) {
      if (keep.length >= targetSize) break;
      if (connectedSet.has(roomId)) {
        keep.push(roomId);
      }
    }
    for (const roomId of uniqueRooms) {
      if (keep.length >= targetSize) break;
      if (!keep.includes(roomId)) {
        keep.push(roomId);
      }
    }

    const dropped = uniqueRooms.filter(roomId => !keep.includes(roomId));
    this.serverAssignedRooms = keep;
    this.statusManager?.updateServerRooms(this.serverAssignedRooms);
    if (dropped.length > 0) {
      for (const roomId of dropped) {
        this.serverRoomOfflineHits.delete(roomId);
        this.serverRoomAssignedAt.delete(roomId);
        this.serverRoomLiveConfirmed.delete(roomId);
        this.removeQueuedRoomConnect(roomId);
      }
      this.logger.warn(`服务器分配房间超出上限，已裁剪: max=${targetSize}, dropped=${dropped.join(',')}`);
    }
  }

  private queueRoomConnect(roomId: number, priority: 'high' | 'normal' | 'low' | 'server'): void {
    if (!this.isRunning || this.isStopping || roomId <= 0) {
      return;
    }

    if (this.connections.has(roomId)) {
      return;
    }

    if (this.queuedRoomIds.has(roomId)) {
      const queued = this.queuedRoomConnects.find(item => item.roomId === roomId);
      if (queued) {
        queued.priority = priority;
      }
      return;
    }

    this.queuedRoomConnects.push({ roomId, priority });
    this.queuedRoomIds.add(roomId);
    this.scheduleQueuedRoomConnect();
  }

  private removeQueuedRoomConnect(roomId: number): void {
    if (!this.queuedRoomIds.delete(roomId)) {
      return;
    }
    this.queuedRoomConnects = this.queuedRoomConnects.filter(item => item.roomId !== roomId);
  }

  private clearQueuedRoomConnects(): void {
    if (this.roomConnectQueueTimer) {
      clearTimeout(this.roomConnectQueueTimer);
      this.roomConnectQueueTimer = undefined;
    }
    this.queuedRoomConnects = [];
    this.queuedRoomIds.clear();
    this.lastRoomConnectStartAt = 0;
  }

  private scheduleQueuedRoomConnect(): void {
    if (this.roomConnectQueueTimer || this.queuedRoomConnects.length === 0 || !this.isRunning || this.isStopping) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastRoomConnectStartAt;
    const waitMs = this.lastRoomConnectStartAt === 0
      ? 0
      : Math.max(0, this.roomConnectStartInterval - elapsed);

    this.roomConnectQueueTimer = setTimeout(() => {
      this.roomConnectQueueTimer = undefined;
      void this.processQueuedRoomConnect();
    }, waitMs);
  }

  private async processQueuedRoomConnect(): Promise<void> {
    if (!this.isRunning || this.isStopping) {
      this.clearQueuedRoomConnects();
      return;
    }

    const next = this.queuedRoomConnects.shift();
    if (!next) {
      return;
    }
    this.queuedRoomIds.delete(next.roomId);

    if (!this.connections.has(next.roomId) && this.isRoomStillDesired(next.roomId)) {
      this.lastRoomConnectStartAt = Date.now();
      await this.connectToRoom(next.roomId, next.priority);
    }

    if (this.queuedRoomConnects.length > 0) {
      this.scheduleQueuedRoomConnect();
    }
  }

  private isRoomStillDesired(roomId: number): boolean {
    if (roomId <= 0 || !this.statusManager) {
      return false;
    }

    const config = this.configManager.getConfig();
    const roomsToConnect = this.statusManager.getRoomsToConnect(
      this.serverAssignedRooms,
      config.maxConnections
    );
    return roomsToConnect.some(item => item.roomId === roomId);
  }

  /**
   * 连接到单个房间
   */
  private async connectToRoom(roomId: number, priority: 'high' | 'normal' | 'low' | 'server'): Promise<void> {
    if (!this.isRunning || this.isStopping) {
      return;
    }

    if (this.connections.has(roomId)) {
      this.logger.warn(`房间 ${roomId} 已经连接`);
      return;
    }

    try {
      this.logger.info(`正在连接到房间 ${roomId} (优先级: ${priority})...`);

      const connectionOptions = await this.resolveLiveWsConnectionOptions(roomId);
      const targetRoomId = typeof connectionOptions.roomId === 'number' && connectionOptions.roomId > 0
        ? connectionOptions.roomId
        : roomId;
      const { roomId: _resolvedRoomId, ...liveOptions } = connectionOptions;
      const keyLength = typeof liveOptions.key === 'string' ? liveOptions.key.length : 0;
      const addressHost = typeof liveOptions.address === 'string'
        ? (liveOptions.address.replace(/^wss?:\/\//i, '').split('/')[0] || 'unknown')
        : 'none';
      this.logger.info(
        `房间 ${roomId} 鉴权参数: wsRoom=${targetRoomId}, keyLen=${keyLength}, addressHost=${addressHost}, uid=${liveOptions.uid ?? 0}, buvid=${liveOptions.buvid ? 'present' : 'missing'}`
      );
      const roomConfig: LiveWsRoomConfig = {
        address: liveOptions.address ?? '',
        key: liveOptions.key ?? '',
        uid: liveOptions.uid,
        buvid: liveOptions.buvid,
        protover: liveOptions.protover,
        roomId: targetRoomId
      };
      const liveWS = this.liveWsConnectionFactory
        ? await this.liveWsConnectionFactory(targetRoomId, roomConfig)
        : new LiveWS(targetRoomId, liveOptions);

      // 设置事件监听
      this.setupLiveWSEvents(liveWS, roomId);

      const connectionInfo: ConnectionInfo = {
        connection: liveWS,
        roomId,
        priority,
        connectedAt: Date.now()
      };

      this.connections.set(roomId, connectionInfo);
      this.emit('connected', roomId);
      void this.syncRuntimeState();

      this.logger.info(`房间 ${roomId} 连接已创建 (ws room=${targetRoomId})`);

    } catch (error) {
      this.logger.error(`连接到房间 ${roomId} 失败:`, error);
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.recordError(normalizedError, { category: 'livews', code: 'LIVEWS_CONNECT_FAILED', roomId, recoverable: true });
      this.emit('error', normalizedError, roomId);
    }
  }

  private async resolveLiveWsConnectionOptions(roomId: number): Promise<LiveWsConnectionOptions> {
    const preferredCookie = this.getPreferredCookie();
    const cookie = preferredCookie?.value;
    const uid = this.readUidFromCookie(cookie);
    const buvid = this.readBuvidFromCookie(cookie);
    this.logger.info(
      `房间 ${roomId} 准备获取鉴权: cookieSource=${preferredCookie?.source ?? 'none'}, uid=${uid}, buvid=${buvid ? 'present' : 'missing'}, provider=${this.liveWsConfigProvider ? 'remote' : 'none'}`
    );

    const options: LiveWsConnectionOptions = {
      uid,
      protover: 3
    };
    if (buvid) {
      options.buvid = buvid;
    }

    if (!this.liveWsConfigProvider) {
      return options;
    }

    const remote = await this.liveWsConfigProvider(roomId);
    if (!remote) {
      this.logger.warn(`房间 ${roomId} 鉴权提供器返回空配置，将使用本地默认参数`);
      return options;
    }
    if (!remote.address || !remote.key) {
      throw new Error(`房间 ${roomId} 鉴权信息不完整`);
    }

    const remoteUid = typeof remote.uid === 'number' && Number.isFinite(remote.uid) ? Math.floor(remote.uid) : 0;
    const localUid = typeof options.uid === 'number' && Number.isFinite(options.uid) ? Math.floor(options.uid) : 0;
    const mergedUid = remoteUid > 0 ? remoteUid : localUid;
    if (remoteUid <= 0 && localUid > 0) {
      this.logger.warn(
        `房间 ${roomId} 鉴权配置返回 uid=${remoteUid}，回退使用本地 cookie uid=${localUid}`
      );
    }

    return {
      ...options,
      ...remote,
      uid: mergedUid,
      buvid: remote.buvid ?? options.buvid,
      protover: remote.protover ?? options.protover
    };
  }

  private readUidFromCookie(cookie?: string): number {
    if (!cookie) {
      return 0;
    }
    const uidText = DanmakuClient.readCookieValue(cookie, 'DedeUserID');
    if (uidText && /^[0-9]+$/.test(uidText)) {
      return Number(uidText);
    }
    return 0;
  }

  private readBuvidFromCookie(cookie?: string): string | undefined {
    if (!cookie) {
      return undefined;
    }
    return DanmakuClient.readCookieValue(cookie, 'buvid3')
      ?? DanmakuClient.readCookieValue(cookie, 'buvid4')
      ?? DanmakuClient.readCookieValue(cookie, 'buvid_fp');
  }

  private getPreferredCookie(): { source: CookieSource; value: string } | null {
    const localCookie = this.cookieProvider?.()?.trim();
    if (localCookie) {
      return { source: 'biliLocal', value: localCookie };
    }

    const cloudCookie = this.cookieManager?.getCookies().trim();
    if (cloudCookie) {
      return { source: 'cookieCloud', value: cloudCookie };
    }

    return null;
  }

  private hasAvailableCookie(): boolean {
    return this.getPreferredCookie() !== null;
  }

  private static readCookieValue(cookie: string, key: string): string | undefined {
    const parts = cookie.split(';');
    for (const part of parts) {
      const segment = part.trim();
      if (!segment) {
        continue;
      }
      const separator = segment.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const name = segment.slice(0, separator).trim();
      if (name !== key) {
        continue;
      }
      const value = segment.slice(separator + 1).trim();
      return value || undefined;
    }
    return undefined;
  }

  private static waitMs(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }

  /**
   * 设置LiveWS事件监听
   */
  private setupLiveWSEvents(liveWS: LiveWsConnection, roomId: number): void {
    liveWS.addEventListener('open', () => {
      this.logger.info(`房间 ${roomId} WebSocket连接已建立`);
    });

    liveWS.addEventListener('CONNECT_SUCCESS', ({ data }: any) => {
      this.logger.debug(`房间 ${roomId} CONNECT_SUCCESS`, data);
    });

    liveWS.addEventListener('HEARTBEAT_REPLY', ({ data }: any) => {
      this.logger.debug(`房间 ${roomId} HEARTBEAT_REPLY`, data);
    });

    liveWS.addEventListener('error:decode', (event: any) => {
      const reason = event?.error instanceof Error ? event.error.message : String(event?.error ?? 'unknown');
      const decodeError = new Error(`房间 ${roomId} 消息解码失败: ${reason}`);
      this.logger.error(decodeError.message, event?.error ?? event);
      this.recordError(decodeError, { category: 'livews', code: 'MESSAGE_DECODE_FAILED', roomId, recoverable: true });
      this.emit('error', decodeError, roomId);
    });

    liveWS.addEventListener('close', (event: any) => {
      const connectionInfo = this.connections.get(roomId);
      const code = typeof event?.code === 'number' ? event.code : -1;
      const reason = typeof event?.reason === 'string' ? event.reason : '';
      this.logger.warn(`房间 ${roomId} WebSocket连接已关闭 (code=${code}, reason=${reason || 'none'})`);
      this.connections.delete(roomId);
      this.emit('disconnected', roomId);
      const syncRuntimePromise = this.syncRuntimeState();
      void syncRuntimePromise;
      this.statusManager?.refreshNow();

      // 服务器分配的房间如果“连上立刻断”，通常代表房间不在直播/不可用；移除后再申请补位
      if (connectionInfo?.priority === 'server') {
        const lifetimeMs = Date.now() - connectionInfo.connectedAt;
        if (lifetimeMs < 10_000) {
          this.serverAssignedRooms = this.serverAssignedRooms.filter(id => id !== roomId);
          this.serverRoomOfflineHits.delete(roomId);
          this.serverRoomAssignedAt.delete(roomId);
          this.serverRoomLiveConfirmed.delete(roomId);
          this.statusManager?.updateServerRooms(this.serverAssignedRooms);
          void syncRuntimePromise.finally(() => {
            this.maybeRequestServerRoomAssignment();
          });
        }
      }

      if (!this.isStopping && this.isRunning) {
        this.updateConnections();
      }
    });

    liveWS.addEventListener('error', (event: any) => {
      this.logger.error(`房间 ${roomId} WebSocket错误:`, event);
      const error = new Error(`房间 ${roomId} WebSocket错误`);
      this.recordError(error, { category: 'livews', code: 'LIVEWS_RUNTIME_ERROR', roomId, recoverable: true });
      this.emit('error', error, roomId);
    });

    // 监听所有消息，统一处理
    liveWS.addEventListener('MESSAGE', ({ data }: any) => {
      const message = this.parseMessage(data, roomId);
      this.logger.debug(`房间 ${roomId} 收到消息 cmd=${message.cmd}`);
      this.handleMessage(message).catch(error => {
        this.logger.error(`处理房间 ${roomId} 消息时发生错误:`, error);
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.recordError(normalizedError, { category: 'livews', code: 'MESSAGE_HANDLE_FAILED', roomId, recoverable: true });
        this.emit('error', normalizedError, roomId);
      });
    });
  }

  /**
   * 解析消息为统一格式
   */
  private parseMessage(data: any, roomId: number, cmd?: string): DanmakuMessage {
    const actualCmd = cmd || data?.cmd || data?.msg?.cmd || 'UNKNOWN';

    return {
      roomId,
      cmd: actualCmd,
      data: data,
      raw: this.safeStringify(data),
      timestamp: Date.now()
    };
  }

  private safeStringify(value: unknown): string {
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(value, (_key, item) => {
        if (typeof item === 'bigint') {
          return item.toString();
        }
        if (item && typeof item === 'object') {
          if (seen.has(item)) {
            return '[Circular]';
          }
          seen.add(item);
        }
        return item;
      });
    } catch {
      return '[Unserializable Message]';
    }
  }

  /**
   * 处理消息
   */
  private async handleMessage(message: DanmakuMessage): Promise<void> {
    this.messageCount += 1;
    // 发射 'msg' 事件（所有消息）
    this.emit('msg', message);

    // 发射特定cmd的事件
    this.emit(message.cmd, message);

    this.enqueueMessage(message);
  }

  /**
   * 断开房间连接
   */
  private disconnectFromRoom(roomId: number): void {
    this.removeQueuedRoomConnect(roomId);
    const connectionInfo = this.connections.get(roomId);
    if (connectionInfo) {
      connectionInfo.connection.close();
      this.connections.delete(roomId);
      this.logger.info(`房间 ${roomId} 连接已断开`);
      void this.syncRuntimeState();
    }
  }

  /**
   * 获取当前连接的房间列表
   */
  getConnectedRooms(): number[] {
    return Array.from(this.connections.keys());
  }

  /**
   * 获取连接信息
   */
  getConnectionInfo(): { roomId: number; priority: string; connectedAt: number }[] {
    return Array.from(this.connections.values()).map(info => ({
      roomId: info.roomId,
      priority: info.priority,
      connectedAt: info.connectedAt
    }));
  }

  /**
   * 获取客户端状态
   */
  getStatus() {
    const connectionInfo = this.getConnectionInfo();
    const streamerStatuses = this.statusManager?.getAllStatuses() ?? [];

    return {
      clientId: this.clientId,
      isRunning: this.isRunning,
      connectedRooms: this.getConnectedRooms(),
      connectionInfo,
      signalrConnected: this.signalrConnection?.getConnectionState() ?? false,
      cookieValid: this.hasAvailableCookie(),
      streamerStatuses,
      serverAssignedRooms: [...this.serverAssignedRooms],
      messageCount: this.messageCount,
      pendingMessageCount: this.pendingMessages.length,
      recentErrors: this.recentErrors.map(item => ({ ...item })),
      lastRoomAssigned: this.lastRoomAssigned,
      lastError: this.lastError,
      lastHeartbeat: this.lastHeartbeat,
      config: this.configManager.getConfig()
    };
  }

  private ensureSignalRConnection(): SignalRConnection {
    if (!this.signalrConnection) {
      throw new Error('SignalR连接尚未初始化');
    }
    return this.signalrConnection;
  }

  private ensureStatusManager(): StreamerStatusManager {
    if (!this.statusManager) {
      throw new Error('状态管理器尚未初始化');
    }
    return this.statusManager;
  }

  private async prepareAccountConfig(): Promise<void> {
    if (!this.accountClient) {
      return;
    }

    this.logger.info('正在从账号中心加载核心配置...');
    const remoteConfig = await this.accountClient.getCoreConfig();
    this.configManager.applyAccountConfig(remoteConfig);
    this.applyRuntimeTunings(this.configManager.getConfig());
    this.initializeManagers();
  }

  private async acquireRuntimeLock(): Promise<void> {
    if (!this.accountClient) {
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.lockAcquireRetryCount; attempt++) {
      try {
        await this.syncRuntimeState({}, { strict: true });
        if (attempt > 1) {
          this.logger.info(`核心锁获取成功 (attempt=${attempt})`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (!this.isLockConflictError(error)) {
          throw error;
        }

        this.recordError(error, {
          category: 'lock',
          code: 'LOCK_CONFLICT',
          recoverable: true
        });

        if (attempt >= this.lockAcquireRetryCount) {
          break;
        }

        const delay = this.lockAcquireRetryDelay * attempt + Math.floor(Math.random() * 300);
        this.logger.warn(`核心锁冲突，${delay}ms 后重试 (attempt=${attempt}/${this.lockAcquireRetryCount})`);
        await DanmakuClient.waitMs(delay);
      }
    }

    if (this.lockAcquireForceTakeover && this.isLockConflictError(lastError)) {
      this.logger.warn('核心锁冲突持续存在，执行 force 接管');
      await this.syncRuntimeState({}, { strict: true, force: true });
      return;
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? '核心锁获取失败'));
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    const beat = async () => {
      this.heartbeatTimer = undefined;
      await this.syncRuntimeState();
      this.ensureHeartbeat();
    };

    this.heartbeatTimer = setTimeout(beat, this.heartbeatInterval);
  }

  private isLockConflictError(error: unknown): boolean {
    const message = this.getErrorMessage(error);
    return message.includes('同一 IP 已存在其他客户端连接')
      || message.includes('客户端未持有锁')
      || message.includes('423');
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private buildRegisterRoomIds(): number[] {
    return Array.from(
      new Set(this.getConnectedRooms().filter(roomId => Number.isFinite(roomId) && roomId > 0))
    );
  }

  private buildRuntimeStateSnapshot(): CoreRuntimeStateDto {
    const status = this.getStatus();
    const now = Date.now();

    return {
      clientId: this.clientId,
      clientVersion: status.config.clientVersion ?? 'core',
      isRunning: status.isRunning,
      signalrConnected: status.signalrConnected,
      cookieValid: status.cookieValid,
      connectedRooms: status.connectedRooms,
      connectionInfo: status.connectionInfo.map<CoreConnectionInfoDto>(info => ({
        roomId: info.roomId,
        priority: info.priority,
        connectedAt: new Date(info.connectedAt).toISOString()
      })),
      serverAssignedRooms: [...this.serverAssignedRooms],
      messageCount: this.messageCount,
      lastRoomAssigned: this.lastRoomAssigned ?? null,
      lastError: this.lastError ?? null,
      lastHeartbeat: new Date(this.lastHeartbeat || now).toISOString()
    };
  }

  private async syncRuntimeState(
    overrides: Partial<CoreRuntimeStateDto> = {},
    options?: { force?: boolean; strict?: boolean }
  ): Promise<void> {
    if (!this.accountClient) {
      return;
    }

    const fullState = {
      ...this.buildRuntimeStateSnapshot(),
      ...overrides,
      clientId: this.clientId
    };
    
    // 剔除后端不需要的字段，防止 500 错误
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { lastHeartbeat, ...payload } = fullState;

    try {
      await this.accountClient.syncRuntimeState(payload as any, { force: options?.force });
      this.lastHeartbeat = Date.now();
    } catch (error) {
      this.recordError(error, { category: 'runtime-sync', code: 'RUNTIME_SYNC_FAILED', recoverable: true });
      this.logger.warn('同步核心运行状态失败', error);
      if (options?.strict) {
        throw error;
      }
    }
  }

  private maybeRequestServerRoomAssignment(): void {
    const signalrConnection = this.signalrConnection;
    if (!signalrConnection?.getConnectionState()) {
      return;
    }

    const now = Date.now();
    if (now - this.lastServerRoomRequestAt < 15_000) {
      return;
    }
    this.lastServerRoomRequestAt = now;

    void signalrConnection.requestRoomAssignment();
  }

  private startAccountConfigRefresh(): void {
    if (this.accountConfigRefreshTimer || !this.accountClient) {
      return;
    }

    this.accountConfigRefreshTimer = setInterval(() => {
      void this.refreshAccountConfig();
    }, 30_000);
  }

  private stopAccountConfigRefresh(): void {
    if (this.accountConfigRefreshTimer) {
      clearInterval(this.accountConfigRefreshTimer);
      this.accountConfigRefreshTimer = undefined;
    }
    this.accountConfigRefreshing = false;
  }

  private enqueueMessage(message: DanmakuMessage): void {
    if (!this.isRunning || this.isStopping) {
      return;
    }

    if (this.pendingMessages.length >= this.messageQueueMaxSize) {
      const dropped = this.pendingMessages.shift();
      const queueError = new Error(`消息队列已满(${this.messageQueueMaxSize})，最早消息已丢弃`);
      this.recordError(queueError, { category: 'queue', code: 'QUEUE_OVERFLOW', recoverable: true, roomId: dropped?.message.roomId });
      this.logQueueOverflow(queueError, dropped);
      this.emit('error', queueError, dropped?.message.roomId);
    }

    this.pendingMessages.push({
      message,
      retryCount: 0,
      nextRetryAt: Date.now()
    });
    this.scheduleMessageDispatch(0);
  }

  private logQueueOverflow(queueError: Error, dropped?: QueuedMessage): void {
    const now = Date.now();
    if (now - this.queueOverflowLastLogAt < QUEUE_OVERFLOW_LOG_INTERVAL_MS) {
      this.queueOverflowSuppressedCount += 1;
      return;
    }

    const suppressed = this.queueOverflowSuppressedCount;
    this.queueOverflowSuppressedCount = 0;
    this.queueOverflowLastLogAt = now;
    const throttleHint = suppressed > 0
      ? `；过去 ${Math.floor(QUEUE_OVERFLOW_LOG_INTERVAL_MS / 1000)} 秒内省略 ${suppressed} 条同类日志`
      : '';

    this.logger.error(`${queueError.message}${throttleHint}`, {
      roomId: dropped?.message.roomId,
      cmd: dropped?.message.cmd
    });
  }

  private scheduleMessageDispatch(delayMs: number): void {
    const delay = Math.max(0, Math.floor(delayMs));
    if (this.messageDispatchTimer) {
      if (delay > 0) {
        return;
      }
      clearTimeout(this.messageDispatchTimer);
      this.messageDispatchTimer = undefined;
    }

    this.messageDispatchTimer = setTimeout(() => {
      this.messageDispatchTimer = undefined;
      void this.flushPendingMessages();
    }, delay);
  }

  private clearMessageDispatch(): void {
    if (this.messageDispatchTimer) {
      clearTimeout(this.messageDispatchTimer);
      this.messageDispatchTimer = undefined;
    }
    this.messageDispatching = false;
  }

  private async flushPendingMessages(): Promise<void> {
    if (this.messageDispatching || this.isStopping || !this.isRunning) {
      return;
    }

    this.messageDispatching = true;
    try {
      while (this.pendingMessages.length > 0) {
        const now = Date.now();
        const queued = this.pendingMessages[0];

        if (queued.nextRetryAt > now) {
          this.scheduleMessageDispatch(queued.nextRetryAt - now);
          return;
        }

        const signalrConnection = this.signalrConnection;
        if (!signalrConnection?.getConnectionState()) {
          this.scheduleMessageDispatch(this.messageRetryBaseDelay);
          return;
        }

        const batch = this.pendingMessages
          .slice(0, this.messageBatchSize)
          .filter(item => item.nextRetryAt <= now);
        if (batch.length === 0) {
          this.scheduleMessageDispatch(this.messageRetryBaseDelay);
          return;
        }

        const sentCount = await signalrConnection.sendMessages(batch.map(item => item.message));
        if (sentCount > 0) {
          this.pendingMessages.splice(0, sentCount);
          continue;
        }

        const failed = this.pendingMessages[0];
        failed.retryCount += 1;
        if (failed.retryCount >= this.messageRetryMaxAttempts) {
          this.pendingMessages.shift();
          const sendError = new Error(
            `消息上行失败: room=${failed.message.roomId}, cmd=${failed.message.cmd}, retry=${failed.retryCount}`
          );
          this.recordError(sendError, {
            category: 'signalr',
            code: 'MESSAGE_UPLOAD_FAILED',
            roomId: failed.message.roomId,
            recoverable: false
          });
          this.emit('error', sendError, failed.message.roomId);
          continue;
        }

        const delay = this.calculateMessageRetryDelay(failed.retryCount);
        failed.nextRetryAt = now + delay;
        this.logger.warn(
          `消息上行失败，${delay}ms 后重试 (room=${failed.message.roomId}, cmd=${failed.message.cmd}, retry=${failed.retryCount})`
        );
        this.scheduleMessageDispatch(delay);
        return;
      }
    } finally {
      this.messageDispatching = false;
      if (this.pendingMessages.length > 0 && !this.messageDispatchTimer && this.isRunning && !this.isStopping) {
        this.scheduleMessageDispatch(0);
      }
    }
  }

  private calculateMessageRetryDelay(retryCount: number): number {
    const exponential = this.messageRetryBaseDelay * (2 ** Math.max(0, retryCount - 1));
    return Math.min(exponential, this.messageRetryMaxDelay);
  }

  private applyRuntimeTunings(config: DanmakuConfig): void {
    this.logger.setLevel(normalizeLogLevel(config.logLevel, this.logger.getLevel()));

    const queueSize = Math.floor(config.messageQueueMaxSize ?? 2000);
    this.messageQueueMaxSize = Math.max(MESSAGE_QUEUE_MIN_SIZE, queueSize);

    const retryBaseDelay = Math.floor(config.messageRetryBaseDelay ?? 1000);
    this.messageRetryBaseDelay = Math.max(MESSAGE_RETRY_MIN_DELAY, retryBaseDelay);

    const retryMaxDelay = Math.floor(config.messageRetryMaxDelay ?? 30_000);
    this.messageRetryMaxDelay = Math.max(this.messageRetryBaseDelay, retryMaxDelay);

    const retryMaxAttempts = Math.floor(config.messageRetryMaxAttempts ?? 6);
    this.messageRetryMaxAttempts = Math.max(MESSAGE_RETRY_MIN_ATTEMPTS, retryMaxAttempts);

    const batchSize = Math.floor(config.batchUploadSize ?? 20);
    this.messageBatchSize = Math.min(MESSAGE_BATCH_MAX_SIZE, Math.max(MESSAGE_BATCH_MIN_SIZE, batchSize));

    const heartbeat = Math.floor(config.heartbeatInterval ?? 5000);
    this.heartbeatInterval = Math.max(HEARTBEAT_MIN_INTERVAL, heartbeat);

    const lockRetryCount = Math.floor(config.lockAcquireRetryCount ?? 4);
    this.lockAcquireRetryCount = Math.max(LOCK_RETRY_MIN_COUNT, lockRetryCount);

    const lockRetryDelay = Math.floor(config.lockAcquireRetryDelay ?? 1200);
    this.lockAcquireRetryDelay = Math.max(LOCK_RETRY_MIN_DELAY, lockRetryDelay);

    this.lockAcquireForceTakeover = config.lockAcquireForceTakeover ?? false;

    const errorLimit = Math.floor(config.errorHistoryLimit ?? 50);
    this.errorHistoryLimit = Math.max(ERROR_HISTORY_MIN_LIMIT, errorLimit);
    if (this.recentErrors.length > this.errorHistoryLimit) {
      this.recentErrors.splice(0, this.recentErrors.length - this.errorHistoryLimit);
    }
  }

  private async refreshAccountConfig(): Promise<void> {
    if (!this.accountClient || this.accountConfigRefreshing || this.isStopping || !this.isRunning) {
      return;
    }

    const previousConfig = this.configManager.getConfig();
    this.accountConfigRefreshing = true;
    try {
      const remoteConfig = await this.accountClient.getCoreConfig();
      this.configManager.applyAccountConfig(remoteConfig);
      this.configManager.validate();
      const nextConfig = this.configManager.getConfig();

      if (!this.hasHotConfigChanges(previousConfig, nextConfig)) {
        return;
      }

      await this.applyHotConfigChanges(previousConfig, nextConfig);
    } catch (error) {
      const failedConfig = this.configManager.getConfig();
      this.configManager.updateConfig(previousConfig);
      this.applyRuntimeTunings(previousConfig);
      try {
        if (this.hasHotConfigChanges(failedConfig, previousConfig)) {
          await this.applyHotConfigChanges(failedConfig, previousConfig);
        }
      } catch (rollbackError) {
        this.recordError(rollbackError, { category: 'config', code: 'HOT_RELOAD_ROLLBACK_FAILED' });
        this.logger.error('配置热更新回滚失败', rollbackError);
      }
      this.recordError(error, { category: 'config', code: 'HOT_RELOAD_FAILED', recoverable: true });
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.accountConfigRefreshing = false;
    }
  }

  private hasHotConfigChanges(previous: DanmakuConfig, next: DanmakuConfig): boolean {
    return previous.maxConnections !== next.maxConnections
      || previous.signalrUrl !== next.signalrUrl
      || previous.autoReconnect !== next.autoReconnect
      || previous.reconnectInterval !== next.reconnectInterval
      || previous.statusCheckInterval !== next.statusCheckInterval
      || previous.cookieCloudKey !== next.cookieCloudKey
      || previous.cookieCloudPassword !== next.cookieCloudPassword
      || previous.cookieCloudHost !== next.cookieCloudHost
      || previous.cookieRefreshInterval !== next.cookieRefreshInterval
      || previous.requestServerRooms !== next.requestServerRooms
      || normalizeLogLevel(previous.logLevel, 'info') !== normalizeLogLevel(next.logLevel, 'info')
      || (previous.messageQueueMaxSize ?? 2000) !== (next.messageQueueMaxSize ?? 2000)
      || (previous.messageRetryBaseDelay ?? 1000) !== (next.messageRetryBaseDelay ?? 1000)
      || (previous.messageRetryMaxDelay ?? 30000) !== (next.messageRetryMaxDelay ?? 30000)
      || (previous.messageRetryMaxAttempts ?? 6) !== (next.messageRetryMaxAttempts ?? 6)
      || (previous.batchUploadSize ?? 20) !== (next.batchUploadSize ?? 20)
      || (previous.heartbeatInterval ?? 5000) !== (next.heartbeatInterval ?? 5000)
      || (previous.lockAcquireRetryCount ?? 4) !== (next.lockAcquireRetryCount ?? 4)
      || (previous.lockAcquireRetryDelay ?? 1200) !== (next.lockAcquireRetryDelay ?? 1200)
      || (previous.lockAcquireForceTakeover ?? false) !== (next.lockAcquireForceTakeover ?? false)
      || (previous.errorHistoryLimit ?? 50) !== (next.errorHistoryLimit ?? 50)
      || !this.areHeadersEqual(previous.signalrHeaders, next.signalrHeaders);
  }

  private async applyHotConfigChanges(previous: DanmakuConfig, next: DanmakuConfig): Promise<void> {
    this.applyRuntimeTunings(next);

    const statusManagerChanged = previous.statusCheckInterval !== next.statusCheckInterval
      || previous.signalrUrl !== next.signalrUrl;
    const signalrChanged = previous.signalrUrl !== next.signalrUrl
      || previous.autoReconnect !== next.autoReconnect
      || previous.reconnectInterval !== next.reconnectInterval
      || !this.areHeadersEqual(previous.signalrHeaders, next.signalrHeaders);
    const cookieChanged = previous.cookieCloudKey !== next.cookieCloudKey
      || previous.cookieCloudPassword !== next.cookieCloudPassword
      || previous.cookieCloudHost !== next.cookieCloudHost
      || previous.cookieRefreshInterval !== next.cookieRefreshInterval;

    if (cookieChanged) {
      this.rebuildCookieManager(next);
    }

    if (statusManagerChanged) {
      this.rebuildStatusManager(next);
    }

    if (signalrChanged) {
      await this.rebuildSignalRConnection(next);
    }

    if (
      statusManagerChanged
      || signalrChanged
      || previous.maxConnections !== next.maxConnections
      || previous.requestServerRooms !== next.requestServerRooms
    ) {
      this.updateConnections();
    }

    this.logger.info('账号配置热更新已应用', {
      signalrChanged,
      statusManagerChanged,
      cookieChanged,
      maxConnections: next.maxConnections,
      reconnectInterval: next.reconnectInterval,
      statusCheckInterval: next.statusCheckInterval
    });
  }

  private rebuildCookieManager(config: DanmakuConfig): void {
    this.cookieManager?.stopPeriodicUpdate();
    this.cookieManager = this.configManager.hasCookieCloudConfig()
      ? new CookieManager(
        config.cookieCloudKey!,
        config.cookieCloudPassword!,
        config.cookieCloudHost,
        config.cookieRefreshInterval,
        config.fetchImpl
      )
      : undefined;

    if (this.isRunning && this.cookieManager) {
      this.cookieManager.startPeriodicUpdate();
    }
  }

  private rebuildStatusManager(config: DanmakuConfig): void {
    this.statusManager?.stop();
    this.statusManager = new StreamerStatusManager(
      config.statusCheckInterval,
      config.signalrUrl,
      config.fetchImpl,
      this.logger.child('StatusManager')
    );
    this.statusManager.updateServerRooms(this.serverAssignedRooms);
    this.setupStatusManagerEvents();
    if (this.isRunning && !this.isStopping) {
      this.statusManager.start();
    }
  }

  private async rebuildSignalRConnection(config: DanmakuConfig): Promise<void> {
    if (this.signalrConnection) {
      this.signalrConnection.onRoomAssigned = undefined;
      this.signalrConnection.onRoomReplaced = undefined;
      this.signalrConnection.onServerDisconnect = undefined;
      this.signalrConnection.onConnected = undefined;
      this.signalrConnection.onDisconnected = undefined;
      this.signalrConnection.onReconnected = undefined;
      await this.signalrConnection.disconnect();
    }

    this.signalrConnection = new SignalRConnection(
      config.signalrUrl,
      config.autoReconnect,
      config.reconnectInterval,
      config.signalrHeaders,
      this.logger.child('SignalR')
    );
    this.setupSignalREvents();

    if (!this.isRunning || this.isStopping) {
      return;
    }

    this.suppressSignalrAutoRegister = true;
    try {
      const connected = await this.signalrConnection.connect();
      if (!connected) {
        throw new Error('配置热更新后无法连接SignalR');
      }

      const registered = await this.signalrConnection.registerClient(this.buildRegisterRoomIds());
      if (!registered) {
        throw new Error('配置热更新后客户端注册失败');
      }
    } finally {
      this.suppressSignalrAutoRegister = false;
    }

    this.updateConnections();
    void this.syncRuntimeState();
    this.scheduleMessageDispatch(0);
  }

  private triggerSignalRClientRegistration(reason: 'connected' | 'reconnected'): void {
    if (!this.isRunning || this.isStopping || this.suppressSignalrAutoRegister) {
      return;
    }

    const now = Date.now();
    if (this.signalrClientRegistering || now - this.lastSignalrClientRegisterAt < 1000) {
      return;
    }

    this.signalrClientRegistering = true;
    this.lastSignalrClientRegisterAt = now;
    this.logger.info(`SignalR ${reason} 后重新注册客户端`);
    void this.reRegisterSignalRClient().finally(() => {
      this.signalrClientRegistering = false;
    });
  }

  private async reRegisterSignalRClient(): Promise<void> {
    const signalrConnection = this.signalrConnection;
    if (!signalrConnection?.getConnectionState()) {
      return;
    }

    const registered = await signalrConnection.registerClient(this.buildRegisterRoomIds());
    if (!registered) {
      const error = new Error('SignalR重连后重新注册客户端失败');
      this.recordError(error, { category: 'signalr', code: 'SIGNALR_REREGISTER_FAILED', recoverable: true });
      this.emit('error', error);
      return;
    }
    this.updateConnections();
    void this.syncRuntimeState();
  }

  private areHeadersEqual(
    left?: Record<string, string>,
    right?: Record<string, string>
  ): boolean {
    if (!left && !right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }

    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
  }

  private recordError(error: unknown, context?: ClientErrorContext): void {
    const message = this.getErrorMessage(error);
    const category = context?.category ?? 'unknown';
    const code = context?.code ?? this.defaultErrorCodeByCategory(category);
    const recoverable = context?.recoverable ?? false;
    const roomId = context?.roomId;

    this.lastError = `[${code}] ${message}`;
    const record: ClientErrorRecord = {
      timestamp: Date.now(),
      category,
      code,
      message,
      recoverable,
      ...(typeof roomId === 'number' ? { roomId } : {})
    };

    this.recentErrors.push(record);
    if (this.recentErrors.length > this.errorHistoryLimit) {
      this.recentErrors.splice(0, this.recentErrors.length - this.errorHistoryLimit);
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return JSON.stringify(error);
  }

  private defaultErrorCodeByCategory(category: ErrorCategory): string {
    switch (category) {
      case 'network':
        return 'NETWORK_ERROR';
      case 'signalr':
        return 'SIGNALR_ERROR';
      case 'runtime-sync':
        return 'RUNTIME_SYNC_ERROR';
      case 'livews':
        return 'LIVEWS_ERROR';
      case 'config':
        return 'CONFIG_ERROR';
      case 'queue':
        return 'QUEUE_ERROR';
      case 'lock':
        return 'LOCK_ERROR';
      default:
        return 'UNKNOWN_ERROR';
    }
  }

  emit<K extends keyof DanmakuClientEvents>(
    event: K,
    ...args: Parameters<DanmakuClientEvents[K]>
  ): boolean;
  emit(event: string, message: DanmakuMessage): boolean;
  emit(event: any, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
