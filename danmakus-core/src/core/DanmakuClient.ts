import EventEmitter from 'eventemitter3';
import { BilibiliApiClient, LiveWS, parseLiveConfig } from 'bilibili-live-danmaku';
import { ConfigManager } from './ConfigManager';
import { CookieManager } from './CookieManager';
import { RuntimeConnection } from './RuntimeConnection';
import { StreamerStatusManager } from './StreamerStatusManager';
import { AccountApiClient } from './AccountApiClient';
import { wrapBilibiliFetch } from './BilibiliUserAgent';
import {
  DanmakuMessage,
  DanmakuClientEvents,
  DanmakuConfig,
  CliOptions,
  CoreControlConfigDto,
  CoreControlStateSnapshot,
  LiveWsConnection,
  LiveWsRoomConfig,
  StreamerStatus,
  CoreSyncTagSnapshot,
  CoreRuntimeStateDto,
  CoreConnectionInfoDto,
  ErrorCategory,
  ClientErrorRecord,
  RecordingInfoDto,
  RecorderEventType,
  UserInfo,
} from '../types';
import { ScopedLogger, normalizeLogLevel } from './Logger';

const HEARTBEAT_MIN_INTERVAL = 2000;
const MESSAGE_QUEUE_MIN_SIZE = 100;
const MESSAGE_RETRY_MIN_DELAY = 200;
const MESSAGE_RETRY_MIN_ATTEMPTS = 1;
const MESSAGE_BATCH_MIN_SIZE = 1;
const MESSAGE_BATCH_MAX_SIZE = 500;
const MESSAGE_UPLOAD_INTERVAL_MS = 1000;
const LOCK_RETRY_MIN_COUNT = 1;
const LOCK_RETRY_MIN_DELAY = 200;
const ERROR_HISTORY_MIN_LIMIT = 10;
const ROOM_CONNECT_START_INTERVAL = 10_000;
const QUEUE_OVERFLOW_LOG_INTERVAL_MS = 10_000;
const CONTROL_SYNC_INTERVAL_MS = 5000;

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
type NormalizedCookieRuntimeConfig = {
  enabled: boolean;
  key?: string;
  password?: string;
  host: string;
  refreshInterval: number;
};
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
  private runtimeConnection?: RuntimeConnection;
  private statusManager?: StreamerStatusManager;
  private accountClient?: AccountApiClient;
  private clientId: string;
  private connections: Map<number, ConnectionInfo> = new Map();
  private holdingRoomIds: number[] = [];
  private holdingRoomRequestRefreshing = false;
  private nextHoldingRoomRequestAt = 0;
  private isRunning: boolean = false;
  private updateConnectionsTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private accountConfigRefreshing = false;
  private accountConfigTag: string | null = null;
  private assignmentTag: string | null = null;
  private clientsTag: string | null = null;
  private recordingTag: string | null = null;
  private userInfo: UserInfo | null = null;
  private remoteClients: CoreRuntimeStateDto[] = [];
  private recordings: RecordingInfoDto[] = [];
  private recordingRoomIds: number[] = [];
  private recordingSessions: Set<number> = new Set();
  private lastStreamerLiveStates: Map<number, boolean> = new Map();
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
  private messageBatchSize = 500;
  private messageUploadInterval = MESSAGE_UPLOAD_INTERVAL_MS;
  private heartbeatInterval = 5000;
  private lockAcquireRetryCount = 4;
  private lockAcquireRetryDelay = 1200;
  private lockAcquireForceTakeover = false;
  private errorHistoryLimit = 50;
  private recentErrors: ClientErrorRecord[] = [];
  private runtimeClientRegistering = false;
  private lastRuntimeClientRegisterAt = 0;
  private suppressRuntimeAutoRegister = false;
  private runtimeGeneration = 0;
  private controlSyncTimer?: ReturnType<typeof setTimeout>;
  private controlSyncRefreshing = false;

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

    if (this.runtimeConnection) {
      void this.runtimeConnection.disconnect().catch(() => undefined);
    }

    this.runtimeConnection = new RuntimeConnection(
      finalConfig.runtimeUrl,
      finalConfig.autoReconnect,
      finalConfig.reconnectInterval,
      this.buildRuntimeHeaders(finalConfig),
      this.logger.child('Runtime')
    );
    this.setupRuntimeEvents();

    if (this.statusManager) {
      this.statusManager.stop();
    }

    this.statusManager = new StreamerStatusManager(
      finalConfig.statusCheckInterval,
      finalConfig.runtimeUrl,
      finalConfig.fetchImpl,
      this.logger.child('StatusManager')
    );
    this.statusManager.updateHoldingRooms(this.holdingRoomIds);
    this.statusManager.updateRecordingRooms(this.recordingRoomIds);
    this.setupStatusManagerEvents();
  }

  /**
   * 设置Runtime事件处理
   */
  private setupRuntimeEvents(): void {
    if (!this.runtimeConnection) {
      return;
    }

    this.runtimeConnection.onConnected = () => {
      this.triggerRuntimeClientRegistration('connected');
      this.scheduleMessageDispatch(this.messageUploadInterval);
    };

    this.runtimeConnection.onReconnected = () => {
      this.triggerRuntimeClientRegistration('reconnected');
      this.scheduleMessageDispatch(this.messageUploadInterval);
    };

    this.runtimeConnection.onSessionInvalid = (reason: string) => {
      this.handleRuntimeSessionInvalid(reason);
    };
  }

  /**
   * 设置状态管理器事件处理
   */
  private setupStatusManagerEvents(): void {
    if (!this.statusManager) {
      return;
    }

    this.statusManager.onStatusUpdated = (statuses: StreamerStatus[]) => {
      this.handleStreamerStatusTransitions(statuses);
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
      this.runtimeGeneration += 1;
      this.isStopping = false;
      this.recordingSessions.clear();
      this.lastStreamerLiveStates.clear();
      this.logger.info('正在启动弹幕客户端... (v_hot_reload)');

      await this.prepareAccountConfig();
      await this.ensureCookieReadyForStartup();
      await this.acquireRuntimeLock();

      // 启动CookieManager
      if (this.cookieManager) {
        this.logger.info('启动Cookie管理器...');
        this.cookieManager.startPeriodicUpdate();
      }

      // 连接Runtime
      this.logger.info('连接到Runtime服务器...');
      const runtimeConnection = this.ensureRuntimeConnection();
      const runtimeConnected = await runtimeConnection.connect();
      if (!runtimeConnected) {
        throw new Error('无法连接到Runtime服务器');
      }

      // 首次注册前先强制同步空连接态，清理同 clientId 旧心跳残留导致的容量误判
      await this.syncRuntimeState({
        isRunning: true,
        runtimeConnected: true,
        connectedRooms: [],
        connectionInfo: [],
        holdingRooms: [],
        lastRoomAssigned: null
      }, { force: true, strict: true });

      this.isRunning = true;
      this.messageCount = 0;

      // 启动状态管理器
      this.logger.info('启动状态检查器...');
      const statusManager = this.ensureStatusManager();
      statusManager.updateHoldingRooms(this.holdingRoomIds);
      statusManager.start();
      await this.refreshHoldingRoomsIfNeeded(this.configManager.getConfig().maxConnections, 'client-register', { force: true });

      this.logger.info('弹幕客户端启动成功');
      await this.syncRuntimeState();
      this.ensureHeartbeat();
      this.scheduleMessageDispatch(this.messageUploadInterval);

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
    this.runtimeGeneration += 1;
    this.logger.info('正在停止弹幕客户端...');
    await this.flushOpenRecordingSessionsOnStop();
    this.isStopping = true;
    this.isRunning = false;

    this.resetAccountConfigSyncState();

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

    // 断开Runtime连接
    await this.runtimeConnection?.disconnect();
    this.holdingRoomIds = [];
    this.holdingRoomRequestRefreshing = false;
    this.nextHoldingRoomRequestAt = 0;
    this.statusManager?.updateHoldingRooms([]);
    this.recordingSessions.clear();
    this.lastStreamerLiveStates.clear();
    this.assignmentTag = null;
    this.messageCount = 0;
    this.lastRoomAssigned = undefined;
    this.lastError = undefined;
    this.recentErrors = [];
    this.clearMessageDispatch();
    this.clearPendingMessages();
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
    const runtimeConnected = this.runtimeConnection?.getConnectionState() ?? false;

    this.pruneOfflineHoldingRooms(statusManager);
    this.trimHoldingRoomsToCapacity(config.maxConnections);

    const roomsToConnect = statusManager.getRoomsToConnect(
      this.recordingRoomIds,
      this.holdingRoomIds,
      config.maxConnections
    );
    const currentConnections = Array.from(this.connections.keys());
    const targetRooms = roomsToConnect.map((room) => room.roomId);

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
        this.disconnectFromRoom(roomId);
      }
    }

    for (const roomConfig of roomsToConnect) {
      if (!this.connections.has(roomConfig.roomId)) {
        this.queueRoomConnect(roomConfig.roomId, roomConfig.priority);
      }
    }

    if (runtimeConnected) {
      void this.refreshHoldingRoomsIfNeeded(config.maxConnections);
    }

    void this.syncRuntimeState();
  }

  private pruneOfflineHoldingRooms(statusManager: StreamerStatusManager): void {
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

    this.holdingRoomIds = keep;
    this.statusManager?.updateHoldingRooms(this.holdingRoomIds);
    for (const roomId of removed) {
      this.removeQueuedRoomConnect(roomId);
      this.disconnectFromRoom(roomId);
    }
    if (removed.length > 0) {
      this.logger.info(`移除已下播持有房间: ${removed.join(',')}`);
    }
  }

  private trimHoldingRoomsToCapacity(maxConnections: number): void {
    const uniqueRooms = Array.from(new Set(
      this.holdingRoomIds.filter((roomId) => Number.isFinite(roomId) && roomId > 0)
    ));
    const capacity = Math.max(0, Math.min(100, Math.floor(maxConnections)));
    const targetSize = capacity;

    if (uniqueRooms.length <= targetSize) {
      if (!this.areRoomIdsEqual(uniqueRooms, this.holdingRoomIds)) {
        this.holdingRoomIds = uniqueRooms;
        this.statusManager?.updateHoldingRooms(this.holdingRoomIds);
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

    this.holdingRoomIds = keep;
    this.statusManager?.updateHoldingRooms(this.holdingRoomIds);
    for (const roomId of dropped) {
      this.removeQueuedRoomConnect(roomId);
      this.disconnectFromRoom(roomId);
    }
    if (dropped.length > 0) {
      this.logger.info(`本地持有房间超出剩余槽位，已释放: max=${targetSize}, droppedRooms=${dropped.join(',')}`);
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
      this.recordingRoomIds,
      this.holdingRoomIds,
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
    const generation = this.runtimeGeneration;

    if (this.connections.has(roomId)) {
      this.logger.warn(`房间 ${roomId} 已经连接`);
      return;
    }

    try {
      this.logger.info(`正在连接到房间 ${roomId} (优先级: ${priority})...`);

      const connectionOptions = await this.resolveLiveWsConnectionOptions(roomId);
      if (generation !== this.runtimeGeneration || !this.isRunning || this.isStopping || this.connections.has(roomId)) {
        return;
      }
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
      if (generation !== this.runtimeGeneration || !this.isRunning || this.isStopping) {
        try {
          liveWS.close();
        } catch {
          // ignore close errors for stale in-flight connection
        }
        return;
      }

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
      `房间 ${roomId} 准备获取鉴权: cookieSource=${preferredCookie?.source ?? 'none'}, uid=${uid}, buvid=${buvid ? 'present' : 'missing'}, provider=${this.liveWsConfigProvider ? 'remote' : 'builtin'}`
    );

    const options: LiveWsConnectionOptions = {
      uid,
      protover: 3
    };
    if (buvid) {
      options.buvid = buvid;
    }

    if (!this.liveWsConfigProvider) {
      return this.resolveBuiltinLiveWsConnectionOptions(roomId, options, cookie);
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

  private async resolveBuiltinLiveWsConnectionOptions(
    roomId: number,
    options: LiveWsConnectionOptions,
    cookie?: string
  ): Promise<LiveWsConnectionOptions> {
    const normalizedCookie = typeof cookie === 'string' ? cookie.trim() : '';
    if (!normalizedCookie) {
      throw new Error(`房间 ${roomId} 缺少可用 Cookie，无法获取内置鉴权信息`);
    }

    const currentConfig = this.configManager.getConfig();
    const apiClient = new BilibiliApiClient({
      cookie: normalizedCookie,
      fetch: wrapBilibiliFetch(currentConfig.fetchImpl)
    });

    const danmuInfo = await apiClient.xliveGetDanmuInfo({ id: roomId });
    const parsedConfig = parseLiveConfig(danmuInfo.data);
    const roomInit = await apiClient.liveRoomInit({ id: roomId });
    const resolvedRoomIdRaw = roomInit.data?.room_id;
    const resolvedRoomId = typeof resolvedRoomIdRaw === 'number' ? resolvedRoomIdRaw : Number(resolvedRoomIdRaw);
    if (!Number.isFinite(resolvedRoomId) || resolvedRoomId <= 0) {
      throw new Error(`房间 ${roomId} 获取内置鉴权信息失败: room_id 无效`);
    }

    return {
      ...options,
      ...parsedConfig,
      roomId: resolvedRoomId,
      uid: options.uid,
      buvid: options.buvid,
      protover: options.protover ?? 3
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
      this.markRecordingSessionStarted(roomId);
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
      const status = this.statusManager?.getStreamerStatus(roomId);
      this.markRecordingSessionClosed(
        roomId,
        status?.isLive === false ? 'record_end' : 'record_interrupt',
        status?.isLive === false ? '录制结束' : '录制中断'
      );
      this.connections.delete(roomId);
      this.emit('disconnected', roomId);
      this.statusManager?.refreshNow();

      if (connectionInfo?.priority === 'server') {
        const lifetimeMs = Date.now() - connectionInfo.connectedAt;
        if (lifetimeMs < 10_000) {
          this.holdingRoomIds = this.holdingRoomIds.filter(id => id !== roomId);
          this.statusManager?.updateHoldingRooms(this.holdingRoomIds);
        }
      }

      void this.syncRuntimeState();

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
      const serialized = JSON.stringify(value, (_key, item) => {
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
      if (typeof serialized === 'string' && serialized.length > 0) {
        return serialized;
      }
      return '[Unserializable Message]';
    } catch {
      return '[Unserializable Message]';
    }
  }

  /**
   * 处理消息
   */
  private async handleMessage(message: DanmakuMessage): Promise<void> {
    if (!this.isRunning || this.isStopping) {
      return;
    }

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

  getRecordingRoomIds(): number[] {
    return [...this.recordingRoomIds];
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
      runtimeConnected: this.runtimeConnection?.getConnectionState() ?? false,
      cookieValid: this.hasAvailableCookie(),
      streamerStatuses,
      holdingRooms: [...this.holdingRoomIds],
      recordingRoomIds: [...this.recordingRoomIds],
      messageCount: this.messageCount,
      pendingMessageCount: this.pendingMessages.length,
      recentErrors: this.recentErrors.map(item => ({ ...item })),
      lastRoomAssigned: this.lastRoomAssigned,
      lastError: this.lastError,
      lastHeartbeat: this.lastHeartbeat,
      config: this.configManager.getConfig()
    };
  }

  getControlState(): CoreControlStateSnapshot {
    return {
      userInfo: this.cloneUserInfo(this.userInfo),
      config: this.buildCoreControlConfigSnapshot(),
      recordings: this.cloneRecordingList(this.recordings),
      remoteClients: this.cloneRemoteClients(this.remoteClients),
      tags: this.buildCoreSyncTagSnapshot(),
    };
  }

  async refreshControlState(): Promise<CoreControlStateSnapshot> {
    if (!this.accountClient) {
      throw new Error('账号中心客户端尚未初始化');
    }

    await this.refreshUserInfo();
    await this.pullAccountConfig();
    await this.refreshRecordingList(true);
    await this.refreshRemoteClients(true);
    this.emitControlStateChanged();
    return this.getControlState();
  }

  async refreshRuntimeControlState(): Promise<CoreControlStateSnapshot> {
    if (!this.accountClient) {
      throw new Error('账号中心客户端尚未初始化');
    }

    await this.refreshRemoteClients(true);
    return this.getControlState();
  }

  async refreshRecordingControlState(): Promise<CoreControlStateSnapshot> {
    if (!this.accountClient) {
      throw new Error('账号中心客户端尚未初始化');
    }

    await this.refreshRecordingList(true);
    return this.getControlState();
  }

  startControlSync(): void {
    this.scheduleControlSync(0);
  }

  stopControlSync(): void {
    if (!this.controlSyncTimer) {
      return;
    }

    clearTimeout(this.controlSyncTimer);
    this.controlSyncTimer = undefined;
  }

  async saveCoreConfig(config: CoreControlConfigDto): Promise<CoreControlStateSnapshot> {
    if (!this.accountClient) {
      throw new Error('账号中心客户端尚未初始化');
    }

    const result = await this.accountClient.updateCoreConfig(config);
    await this.applyAccountConfigSnapshot(result.data, result.tags.configTag);
    this.updateSyncTags(result.tags);
    this.emitControlStateChanged();
    return this.getControlState();
  }

  async addRecording(uid: number): Promise<RecordingInfoDto> {
    if (!this.accountClient) {
      throw new Error('账号中心客户端尚未初始化');
    }

    const result = await this.accountClient.addRecording(uid);
    this.updateSyncTags(result.tags);
    await this.refreshRecordingList(true);
    return result.data;
  }

  async removeRecording(uid: number): Promise<void> {
    if (!this.accountClient) {
      throw new Error('账号中心客户端尚未初始化');
    }

    const result = await this.accountClient.removeRecording(uid);
    this.updateSyncTags(result.tags);
    await this.refreshRecordingList(true);
  }

  async updateRecordingPublic(uid: number, isPublic: boolean): Promise<void> {
    if (!this.accountClient) {
      throw new Error('账号中心客户端尚未初始化');
    }

    const result = await this.accountClient.updateRecordingSetting([
      {
        id: uid,
        setting: { isPublic },
      },
    ]);

    if (!result.data.includes(uid)) {
      throw new Error('更新录制公开状态失败');
    }

    this.updateSyncTags(result.tags);
    await this.refreshRecordingList(true);
  }

  async forceTakeoverRuntimeState(): Promise<CoreControlStateSnapshot> {
    await this.syncRuntimeState({}, { strict: true, force: true });
    await this.refreshRemoteClients(true);
    this.emitControlStateChanged();
    return this.getControlState();
  }

  private buildCoreControlConfigSnapshot(): CoreControlConfigDto {
    const config = this.configManager.getConfig();
    return {
      maxConnections: config.maxConnections,
      runtimeUrl: config.runtimeUrl,
      autoReconnect: config.autoReconnect,
      reconnectInterval: config.reconnectInterval,
      statusCheckInterval: config.statusCheckInterval,
      streamers: [],
      requestServerRooms: config.requestServerRooms ?? true,
      allowedAreas: [...(config.allowedAreas ?? [])],
      allowedParentAreas: [...(config.allowedParentAreas ?? [])],
    };
  }

  private buildCoreSyncTagSnapshot(): CoreSyncTagSnapshot {
    return {
      configTag: this.accountConfigTag,
      clientsTag: this.clientsTag,
      recordingTag: this.recordingTag,
    };
  }

  private cloneRemoteClients(remoteClients: CoreRuntimeStateDto[]): CoreRuntimeStateDto[] {
    return remoteClients.map(remote => ({
      ...remote,
      connectedRooms: [...remote.connectedRooms],
      connectionInfo: remote.connectionInfo.map(info => ({ ...info })),
      holdingRooms: [...remote.holdingRooms],
    }));
  }

  private cloneUserInfo(userInfo: UserInfo | null): UserInfo | null {
    if (!userInfo) {
      return null;
    }

    return {
      ...userInfo,
      bindedOAuth: [...userInfo.bindedOAuth],
    };
  }

  private cloneRecordingList(recordings: RecordingInfoDto[]): RecordingInfoDto[] {
    return recordings.map(item => ({
      ...item,
      channel: { ...item.channel },
      setting: { ...item.setting },
    }));
  }

  private emitControlStateChanged(): void {
    this.emit('controlStateChanged', this.getControlState());
  }

  private scheduleControlSync(delayMs: number): void {
    if (this.controlSyncTimer || !this.accountClient || this.isStopping) {
      return;
    }

    const delay = Math.max(0, Math.floor(delayMs));
    this.controlSyncTimer = setTimeout(() => {
      this.controlSyncTimer = undefined;
      void this.pollControlState();
    }, delay);
  }

  private async pollControlState(): Promise<void> {
    if (!this.accountClient || this.controlSyncRefreshing || this.isStopping) {
      return;
    }

    this.controlSyncRefreshing = true;
    try {
      if (!this.isRunning) {
        const tags = await this.accountClient.getCoreHeartbeatTags();
        await this.handleAccountConfigTagChange(tags.configTag);
        await this.handleClientsTagChange(tags.clientsTag);
        await this.handleRecordingTagChange(tags.recordingTag);
      }
    } catch (error) {
      this.recordError(error, { category: 'runtime-sync', code: 'CONTROL_SYNC_FAILED', recoverable: true });
      this.logger.warn('同步控制面板数据失败', error);
    } finally {
      this.controlSyncRefreshing = false;
      if (this.accountClient && !this.isStopping) {
        this.scheduleControlSync(CONTROL_SYNC_INTERVAL_MS);
      }
    }
  }

  private updateSyncTags(tags: CoreSyncTagSnapshot): void {
    if (tags.configTag !== null) {
      this.accountConfigTag = tags.configTag;
    }
    if (tags.clientsTag !== null) {
      this.clientsTag = tags.clientsTag;
    }
    if (tags.recordingTag !== null) {
      this.recordingTag = tags.recordingTag;
    }
  }

  private async refreshUserInfo(): Promise<void> {
    if (!this.accountClient) {
      return;
    }

    this.userInfo = this.cloneUserInfo(await this.accountClient.getUserInfo());
    this.emitControlStateChanged();
  }

  private async pullAccountConfig(): Promise<void> {
    if (!this.accountClient) {
      return;
    }

    const remoteConfig = await this.accountClient.getCoreConfig();
    await this.applyAccountConfigSnapshot(remoteConfig, this.accountClient.getCoreConfigTag());
  }

  private async refreshRemoteClients(force: boolean, nextTag: string | null = null): Promise<void> {
    if (!this.accountClient) {
      return;
    }
    if (!force && (nextTag === null || nextTag === this.clientsTag)) {
      return;
    }

    const result = await this.accountClient.getCoreClients();
    this.remoteClients = this.cloneRemoteClients(result.data);
    this.updateSyncTags(result.tags);
    if (nextTag !== null) {
      this.clientsTag = nextTag;
    }
    this.emitControlStateChanged();
  }

  private async refreshRecordingList(force: boolean, nextTag: string | null = null): Promise<void> {
    if (!this.accountClient) {
      return;
    }
    if (!force && (nextTag === null || nextTag === this.recordingTag)) {
      return;
    }

    const result = await this.accountClient.getRecordingList();
    this.recordings = this.cloneRecordingList(result.data);
    this.recordingRoomIds = this.recordings
      .map(item => Number(item.channel.roomId))
      .filter(roomId => Number.isFinite(roomId) && roomId > 0)
      .map(roomId => Math.floor(roomId));
    this.statusManager?.updateRecordingRooms(this.recordingRoomIds);
    this.updateSyncTags(result.tags);
    if (nextTag !== null) {
      this.recordingTag = nextTag;
    }
    this.emitControlStateChanged();
  }

  private ensureRuntimeConnection(): RuntimeConnection {
    if (!this.runtimeConnection) {
      throw new Error('Runtime连接尚未初始化');
    }
    return this.runtimeConnection;
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
    await this.applyAccountConfigSnapshot(remoteConfig, this.accountClient.getCoreConfigTag());
  }

  private async ensureCookieReadyForStartup(): Promise<void> {
    if (this.liveWsConfigProvider || this.hasAvailableCookie()) {
      return;
    }

    if (this.cookieManager) {
      this.logger.info('当前无可用 Cookie，正在尝试从 CookieCloud 拉取...');
      const updated = await this.cookieManager.updateCookies();
      if (updated && this.hasAvailableCookie()) {
        return;
      }

      throw new Error('CookieCloud 未返回可用的 Bilibili Cookie，无法启动弹幕客户端');
    }

    throw new Error('未提供可用的 Bilibili Cookie，无法启动弹幕客户端；请先配置本地 Cookie 或 CookieCloud');
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
      await this.heartbeatRuntimeState();
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

  private buildRuntimeStateSnapshot(): CoreRuntimeStateDto {
    const status = this.getStatus();
    const now = Date.now();

    return {
      clientId: this.clientId,
      clientVersion: status.config.clientVersion ?? 'core',
      isRunning: status.isRunning,
      runtimeConnected: status.runtimeConnected,
      cookieValid: status.cookieValid,
      connectedRooms: status.connectedRooms,
      connectionInfo: status.connectionInfo.map<CoreConnectionInfoDto>(info => ({
        roomId: info.roomId,
        priority: info.priority,
        connectedAt: new Date(info.connectedAt).toISOString()
      })),
      holdingRooms: [...this.holdingRoomIds],
      messageCount: this.messageCount,
      lastRoomAssigned: this.lastRoomAssigned ?? null,
      lastError: this.lastError ?? null,
      lastHeartbeat: new Date(this.lastHeartbeat || now).toISOString()
    };
  }

  private buildRuntimeHeartbeatPayload(): Partial<CoreRuntimeStateDto> & { clientId: string } {
    const status = this.getStatus();
    return {
      clientId: this.clientId,
      clientVersion: status.config.clientVersion ?? 'core',
      isRunning: status.isRunning,
      runtimeConnected: status.runtimeConnected,
      cookieValid: status.cookieValid,
      messageCount: status.messageCount,
      lastRoomAssigned: status.lastRoomAssigned ?? null,
      lastError: status.lastError ?? null
    };
  }

  private async heartbeatRuntimeState(options?: { force?: boolean; strict?: boolean }): Promise<void> {
    if (!this.accountClient) {
      return;
    }

    try {
      const result = await this.accountClient.heartbeatRuntimeState(this.buildRuntimeHeartbeatPayload(), {
        force: options?.force
      });
      this.lastHeartbeat = Date.now();
      await this.handleAccountConfigTagChange(result.configTag);
      await this.handleClientsTagChange(result.clientsTag);
      await this.handleRecordingTagChange(result.recordingTag);
      if (this.consumeAssignmentTag(result.assignmentTag)) {
        await this.refreshHoldingRoomsIfNeeded(this.configManager.getConfig().maxConnections, 'assignment-tag-changed', {
          force: true,
        });
        return;
      }
      await this.refreshHoldingRoomsIfNeeded(this.configManager.getConfig().maxConnections, 'heartbeat');
    } catch (error) {
      this.recordError(error, { category: 'runtime-sync', code: 'RUNTIME_HEARTBEAT_FAILED', recoverable: true });
      this.logger.warn('同步核心心跳失败', error);
      if (options?.strict) {
        throw error;
      }
    }
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

  private isHoldingRoomRequestEnabled(config: DanmakuConfig = this.configManager.getConfig()): boolean {
    return (config.requestServerRooms ?? true) && Math.max(0, Math.floor(config.maxConnections)) > 0;
  }

  private clearHoldingRooms(): void {
    if (this.holdingRoomIds.length === 0) {
      return;
    }

    const removedRooms = [...this.holdingRoomIds];
    this.holdingRoomIds = [];
    for (const roomId of removedRooms) {
      this.removeQueuedRoomConnect(roomId);
      this.disconnectFromRoom(roomId);
    }

    this.statusManager?.updateHoldingRooms([]);
    this.statusManager?.refreshNow();
    this.updateConnections();
    void this.syncRuntimeState();
  }

  private getConnectedHoldingRoomIds(): number[] {
    return Array.from(this.connections.values())
      .filter((connection) => connection.priority === 'server')
      .map((connection) => connection.roomId)
      .filter((roomId) => Number.isFinite(roomId) && roomId > 0);
  }

  private async refreshHoldingRoomsIfNeeded(
    maxConnections: number,
    reason: string = 'capacity-refresh',
    options?: { force?: boolean }
  ): Promise<boolean> {
    const runtimeConnection = this.runtimeConnection;
    if (!runtimeConnection?.getConnectionState()) {
      return false;
    }
    if (!this.isHoldingRoomRequestEnabled()) {
      this.clearHoldingRooms();
      return false;
    }
    if (this.holdingRoomRequestRefreshing || (!options?.force && Date.now() < this.nextHoldingRoomRequestAt)) {
      return false;
    }

    const config = this.configManager.getConfig();
    const overrideValue = Number(config.capacityOverride);
    const capacityOverride = Number.isFinite(overrideValue) && overrideValue > 0
      ? Math.min(100, Math.floor(overrideValue))
      : undefined;
    const capacity = Math.max(0, Math.min(Math.floor(maxConnections), capacityOverride ?? Math.floor(maxConnections), 100));
    const desiredCount = Math.max(0, capacity - this.holdingRoomIds.length);
    if (desiredCount <= 0 && !options?.force) {
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

  private applyHoldingRoomResult(result: {
    holdingRooms: number[];
    newlyAssignedRooms: number[];
    droppedRooms: number[];
    effectiveCapacity: number;
    nextRequestAfter?: number | null;
  }): void {
    const previous = Array.from(new Set(this.holdingRoomIds.filter((roomId) => Number.isFinite(roomId) && roomId > 0)));
    const next = Array.from(new Set(result.holdingRooms.filter((roomId) => Number.isFinite(roomId) && roomId > 0)));
    const removedRooms = previous.filter((roomId) => !next.includes(roomId));
    const addedRooms = next.filter((roomId) => !previous.includes(roomId));

    this.holdingRoomIds = next;
    this.nextHoldingRoomRequestAt = typeof result.nextRequestAfter === 'number' && result.nextRequestAfter > 0
      ? result.nextRequestAfter
      : 0;

    const lastAssignedRoom = addedRooms.length > 0
      ? addedRooms[addedRooms.length - 1]
      : (result.newlyAssignedRooms.length > 0 ? result.newlyAssignedRooms[result.newlyAssignedRooms.length - 1] : undefined);
    if (typeof lastAssignedRoom === 'number' && lastAssignedRoom > 0) {
      this.lastRoomAssigned = lastAssignedRoom;
    }

    for (const roomId of removedRooms) {
      this.removeQueuedRoomConnect(roomId);
      this.disconnectFromRoom(roomId);
    }

    this.statusManager?.updateHoldingRooms(this.holdingRoomIds);
    this.statusManager?.refreshNow();
    this.updateConnections();
    void this.syncRuntimeState();
  }

  private async handleAccountConfigTagChange(nextTag: string | null): Promise<void> {
    if (nextTag === null || nextTag === this.accountConfigTag) {
      return;
    }

    await this.refreshAccountConfig(nextTag);
  }

  private async handleClientsTagChange(nextTag: string | null): Promise<void> {
    if (nextTag === null || nextTag === this.clientsTag) {
      return;
    }

    await this.refreshRemoteClients(true, nextTag);
  }

  private async handleRecordingTagChange(nextTag: string | null): Promise<void> {
    if (nextTag === null || nextTag === this.recordingTag) {
      return;
    }

    await this.refreshRecordingList(true, nextTag);
  }

  private consumeAssignmentTag(nextTag: string | null): boolean {
    if (nextTag === null || nextTag === this.assignmentTag) {
      return false;
    }

    this.assignmentTag = nextTag;
    return true;
  }

  private resetAccountConfigSyncState(): void {
    this.accountConfigRefreshing = false;
    this.accountConfigTag = null;
    this.recordingRoomIds = [];
    this.statusManager?.updateRecordingRooms([]);
  }

  private handleStreamerStatusTransitions(statuses: StreamerStatus[]): void {
    const nextStates = new Map<number, boolean>();

    for (const status of statuses) {
      nextStates.set(status.roomId, status.isLive);
      const previous = this.lastStreamerLiveStates.get(status.roomId);
      if (previous === true && !status.isLive) {
        this.markRecordingSessionClosed(status.roomId, 'record_end', '录制结束');
      }
    }

    this.lastStreamerLiveStates = nextStates;
  }

  private markRecordingSessionStarted(roomId: number, timestamp: number = Date.now()): void {
    if (roomId <= 0 || this.recordingSessions.has(roomId)) {
      return;
    }

    this.recordingSessions.add(roomId);
    this.enqueueRecorderEvent(roomId, 'record_start', '录制开始', timestamp);
  }

  private markRecordingSessionClosed(
    roomId: number,
    eventType: 'record_interrupt' | 'record_end',
    eventMessage: string,
    timestamp: number = Date.now()
  ): void {
    if (roomId <= 0 || !this.recordingSessions.has(roomId)) {
      return;
    }

    this.recordingSessions.delete(roomId);
    this.enqueueRecorderEvent(roomId, eventType, eventMessage, timestamp);
  }

  private enqueueRecorderEvent(
    roomId: number,
    eventType: RecorderEventType,
    eventMessage: string,
    timestamp: number = Date.now()
  ): void {
    const message: DanmakuMessage = {
      roomId,
      cmd: `__${eventType.toUpperCase()}__`,
      data: undefined,
      raw: '',
      timestamp,
      recorderEventType: eventType,
      recorderEventMessage: eventMessage
    };

    this.enqueueMessage(message);
  }

  private async flushOpenRecordingSessionsOnStop(): Promise<void> {
    if (!this.isRunning || this.recordingSessions.size === 0) {
      return;
    }

    for (const roomId of Array.from(this.recordingSessions)) {
      this.markRecordingSessionClosed(roomId, 'record_interrupt', '录制中断');
    }

    if (!this.runtimeConnection?.getConnectionState()) {
      return;
    }

    const maxFlushRounds = Math.max(1, Math.ceil(this.pendingMessages.length / this.messageBatchSize) + 1);
    for (let i = 0; i < maxFlushRounds; i++) {
      if (this.pendingMessages.length === 0) {
        break;
      }

      await this.flushPendingMessages();
    }
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
      this.releaseQueuedMessage(dropped);
    }

    const queuedMessage: DanmakuMessage = {
      roomId: message.roomId,
      cmd: message.cmd,
      // 队列上行仅依赖 roomId/raw/timestamp，避免长时间持有原始 data 树导致内存上涨。
      data: undefined,
      raw: message.raw,
      timestamp: message.timestamp,
      recorderEventType: message.recorderEventType,
      recorderEventMessage: message.recorderEventMessage
    };

    this.pendingMessages.push({
      message: queuedMessage,
      retryCount: 0,
      nextRetryAt: Date.now()
    });
    this.emitQueueChanged();
    this.scheduleMessageDispatch(this.messageUploadInterval);
  }

  private releaseQueuedMessage(queued?: QueuedMessage): void {
    if (!queued) {
      return;
    }

    queued.message.raw = '';
    queued.message.data = undefined;
  }

  private clearPendingMessages(): void {
    for (const queued of this.pendingMessages) {
      this.releaseQueuedMessage(queued);
    }
    this.pendingMessages = [];
    this.emitQueueChanged();
  }

  private emitQueueChanged(): void {
    this.emit('queueChanged', this.pendingMessages.length);
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
    if (this.pendingMessages.length === 0) {
      if (this.messageDispatchTimer) {
        clearTimeout(this.messageDispatchTimer);
        this.messageDispatchTimer = undefined;
      }
      return;
    }

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
      if (this.pendingMessages.length === 0) {
        return;
      }

      const now = Date.now();
      const queued = this.pendingMessages[0];

      if (queued.nextRetryAt > now) {
        this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, queued.nextRetryAt - now));
        return;
      }

      const runtimeConnection = this.runtimeConnection;
      if (!runtimeConnection?.getConnectionState()) {
        this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, this.messageRetryBaseDelay));
        return;
      }

      const batch: QueuedMessage[] = [];
      for (const item of this.pendingMessages) {
        if (item.nextRetryAt > now || batch.length >= this.messageBatchSize) {
          break;
        }
        batch.push(item);
      }
      if (batch.length === 0) {
        this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, this.messageRetryBaseDelay));
        return;
      }

      const sentCount = await runtimeConnection.sendMessages(batch.map(item => item.message));
      if (sentCount > 0) {
        const sentMessages = this.pendingMessages.splice(0, sentCount);
        for (const sent of sentMessages) {
          this.releaseQueuedMessage(sent);
        }
        this.emitQueueChanged();
        return;
      }

      const failed = this.pendingMessages[0];
      failed.retryCount += 1;
      if (failed.retryCount >= this.messageRetryMaxAttempts) {
        const dropped = this.pendingMessages.shift();
        if (!dropped) {
          return;
        }
        const { roomId, cmd } = dropped.message;
        const sendError = new Error(
          `消息上行失败: room=${roomId}, cmd=${cmd}, retry=${dropped.retryCount}`
        );
        this.recordError(sendError, {
          category: 'runtime',
          code: 'MESSAGE_UPLOAD_FAILED',
          roomId,
          recoverable: false
        });
        this.emit('error', sendError, roomId);
        this.releaseQueuedMessage(dropped);
        this.emitQueueChanged();
        return;
      }

      const delay = this.calculateMessageRetryDelay(failed.retryCount);
      failed.nextRetryAt = now + delay;
      this.logger.warn(
        `消息上行失败，${delay}ms 后重试 (room=${failed.message.roomId}, cmd=${failed.message.cmd}, retry=${failed.retryCount})`
      );
      this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, delay));
      return;
    } finally {
      this.messageDispatching = false;
      if (this.pendingMessages.length > 0 && !this.messageDispatchTimer && this.isRunning && !this.isStopping) {
        this.scheduleMessageDispatch(this.messageUploadInterval);
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
    if (this.pendingMessages.length > this.messageQueueMaxSize) {
      const overflowCount = this.pendingMessages.length - this.messageQueueMaxSize;
      const dropped = this.pendingMessages.splice(0, overflowCount);
      for (const item of dropped) {
        this.releaseQueuedMessage(item);
      }
      this.emitQueueChanged();
      this.logger.warn(`消息队列容量调整后丢弃 ${overflowCount} 条待发送消息`);
    }

    const retryBaseDelay = Math.floor(config.messageRetryBaseDelay ?? 1000);
    this.messageRetryBaseDelay = Math.max(MESSAGE_RETRY_MIN_DELAY, retryBaseDelay);

    const retryMaxDelay = Math.floor(config.messageRetryMaxDelay ?? 30_000);
    this.messageRetryMaxDelay = Math.max(this.messageRetryBaseDelay, retryMaxDelay);

    const retryMaxAttempts = Math.floor(config.messageRetryMaxAttempts ?? 6);
    this.messageRetryMaxAttempts = Math.max(MESSAGE_RETRY_MIN_ATTEMPTS, retryMaxAttempts);

    const batchSize = Math.floor(config.batchUploadSize ?? 500);
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

  private async refreshAccountConfig(nextTag: string): Promise<void> {
    if (!this.accountClient || this.accountConfigRefreshing || this.isStopping) {
      return;
    }

    this.accountConfigRefreshing = true;
    try {
      const remoteConfig = await this.accountClient.getCoreConfig();
      await this.applyAccountConfigSnapshot(remoteConfig, this.accountClient.getCoreConfigTag() ?? nextTag);
    } catch (error) {
      this.recordError(error, { category: 'config', code: 'HOT_RELOAD_FAILED', recoverable: true });
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.accountConfigRefreshing = false;
    }
  }

  private async applyAccountConfigSnapshot(remoteConfig: CoreControlConfigDto, nextTag: string | null): Promise<void> {
    const previousConfig = this.configManager.getConfig();
    this.configManager.applyAccountConfig(remoteConfig);
    this.configManager.validate();
    const nextConfig = this.configManager.getConfig();
    this.accountConfigTag = nextTag;

    if (!this.isRunning) {
      this.applyRuntimeTunings(nextConfig);
      this.initializeManagers();
      this.emitControlStateChanged();
      return;
    }

    if (!this.hasHotConfigChanges(previousConfig, nextConfig)) {
      this.emitControlStateChanged();
      return;
    }

    try {
      await this.applyHotConfigChanges(previousConfig, nextConfig);
      this.emitControlStateChanged();
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
      throw error;
    }
  }

  private hasHotConfigChanges(previous: DanmakuConfig, next: DanmakuConfig): boolean {
    const previousCookie = this.normalizeCookieRuntimeConfig(previous);
    const nextCookie = this.normalizeCookieRuntimeConfig(next);
    const cookieConfigChanged = this.hasCookieConfigChanged(previousCookie, nextCookie);

    return previous.maxConnections !== next.maxConnections
      || previous.runtimeUrl !== next.runtimeUrl
      || previous.autoReconnect !== next.autoReconnect
      || previous.reconnectInterval !== next.reconnectInterval
      || previous.statusCheckInterval !== next.statusCheckInterval
      || cookieConfigChanged
      || previous.requestServerRooms !== next.requestServerRooms
      || normalizeLogLevel(previous.logLevel, 'info') !== normalizeLogLevel(next.logLevel, 'info')
      || (previous.messageQueueMaxSize ?? 2000) !== (next.messageQueueMaxSize ?? 2000)
      || (previous.messageRetryBaseDelay ?? 1000) !== (next.messageRetryBaseDelay ?? 1000)
      || (previous.messageRetryMaxDelay ?? 30000) !== (next.messageRetryMaxDelay ?? 30000)
      || (previous.messageRetryMaxAttempts ?? 6) !== (next.messageRetryMaxAttempts ?? 6)
      || (previous.batchUploadSize ?? 500) !== (next.batchUploadSize ?? 500)
      || (previous.heartbeatInterval ?? 5000) !== (next.heartbeatInterval ?? 5000)
      || (previous.lockAcquireRetryCount ?? 4) !== (next.lockAcquireRetryCount ?? 4)
      || (previous.lockAcquireRetryDelay ?? 1200) !== (next.lockAcquireRetryDelay ?? 1200)
      || (previous.lockAcquireForceTakeover ?? false) !== (next.lockAcquireForceTakeover ?? false)
      || (previous.errorHistoryLimit ?? 50) !== (next.errorHistoryLimit ?? 50)
      || !this.areHeadersEqual(previous.runtimeHeaders, next.runtimeHeaders);
  }

  private async applyHotConfigChanges(previous: DanmakuConfig, next: DanmakuConfig): Promise<void> {
    this.applyRuntimeTunings(next);

    const statusManagerChanged = previous.statusCheckInterval !== next.statusCheckInterval
      || previous.runtimeUrl !== next.runtimeUrl;
    const runtimeChanged = previous.runtimeUrl !== next.runtimeUrl
      || previous.autoReconnect !== next.autoReconnect
      || previous.reconnectInterval !== next.reconnectInterval
      || !this.areHeadersEqual(previous.runtimeHeaders, next.runtimeHeaders);
    const previousCookie = this.normalizeCookieRuntimeConfig(previous);
    const nextCookie = this.normalizeCookieRuntimeConfig(next);
    const cookieChanged = this.hasCookieConfigChanged(previousCookie, nextCookie);

    if (cookieChanged) {
      this.rebuildCookieManager(next);
    }

    if (statusManagerChanged) {
      this.rebuildStatusManager(next);
    }

    if (runtimeChanged) {
      await this.rebuildRuntimeConnection(next);
    }

    if (
      statusManagerChanged
      || runtimeChanged
      || previous.maxConnections !== next.maxConnections
      || previous.requestServerRooms !== next.requestServerRooms
    ) {
      this.updateConnections();
    }

    if (!this.isHoldingRoomRequestEnabled(next)) {
      this.clearHoldingRooms();
    }

    this.logger.info('账号配置热更新已应用', {
      runtimeChanged,
      statusManagerChanged,
      cookieChanged,
      maxConnections: next.maxConnections,
      reconnectInterval: next.reconnectInterval,
      statusCheckInterval: next.statusCheckInterval
    });
  }

  private rebuildCookieManager(config: DanmakuConfig): void {
    const normalized = this.normalizeCookieRuntimeConfig(config);
    this.cookieManager?.stopPeriodicUpdate();
    this.cookieManager = normalized.enabled
      ? new CookieManager(
        normalized.key!,
        normalized.password!,
        normalized.host,
        normalized.refreshInterval,
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
      config.runtimeUrl,
      config.fetchImpl,
      this.logger.child('StatusManager')
    );
    this.statusManager.updateHoldingRooms(this.holdingRoomIds);
    this.statusManager.updateRecordingRooms(this.recordingRoomIds);
    this.setupStatusManagerEvents();
    if (this.isRunning && !this.isStopping) {
      this.statusManager.start();
    }
  }

  private async rebuildRuntimeConnection(config: DanmakuConfig): Promise<void> {
    if (this.runtimeConnection) {
      this.runtimeConnection.onConnected = undefined;
      this.runtimeConnection.onDisconnected = undefined;
      this.runtimeConnection.onReconnected = undefined;
      this.runtimeConnection.onSessionInvalid = undefined;
      await this.runtimeConnection.disconnect();
    }

    this.runtimeConnection = new RuntimeConnection(
      config.runtimeUrl,
      config.autoReconnect,
      config.reconnectInterval,
      this.buildRuntimeHeaders(config),
      this.logger.child('Runtime')
    );
    this.setupRuntimeEvents();

    if (!this.isRunning || this.isStopping) {
      return;
    }

    this.suppressRuntimeAutoRegister = true;
    try {
      const connected = await this.runtimeConnection.connect();
      if (!connected) {
        throw new Error('配置热更新后无法连接Runtime');
      }

      const refreshed = await this.refreshHoldingRoomsIfNeeded(config.maxConnections, 'runtime-rebuild', { force: true });
      if (!refreshed) {
        this.clearHoldingRooms();
      }
    } finally {
      this.suppressRuntimeAutoRegister = false;
    }

    this.updateConnections();
    void this.syncRuntimeState();
    this.scheduleMessageDispatch(this.messageUploadInterval);
  }

  private triggerRuntimeClientRegistration(reason: 'connected' | 'reconnected'): void {
    if (!this.isRunning || this.isStopping || this.suppressRuntimeAutoRegister) {
      return;
    }

    const now = Date.now();
    if (this.runtimeClientRegistering || now - this.lastRuntimeClientRegisterAt < 1000) {
      return;
    }

    this.runtimeClientRegistering = true;
    this.lastRuntimeClientRegisterAt = now;
    this.logger.info(`Runtime ${reason} 后重新注册客户端`);
    void this.reRegisterRuntimeClient().finally(() => {
      this.runtimeClientRegistering = false;
    });
  }

  private handleRuntimeSessionInvalid(reason: string): void {
    if (!this.isRunning || this.isStopping) {
      return;
    }

    this.logger.warn(`检测到 Runtime 会话失效，准备重新注册客户端: ${reason}`);
    this.triggerRuntimeClientRegistration('reconnected');
  }

  private async reRegisterRuntimeClient(): Promise<void> {
    const runtimeConnection = this.runtimeConnection;
    if (!runtimeConnection?.getConnectionState()) {
      return;
    }

    const refreshed = await this.refreshHoldingRoomsIfNeeded(this.configManager.getConfig().maxConnections, 'runtime-reconnect', { force: true });
    if (!refreshed) {
      this.clearHoldingRooms();
    }
    this.updateConnections();
    void this.syncRuntimeState();
  }

  private normalizeCookieSecret(value?: string): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeCookieHost(host?: string): string {
    const fallback = 'https://cookie.danmakus.com';
    if (typeof host !== 'string') {
      return fallback;
    }
    const trimmed = host.trim();
    if (!trimmed) {
      return fallback;
    }
    return trimmed.replace(/\/+$/, '');
  }

  private normalizeCookieRuntimeConfig(config: DanmakuConfig): NormalizedCookieRuntimeConfig {
    const key = this.normalizeCookieSecret(config.cookieCloudKey);
    const password = this.normalizeCookieSecret(config.cookieCloudPassword);
    const refreshRaw = Number(config.cookieRefreshInterval ?? 3600);
    const refreshInterval = Number.isFinite(refreshRaw) && refreshRaw > 0
      ? Math.max(60, Math.floor(refreshRaw))
      : 3600;
    return {
      enabled: !!(key && password),
      key,
      password,
      host: this.normalizeCookieHost(config.cookieCloudHost),
      refreshInterval
    };
  }

  private hasCookieConfigChanged(
    previous: NormalizedCookieRuntimeConfig,
    next: NormalizedCookieRuntimeConfig
  ): boolean {
    if (previous.enabled !== next.enabled) {
      return true;
    }
    if (!next.enabled) {
      return false;
    }

    return previous.key !== next.key
      || previous.password !== next.password
      || previous.host !== next.host
      || previous.refreshInterval !== next.refreshInterval;
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

  private buildRuntimeHeaders(config: DanmakuConfig): Record<string, string> | undefined {
    const headers = { ...(config.runtimeHeaders ?? {}) };
    const token = typeof config.accountToken === 'string' ? config.accountToken.trim() : '';
    const clientId = typeof this.clientId === 'string' ? this.clientId.trim() : '';

    if (!headers.Token && token) {
      headers.Token = token;
    }

    if (!headers.ClientId && clientId) {
      headers.ClientId = clientId;
    }

    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private areRoomIdsEqual(left: number[], right: number[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((roomId, index) => roomId === right[index]);
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
      case 'runtime':
        return 'RUNTIME_ERROR';
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



