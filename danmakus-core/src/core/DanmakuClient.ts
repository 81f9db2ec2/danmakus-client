import { EventEmitter } from 'eventemitter3';
import { LiveWS } from '@laplace.live/ws/client';
import { AuthManager } from './AuthManager.js';
import { BilibiliLiveWsAuthApi } from './BilibiliLiveWsAuthApi.js';
import { ConfigManager } from './ConfigManager.js';
import { RuntimeConnection } from './RuntimeConnection.js';
import { StreamerStatusManager } from './StreamerStatusManager.js';
import { AccountApiClient } from './AccountApiClient.js';
import { readCookieValue } from './BilibiliCookie.js';
import { DanmakuMessageQueue } from './DanmakuMessageQueue.js';
import { DanmakuRuntimeSync } from './DanmakuRuntimeSync.js';
import { DanmakuHoldingRoomCoordinator } from './DanmakuHoldingRoomCoordinator.js';
import { DanmakuControlState } from './DanmakuControlState.js';
import { createInMemoryLiveSessionOutbox } from './InMemoryLiveSessionOutbox.js';
import { createWireRawLiveWsConnection } from './WireRawLiveWsConnection.js';
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
  RuntimeRoomPullShortfallDto,
  UserInfo,
} from '../types/index.js';
import { ScopedLogger, normalizeLogLevel } from './Logger.js';

const ERROR_HISTORY_MIN_LIMIT = 10;
const ROOM_CONNECT_START_INTERVAL = 10_000;
const ACTIVE_RUNTIME_ERROR_RETENTION_MS = 5 * 60 * 1000;
const LIVEWS_CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

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
  resolvedRoomId: number;
  priority: 'high' | 'normal' | 'low' | 'server';
  connectedAt: number;
}

interface ClientErrorContext {
  category?: ErrorCategory;
  code?: string;
  recoverable?: boolean;
  roomId?: number;
}

type CookieSource = 'local' | 'cookieCloud';
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
  fallbackAddresses?: string[];
  tcpPort?: number;
  fallbackTcpPorts?: Array<number | undefined>;
  key?: string;
  uid?: number;
  buvid?: string;
  protover?: 1 | 2 | 3;
};

export class DanmakuClient extends EventEmitter<DanmakuClientEvents> {
  private logger: ScopedLogger;
  private configManager: ConfigManager;
  private authManager!: AuthManager;
  private bilibiliLiveWsAuthApi!: BilibiliLiveWsAuthApi;
  private baseLocalCookieProvider?: () => string | null | undefined;
  private interactiveLoginProvider?: () => Promise<string | null | undefined>;
  private ephemeralLocalCookie = '';
  private liveWsConfigProvider?: (roomId: number) => Promise<LiveWsRoomConfig | null | undefined>;
  private liveWsConnectionFactory?: (roomId: number, options: LiveWsRoomConfig) => Promise<LiveWsConnection>;
  private runtimeConnection?: RuntimeConnection;
  private statusManager?: StreamerStatusManager;
  private accountClient?: AccountApiClient;
  private clientId: string;
  private connections: Map<number, ConnectionInfo> = new Map();
  private holdingRoomCoordinator: DanmakuHoldingRoomCoordinator;
  private controlState: DanmakuControlState;
  private isRunning: boolean = false;
  private updateConnectionsTimer?: ReturnType<typeof setTimeout>;
  private accountConfigTag: string | null = null;
  private assignmentTag: string | null = null;
  private clientsTag: string | null = null;
  private recordingTag: string | null = null;
  private runtimeLockConflictStopping = false;
  private userInfo: UserInfo | null = null;
  private remoteClients: CoreRuntimeStateDto[] = [];
  private recordings: RecordingInfoDto[] = [];
  private recordingRoomIds: number[] = [];
  private messageQueue: DanmakuMessageQueue;
  private readonly fallbackLiveSessionOutbox = createInMemoryLiveSessionOutbox();
  private isStopping = false;
  private messageCount = 0;
  private activeError: ClientErrorRecord | null = null;
  private runtimeSync: DanmakuRuntimeSync;
  private roomConnectStartInterval = ROOM_CONNECT_START_INTERVAL;
  private errorHistoryLimit = 50;
  private recentErrors: ClientErrorRecord[] = [];
  private suppressRuntimeAutoRegister = false;
  private runtimeGeneration = 0;

  get holdingRoomIds(): number[] {
    return this.holdingRoomCoordinator.getHoldingRoomIds();
  }

  set holdingRoomIds(value: number[]) {
    this.holdingRoomCoordinator.replaceHoldingRoomIds(value);
  }

  get nextHoldingRoomRequestAt(): number {
    return this.holdingRoomCoordinator.getNextHoldingRoomRequestAt();
  }

  set nextHoldingRoomRequestAt(value: number) {
    this.holdingRoomCoordinator.setNextHoldingRoomRequestAt(value);
  }

  constructor(config: Partial<DanmakuConfig> = {}) {
    super();

    this.logger = new ScopedLogger('DanmakuClient', normalizeLogLevel(config.logLevel, 'info'));
    this.clientId = config.clientId || generateClientId();
    this.baseLocalCookieProvider = config.cookieProvider;
    this.interactiveLoginProvider = config.interactiveLoginProvider;
    this.liveWsConfigProvider = config.liveWsConfigProvider;
    this.liveWsConnectionFactory = config.liveWsConnectionFactory;
    this.messageQueue = new DanmakuMessageQueue({
      isRunning: () => this.isRunning,
      isStopping: () => this.isStopping,
      getRuntimeConnection: () => this.runtimeConnection,
      getLiveSessionOutbox: () => this.configManager.getConfig().liveSessionOutbox ?? this.fallbackLiveSessionOutbox,
      resolveRecordingStreamerUid: (roomId) => this.resolveRoomStreamerUid(roomId),
      logger: this.logger.child('Queue'),
      recordError: (error, context) => this.recordError(error, context),
      emitError: (error, roomId) => {
        this.emit('error', error, roomId);
      },
      emitQueueChanged: (pendingCount) => {
        this.emit('queueChanged', pendingCount);
      },
    });
    this.runtimeSync = new DanmakuRuntimeSync({
      getAccountClient: () => this.accountClient,
      getRuntimeConnection: () => this.runtimeConnection,
      getConfig: () => this.configManager.getConfig(),
      getClientId: () => this.clientId,
      isRunning: () => this.isRunning,
      isStopping: () => this.isStopping,
      isAutoRegisterSuppressed: () => this.suppressRuntimeAutoRegister,
      logger: this.logger.child('RuntimeSync'),
      recordError: (error, context) => this.recordError(error, context),
      clearError: (codes) => this.clearActiveError({ codes }),
      buildRuntimeStateSnapshot: () => this.buildRuntimeStateSnapshot(),
      buildRuntimeHeartbeatPayload: () => this.buildRuntimeHeartbeatPayload(),
      handleHeartbeatResult: (result) => this.handleRuntimeHeartbeatResult(result),
      handleRuntimeLockConflict: (reason) => this.handleRuntimeLockConflict(reason),
      refreshHoldingRoomsIfNeeded: (maxConnections, reason, options) => this.refreshHoldingRoomsIfNeeded(maxConnections, reason, options),
      updateConnections: () => this.updateConnections(),
    });
    this.holdingRoomCoordinator = new DanmakuHoldingRoomCoordinator({
      isRunning: () => this.isRunning,
      isStopping: () => this.isStopping,
      getConfig: () => this.configManager.getConfig(),
      getRuntimeConnection: () => this.runtimeConnection,
      getStatusManager: () => this.statusManager,
      getRecordingRoomIds: () => this.recordingRoomIds,
      getConnections: () => this.connections,
      disconnectFromRoom: (roomId) => this.disconnectFromRoom(roomId),
      connectToRoom: (roomId, priority) => this.connectToRoom(roomId, priority),
      updateConnections: () => this.updateConnections(),
      syncRuntimeState: () => {
        void this.syncRuntimeState();
      },
      refreshStatusNow: () => {
        this.statusManager?.refreshNow();
      },
      updateHoldingRooms: (roomIds) => {
        this.statusManager?.updateHoldingRooms(roomIds);
      },
      getRoomConnectStartInterval: () => this.roomConnectStartInterval,
      notifyStatusChanged: () => {
        this.emitStatusChanged();
      },
      logger: this.logger.child('HoldingRooms'),
    });
    this.controlState = new DanmakuControlState({
      requireAccountClient: () => this.ensureAccountClient(),
      getOptionalAccountClient: () => this.accountClient,
      isRunning: () => this.isRunning,
      isStopping: () => this.isStopping,
      logger: this.logger.child('ControlState'),
      emitError: (error) => {
        this.emit('error', error);
      },
      emitControlStateChanged: () => this.emitControlStateChanged(),
      getControlState: () => this.getControlState(),
      applyAccountConfigSnapshot: (remoteConfig, nextTag) => this.applyAccountConfigSnapshot(remoteConfig, nextTag),
      recordError: (error, context) => this.recordError(error, context),
      syncRuntimeState: (overrides, options) => this.syncRuntimeState(overrides, options),
      refreshHoldingRoomsIfNeeded: (maxConnections, reason, options) => this.refreshHoldingRoomsIfNeeded(maxConnections, reason, options),
      updateConnections: () => this.updateConnections(),
      refreshStatusNow: () => {
        this.statusManager?.refreshNow();
      },
      replaceUserInfo: (userInfo) => {
        this.replaceUserInfo(userInfo);
      },
      replaceRemoteClients: (remoteClients) => {
        this.replaceRemoteClients(remoteClients);
      },
      replaceRecordings: (recordings) => {
        this.replaceRecordings(recordings);
      },
      getRecordingRoomIds: () => this.recordingRoomIds,
      getAccountConfigTag: () => this.accountConfigTag,
      getClientsTag: () => this.clientsTag,
      getRecordingTag: () => this.recordingTag,
      updateSyncTags: (tags) => {
        this.updateControlSyncTags(tags);
      },
      areRoomIdsEqual: (left, right) => this.areRoomIdsEqual(left, right),
    });

    this.configManager = new ConfigManager({
      ...config,
      clientId: this.clientId
    });
    this.configManager.validate();
    this.applyRuntimeTunings(this.configManager.getConfig());

    if (config.accountToken) {
      this.accountClient = new AccountApiClient(
        config.accountToken,
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
    this.rebuildAuthManager(finalConfig);
    this.rebuildLiveWsAuthApi(finalConfig);

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
    this.statusManager.updateHoldingRooms(this.holdingRoomCoordinator.getHoldingRoomIds());
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
      this.messageQueue.scheduleMessageDispatch(0);
      this.triggerRuntimeClientRegistration('connected');
    };

    this.runtimeConnection.onReconnected = () => {
      this.messageQueue.scheduleMessageDispatch(0);
      this.triggerRuntimeClientRegistration('reconnected');
    };

    this.runtimeConnection.onDisconnected = (error?: Error) => {
      if (!this.isRunning || this.isStopping) {
        return;
      }

      this.logger.warn('Runtime 连接已断开，保留当前录制并等待恢复', error);
      this.updateConnections();
      void this.syncRuntimeState();
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
      this.messageQueue.clearRecentMessageDedup();
      this.logger.info('正在启动弹幕客户端...');

      await this.prepareAccountConfig();
      this.logger.info('正在校验 Cookie 状态...');
      await this.ensureCookieReadyForStartup();
      await this.messageQueue.refreshArchiveStats();
      this.logger.info('正在获取核心运行锁...');
      await this.acquireRuntimeLock();

      // 连接Runtime
      this.logger.info('连接到Runtime服务器...');
      const runtimeConnection = this.ensureRuntimeConnection();
      const runtimeConnected = await runtimeConnection.connect();
      if (!runtimeConnected) {
        throw new Error('无法连接到Runtime服务器');
      }

      // 首次注册前同步空连接态，清理同 clientId 旧心跳残留导致的容量误判
      await this.syncRuntimeState({
        isRunning: true,
        runtimeConnected: true,
        connectedRooms: [],
        connectionInfo: [],
        holdingRooms: [],
        lastRoomAssigned: null,
        holdingRoomShortfall: null,
      }, { strict: true });

      this.isRunning = true;
      this.messageCount = 0;

      // 启动状态管理器
      this.logger.info('启动状态检查器...');
      const statusManager = this.ensureStatusManager();
      statusManager.updateHoldingRooms(this.holdingRoomCoordinator.getHoldingRoomIds());
      statusManager.start();
      await this.refreshHoldingRoomsIfNeeded(this.configManager.getConfig().maxConnections, 'client-register', { force: true });

      this.logger.info('弹幕客户端启动成功');
      await this.syncRuntimeState();
      this.ensureHeartbeat();
      this.messageQueue.scheduleMessageDispatch(0);

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
  async stop(options?: { suppressReleaseErrors?: boolean; skipRuntimeRelease?: boolean; }): Promise<void> {
    this.runtimeGeneration += 1;
    this.logger.info('正在停止弹幕客户端...');
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

    // 断开Runtime连接
    await this.runtimeConnection?.disconnect();
    this.holdingRoomCoordinator.resetState();
    this.statusManager?.updateHoldingRooms([]);
    this.assignmentTag = null;
    this.messageCount = 0;
    this.activeError = null;
    this.recentErrors = [];
    this.messageQueue.resetState();
    this.clearHeartbeat();
    if (!options?.skipRuntimeRelease) {
      await this.syncRuntimeState();
    }
    if (this.accountClient && !options?.skipRuntimeRelease) {
      try {
        await this.accountClient.releaseRuntimeState(this.clientId, { force: true });
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
    this.holdingRoomCoordinator.applyConnectionsUpdate();
  }




  private removeQueuedRoomConnect(roomId: number): void {
    this.holdingRoomCoordinator.removeQueuedRoomConnect(roomId);
  }

  private clearQueuedRoomConnects(): void {
    this.holdingRoomCoordinator.clearQueuedRoomConnects();
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
      if (
        generation !== this.runtimeGeneration
        || !this.isRunning
        || this.isStopping
        || this.connections.has(roomId)
        || !this.isRoomStillDesired(roomId)
      ) {
        return;
      }
      const targetRoomId = typeof connectionOptions.roomId === 'number' && connectionOptions.roomId > 0
        ? connectionOptions.roomId
        : roomId;
      const duplicateConnection = this.findConnectionByResolvedRoomId(targetRoomId, roomId);
      if (duplicateConnection) {
        this.logger.warn(
          `房间 ${roomId} 解析到实际房间 ${targetRoomId}，但该房间已由 ${duplicateConnection.roomId} 占用，跳过重复连接`
        );
        return;
      }
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
        fallbackAddresses: liveOptions.fallbackAddresses,
        tcpPort: liveOptions.tcpPort,
        fallbackTcpPorts: liveOptions.fallbackTcpPorts,
        key: liveOptions.key ?? '',
        uid: liveOptions.uid,
        buvid: liveOptions.buvid,
        protover: liveOptions.protover,
        roomId: targetRoomId
      };
      const { liveWS, awaitedOpen } = await this.createLiveWsConnection(targetRoomId, roomConfig);
      if (
        generation !== this.runtimeGeneration
        || !this.isRunning
        || this.isStopping
        || !this.isRoomStillDesired(roomId)
      ) {
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
        resolvedRoomId: targetRoomId,
        priority,
        connectedAt: Date.now()
      };

      this.connections.set(roomId, connectionInfo);
      this.emit('connected', roomId);
      void this.syncRuntimeState();

      this.logger.info(`房间 ${roomId} 连接已创建 (ws room=${targetRoomId})`);
      if (awaitedOpen) {
        this.logger.info(`房间 ${roomId} WebSocket连接已建立`);
      }

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

    const resolved = await this.bilibiliLiveWsAuthApi.getRoomConfig(roomId, normalizedCookie);

    return {
      ...options,
      ...resolved,
      uid: typeof resolved.uid === 'number' && resolved.uid > 0 ? resolved.uid : options.uid,
      buvid: resolved.buvid ?? options.buvid,
      protover: resolved.protover ?? options.protover ?? 3
    };
  }

  private async createLiveWsConnection(
    roomId: number,
    roomConfig: LiveWsRoomConfig
  ): Promise<{ liveWS: LiveWsConnection; awaitedOpen: boolean; }> {
    const addresses = this.normalizeLiveWsAddresses(roomConfig.address, roomConfig.fallbackAddresses);
    const fallbackTcpPorts = Array.isArray(roomConfig.fallbackTcpPorts) ? roomConfig.fallbackTcpPorts : [];
    let lastError: unknown = null;

    for (let index = 0; index < addresses.length; index += 1) {
      const address = addresses[index]!;
      const attemptConfig: LiveWsRoomConfig = {
        ...roomConfig,
        address,
        tcpPort: index === 0 ? roomConfig.tcpPort : fallbackTcpPorts[index - 1],
      };

      try {
        const liveWS = this.liveWsConnectionFactory
          ? await this.liveWsConnectionFactory(roomId, attemptConfig)
          : createWireRawLiveWsConnection(new LiveWS(roomId, attemptConfig));

        try {
          if (!this.liveWsConnectionFactory && addresses.length > 1) {
            await this.waitForLiveWsReady(liveWS, roomId, address);
          }
        } catch (error) {
          try {
            liveWS.close();
          } catch {
            // ignore close errors for failed attempts
          }
          throw error;
        }

        if (index > 0) {
          this.logger.warn(`房间 ${roomId} 已回退到备用 WebSocket 地址: ${address}`);
        }

        return {
          liveWS,
          awaitedOpen: !this.liveWsConnectionFactory && addresses.length > 1,
        };
      } catch (error) {
        lastError = error;
        if (index >= addresses.length - 1) {
          break;
        }

        this.logger.warn(`房间 ${roomId} WebSocket 地址连接失败，准备回退到下一个地址: ${address}`);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`房间 ${roomId} WebSocket 连接失败`);
  }

  private normalizeLiveWsAddresses(primaryAddress?: string, fallbackAddresses?: string[]): string[] {
    const normalized = [primaryAddress, ...(fallbackAddresses ?? [])]
      .filter((address): address is string => typeof address === 'string' && address.trim().length > 0)
      .map((address) => address.trim());

    return normalized.filter((address, index) => normalized.indexOf(address) === index);
  }

  private async waitForLiveWsReady(
    liveWS: LiveWsConnection,
    roomId: number,
    address: string
  ): Promise<void> {
    const target = liveWS as LiveWsConnection & {
      removeEventListener?: (type: string, listener: (event?: any) => void) => void;
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeoutHandle);
        target.removeEventListener?.('open', handleReady);
        target.removeEventListener?.('live', handleReady);
        target.removeEventListener?.('error', handleError);
        target.removeEventListener?.('close', handleClose);
      };
      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const rejectOnce = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const handleReady = () => resolveOnce();
      const handleError = (event?: any) => {
        rejectOnce(event?.error ?? new Error(`房间 ${roomId} WebSocket 地址连接失败: ${address}`));
      };
      const handleClose = (event?: any) => {
        const code = typeof event?.code === 'number' ? event.code : -1;
        const reason = typeof event?.reason === 'string' && event.reason
          ? `, reason=${event.reason}`
          : '';
        rejectOnce(new Error(`房间 ${roomId} WebSocket 地址连接已关闭: ${address} (code=${code}${reason})`));
      };
      const timeoutHandle = setTimeout(() => {
        rejectOnce(new Error(`房间 ${roomId} WebSocket 地址连接超时: ${address}`));
      }, LIVEWS_CONNECT_ATTEMPT_TIMEOUT_MS);

      liveWS.addEventListener('open', handleReady);
      liveWS.addEventListener('live', handleReady);
      liveWS.addEventListener('error', handleError);
      liveWS.addEventListener('close', handleClose);
    });
  }

  private readUidFromCookie(cookie?: string): number {
    if (!cookie) {
      return 0;
    }
    const uidText = readCookieValue(cookie, 'DedeUserID');
    if (uidText && /^[0-9]+$/.test(uidText)) {
      return Number(uidText);
    }
    return 0;
  }

  private readBuvidFromCookie(cookie?: string): string | undefined {
    if (!cookie) {
      return undefined;
    }
    return readCookieValue(cookie, 'buvid3')
      ?? readCookieValue(cookie, 'buvid4')
      ?? readCookieValue(cookie, 'buvid_fp');
  }

  private getPreferredCookie(): { source: CookieSource; value: string; } | null {
    return this.authManager.getPreferredCookie();
  }

  /**
   * 设置LiveWS事件监听
   */
  private setupLiveWSEvents(liveWS: LiveWsConnection, roomId: number): void {
    const isCurrentConnection = (): boolean => this.connections.get(roomId)?.connection === liveWS;

    liveWS.addEventListener('open', () => {
      if (!isCurrentConnection()) {
        return;
      }
      this.logger.info(`房间 ${roomId} WebSocket连接已建立`);
    });

    liveWS.addEventListener('live', () => {
      if (!isCurrentConnection()) {
        return;
      }
      this.logger.debug(`房间 ${roomId} 已进入直播间`);
    });

    liveWS.addEventListener('heartbeat', ({ data }: any) => {
      if (!isCurrentConnection()) {
        return;
      }
      this.logger.debug(`房间 ${roomId} heartbeat`, data);
    });

    liveWS.addEventListener('close', (event: any) => {
      if (!isCurrentConnection()) {
        return;
      }
      const connectionInfo = this.connections.get(roomId);
      const code = typeof event?.code === 'number' ? event.code : -1;
      const reason = typeof event?.reason === 'string' ? event.reason : '';
      this.logger.warn(`房间 ${roomId} WebSocket连接已关闭 (code=${code}, reason=${reason || 'none'})`);
      this.connections.delete(roomId);
      this.emit('disconnected', roomId);
      this.statusManager?.refreshNow();

      if (connectionInfo?.priority === 'server') {
        const lifetimeMs = Date.now() - connectionInfo.connectedAt;
        if (lifetimeMs < 10_000) {
          this.holdingRoomCoordinator.removeHoldingRoom(roomId);
        }
      }

      void this.syncRuntimeState();

      if (!this.isStopping && this.isRunning) {
        this.updateConnections();
      }
    });

    liveWS.addEventListener('error', (event: any) => {
      if (!isCurrentConnection()) {
        return;
      }
      this.logger.error(`房间 ${roomId} WebSocket错误:`, event);
      const error = new Error(`房间 ${roomId} WebSocket错误`);
      this.recordError(error, { category: 'livews', code: 'LIVEWS_RUNTIME_ERROR', roomId, recoverable: true });
      this.emit('error', error, roomId);
    });

    // 监听所有消息，统一处理
    liveWS.addEventListener('msg', ({ data, raw }: any) => {
      if (!isCurrentConnection()) {
        return;
      }
      if (typeof raw !== 'string' || raw.length === 0) {
        const error = new Error(`房间 ${roomId} 收到缺少 wire raw 的消息`);
        this.recordError(error, { category: 'livews', code: 'MESSAGE_RAW_MISSING', roomId, recoverable: true });
        this.emit('error', error, roomId);
        return;
      }
      const message = this.parseMessage(data, roomId, raw);
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
  private parseMessage(data: any, roomId: number, raw: string, cmd?: string): DanmakuMessage {
    const actualCmd = cmd || data?.cmd || data?.msg?.cmd || 'UNKNOWN';

    return {
      roomId,
      cmd: actualCmd,
      data: data,
      raw,
      timestamp: Date.now()
    };
  }

  /**
   * 处理消息
   */
  private async handleMessage(message: DanmakuMessage): Promise<void> {
    if (!this.isRunning || this.isStopping) {
      return;
    }

    if (this.messageQueue.isDuplicateIncomingMessage(message)) {
      return;
    }

    this.messageCount += 1;
    // 发射 'msg' 事件（所有消息）
    this.emit('msg', message);

    // 发射特定cmd的事件
    this.emit(message.cmd, message);

    this.messageQueue.enqueueMessage(message);
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

  private isRoomStillDesired(roomId: number): boolean {
    return this.statusManager ? this.holdingRoomCoordinator.isRoomStillDesired(roomId) : true;
  }

  private findConnectionByResolvedRoomId(resolvedRoomId: number, excludeRoomId?: number): ConnectionInfo | undefined {
    if (!Number.isFinite(resolvedRoomId) || resolvedRoomId <= 0) {
      return undefined;
    }

    for (const connection of this.connections.values()) {
      if (connection.resolvedRoomId !== resolvedRoomId) {
        continue;
      }
      if (excludeRoomId !== undefined && connection.roomId === excludeRoomId) {
        continue;
      }
      return connection;
    }

    return undefined;
  }

  /**
   * 获取连接信息
   */
  getConnectionInfo(): { roomId: number; priority: string; connectedAt: number; }[] {
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
    const authState = this.authManager.getState();
    const lastError = this.getActiveErrorText();

    return {
      clientId: this.clientId,
      isRunning: this.isRunning,
      connectedRooms: this.getConnectedRooms(),
      connectionInfo,
      runtimeConnected: this.runtimeConnection?.getConnectionState() ?? false,
      cookieValid: authState.hasUsableCookie,
      authState,
      streamerStatuses,
      holdingRooms: this.holdingRoomCoordinator.getHoldingRoomIds(),
      recordingRoomIds: [...this.recordingRoomIds],
      messageCount: this.messageCount,
      pendingMessageCount: this.messageQueue.getPendingCount(),
      recentErrors: this.recentErrors.map(item => ({ ...item })),
      lastRoomAssigned: this.holdingRoomCoordinator.getLastRoomAssigned(),
      holdingRoomShortfall: this.holdingRoomCoordinator.getHoldingRoomShortfall(),
      lastError,
      lastHeartbeat: this.runtimeSync.getLastHeartbeat(),
      config: this.configManager.getConfig()
    };
  }

  clearRuntimeError(expectedError?: string | null): boolean {
    return this.clearActiveError({ expectedText: expectedError ?? undefined });
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
    return this.controlState.refreshControlState();
  }

  async refreshRuntimeControlState(): Promise<CoreControlStateSnapshot> {
    return this.controlState.refreshRuntimeControlState();
  }

  async refreshRecordingControlState(): Promise<CoreControlStateSnapshot> {
    return this.controlState.refreshRecordingControlState();
  }

  dispose(): void {
    this.authManager.dispose();
  }

  updateLocalRuntimeConfig(updates: Pick<DanmakuConfig,
    'cookieCloudKey' | 'cookieCloudPassword' | 'cookieCloudHost' | 'cookieRefreshInterval' | 'capacityOverride'>,
  ): void {
    const previous = this.configManager.getConfig();
    this.configManager.updateConfig(updates);
    this.configManager.validate();
    const next = this.configManager.getConfig();

    const previousCookie = this.normalizeCookieRuntimeConfig(previous);
    const nextCookie = this.normalizeCookieRuntimeConfig(next);
    if (this.hasCookieConfigChanged(previousCookie, nextCookie)) {
      this.rebuildAuthManager(next);
    }

    if ((previous.capacityOverride ?? undefined) !== (next.capacityOverride ?? undefined) && this.isRunning) {
      void this.syncRuntimeState().catch((error) => {
        this.logger.warn('热更新 capacityOverride 后同步运行态失败', error);
      });
    }
  }

  async refreshAuthState(options?: { force?: boolean; }): Promise<void> {
    await this.authManager.refreshState({ validateProfile: true, force: options?.force === true });
  }

  async syncCookieCloud(): Promise<void> {
    await this.authManager.syncCookieCloud();
  }

  startControlSync(): void {
    this.controlState.startControlSync();
  }

  stopControlSync(): void {
    this.controlState.stopControlSync();
  }

  async saveCoreConfig(config: CoreControlConfigDto): Promise<CoreControlStateSnapshot> {
    return this.controlState.saveCoreConfig(config);
  }

  async addRecording(uid: number): Promise<RecordingInfoDto> {
    return this.controlState.addRecording(uid);
  }

  async removeRecording(uid: number): Promise<void> {
    await this.controlState.removeRecording(uid);
  }

  async updateRecordingPublic(uid: number, isPublic: boolean): Promise<void> {
    await this.controlState.updateRecordingPublic(uid, isPublic);
  }

  async forceTakeoverRuntimeState(): Promise<CoreControlStateSnapshot> {
    return this.controlState.forceTakeoverRuntimeState();
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
      excludedServerRoomUserIds: [...(config.excludedServerRoomUserIds ?? [])],
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
      holdingRoomShortfall: this.cloneHoldingRoomShortfall(remote.holdingRoomShortfall),
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
      channel: {
        ...item.channel,
        livingInfo: item.channel.livingInfo ? { ...item.channel.livingInfo } : null,
      },
      setting: { ...item.setting },
    }));
  }

  private cloneHoldingRoomShortfall(
    shortfall: RuntimeRoomPullShortfallDto | null | undefined
  ): RuntimeRoomPullShortfallDto | null {
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

  private emitControlStateChanged(): void {
    this.emit('controlStateChanged', this.getControlState());
  }

  private emitStatusChanged(): void {
    this.emit('statusChanged');
  }






  private ensureRuntimeConnection(): RuntimeConnection {
    if (!this.runtimeConnection) {
      throw new Error('Runtime连接尚未初始化');
    }
    return this.runtimeConnection;
  }

  private ensureAccountClient(): AccountApiClient {
    if (!this.accountClient) {
      throw new Error('账号中心客户端尚未初始化');
    }
    return this.accountClient;
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

    this.logger.info('正在从账号中心加载录制状态...');
    await this.controlState.refreshUserInfo();
    await this.controlState.refreshRecordingList(true);
  }

  private async ensureCookieReadyForStartup(): Promise<void> {
    if (this.liveWsConfigProvider) {
      return;
    }

    const authState = this.authManager.getState();
    const cookieCloudConfigured = authState.cookieCloud.configured;

    if (!cookieCloudConfigured && !this.authManager.hasAvailableCookie() && this.interactiveLoginProvider) {
      this.logger.info('未提供可用 Cookie，准备进入交互式扫码登录...');
      const cookie = (await this.interactiveLoginProvider())?.trim() || '';
      if (cookie) {
        this.ephemeralLocalCookie = cookie;
        await this.authManager.refreshState({ validateProfile: true, force: true });
      }
    }

    await this.authManager.ensureReadyForStartup();
    this.emit('authStateChanged', this.authManager.getState());
  }

  private async acquireRuntimeLock(): Promise<void> {
    await this.runtimeSync.acquireRuntimeLock();
  }

  private ensureHeartbeat(): void {
    this.runtimeSync.ensureHeartbeat();
  }

  private clearHeartbeat(): void {
    this.runtimeSync.clearHeartbeat();
  }

  private buildRuntimeStateSnapshot(): CoreRuntimeStateDto {
    const now = Date.now();
    const runtimeConnected = this.runtimeConnection?.getConnectionState() ?? false;
    const connectionInfo = this.getConnectionInfo();
    const connectedRooms = this.getConnectedRooms();
    const config = this.configManager.getConfig();
    const authState = this.authManager.getState();
    const lastError = this.getActiveErrorText(now) ?? null;

    return {
      clientId: this.clientId,
      clientVersion: config.clientVersion ?? 'core',
      isRunning: this.isRunning,
      runtimeConnected,
      cookieValid: authState.hasUsableCookie,
      authState,
      connectedRooms,
      connectionInfo: connectionInfo.map<CoreConnectionInfoDto>(info => ({
        roomId: info.roomId,
        priority: info.priority,
        connectedAt: new Date(info.connectedAt).toISOString()
      })),
      holdingRooms: this.holdingRoomCoordinator.getHoldingRoomIds(),
      messageCount: this.messageCount,
      lastRoomAssigned: this.holdingRoomCoordinator.getLastRoomAssigned() ?? null,
      holdingRoomShortfall: this.holdingRoomCoordinator.getHoldingRoomShortfall(),
      lastError,
      lastHeartbeat: new Date(this.runtimeSync.getLastHeartbeat() || now).toISOString()
    };
  }

  private buildRuntimeHeartbeatPayload(): Partial<CoreRuntimeStateDto> & { clientId: string; } {
    const config = this.configManager.getConfig();
    const authState = this.authManager.getState();
    const lastError = this.getActiveErrorText() ?? null;
    return {
      clientId: this.clientId,
      clientVersion: config.clientVersion ?? 'core',
      isRunning: this.isRunning,
      runtimeConnected: this.runtimeConnection?.getConnectionState() ?? false,
      cookieValid: authState.hasUsableCookie,
      authState,
      messageCount: this.messageCount,
      lastRoomAssigned: this.holdingRoomCoordinator.getLastRoomAssigned() ?? null,
      holdingRoomShortfall: this.holdingRoomCoordinator.getHoldingRoomShortfall(),
      lastError
    };
  }


  private async syncRuntimeState(
    overrides: Partial<CoreRuntimeStateDto> = {},
    options?: { force?: boolean; strict?: boolean; }
  ): Promise<void> {
    await this.runtimeSync.syncRuntimeState(overrides, options);
  }

  private isHoldingRoomRequestEnabled(config: DanmakuConfig = this.configManager.getConfig()): boolean {
    return (config.requestServerRooms ?? true) && Math.max(0, Math.floor(config.maxConnections)) > 0;
  }

  private clearHoldingRooms(): void {
    this.holdingRoomCoordinator.clearHoldingRooms();
  }


  private async refreshHoldingRoomsIfNeeded(
    maxConnections: number,
    reason: string = 'capacity-refresh',
    options?: { force?: boolean; }
  ): Promise<boolean> {
    return this.holdingRoomCoordinator.refreshHoldingRoomsIfNeeded(maxConnections, reason, options);
  }


  private consumeAssignmentTag(nextTag: string | null): boolean {
    if (nextTag === null || nextTag === this.assignmentTag) {
      return false;
    }

    this.assignmentTag = nextTag;
    return true;
  }

  private updateControlSyncTags(tags: Partial<CoreSyncTagSnapshot>): void {
    if (tags.configTag !== undefined && tags.configTag !== null) {
      this.accountConfigTag = tags.configTag;
    }
    if (tags.clientsTag !== undefined && tags.clientsTag !== null) {
      this.clientsTag = tags.clientsTag;
    }
    if (tags.recordingTag !== undefined && tags.recordingTag !== null) {
      this.recordingTag = tags.recordingTag;
    }
  }

  private async handleRuntimeHeartbeatResult(
    result: Awaited<ReturnType<AccountApiClient['heartbeatRuntimeState']>>
  ): Promise<void> {
    await this.controlState.handleAccountConfigTagChange(result.configTag);
    await this.controlState.handleClientsTagChange(result.clientsTag);
    await this.controlState.handleRecordingTagChange(result.recordingTag);
    if (this.consumeAssignmentTag(result.assignmentTag)) {
      await this.refreshHoldingRoomsIfNeeded(this.configManager.getConfig().maxConnections, 'assignment-tag-changed', {
        force: true,
      });
    }
  }

  private replaceUserInfo(userInfo: UserInfo | null): void {
    this.userInfo = this.cloneUserInfo(userInfo);
  }

  private replaceRemoteClients(remoteClients: CoreRuntimeStateDto[]): void {
    this.remoteClients = this.cloneRemoteClients(remoteClients);
  }

  private replaceRecordings(recordings: RecordingInfoDto[]): void {
    this.recordings = this.cloneRecordingList(recordings);
    this.recordingRoomIds = Array.from(new Set(this.recordings
      .map(item => Number(item.channel.roomId))
      .filter(roomId => Number.isFinite(roomId) && roomId > 0)
      .map(roomId => Math.floor(roomId))));
    this.statusManager?.updateRecordingRooms(this.recordingRoomIds);
  }

  private resolveRoomStreamerUid(roomId: number): number | null {
    const normalizedRoomId = Math.floor(Number(roomId));
    if (!Number.isFinite(normalizedRoomId) || normalizedRoomId <= 0) {
      return null;
    }

    const recordingStreamerUid = this.recordings.find(item => item.channel.roomId === normalizedRoomId)?.channel.uId;
    if (Number.isFinite(recordingStreamerUid) && Number(recordingStreamerUid) > 0) {
      return Math.floor(Number(recordingStreamerUid));
    }

    const statusStreamerUid = this.statusManager?.getStreamerStatus(normalizedRoomId)?.uId;
    return Number.isFinite(statusStreamerUid) && Number(statusStreamerUid) > 0
      ? Math.floor(Number(statusStreamerUid))
      : null;
  }

  private resetAccountConfigSyncState(): void {
    this.accountConfigTag = null;
    this.recordingRoomIds = [];
    this.statusManager?.updateRecordingRooms([]);
  }

  private applyRuntimeTunings(config: DanmakuConfig): void {
    this.logger.setLevel(normalizeLogLevel(config.logLevel, this.logger.getLevel()));
    this.messageQueue.applyRuntimeTunings(config);
    this.runtimeSync.applyRuntimeTunings(config);

    const errorLimit = Math.floor(config.errorHistoryLimit ?? 50);
    this.errorHistoryLimit = Math.max(ERROR_HISTORY_MIN_LIMIT, errorLimit);
    if (this.recentErrors.length > this.errorHistoryLimit) {
      this.recentErrors.splice(0, this.recentErrors.length - this.errorHistoryLimit);
    }
  }


  private async applyAccountConfigSnapshot(remoteConfig: CoreControlConfigDto, nextTag: string | null): Promise<void> {
    const previousConfig = this.configManager.getConfig();
    this.configManager.applyAccountConfig(remoteConfig);
    this.configManager.validate();
    const nextConfig = this.configManager.getConfig();
    this.accountConfigTag = nextTag;
    const hotConfigChanged = this.hasHotConfigChanges(previousConfig, nextConfig);

    if (!this.isRunning) {
      this.applyRuntimeTunings(nextConfig);
      if (hotConfigChanged) {
        this.initializeManagers();
      }
      this.emitControlStateChanged();
      return;
    }

    if (!hotConfigChanged) {
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
      || !this.areNumberListsEqual(previous.excludedServerRoomUserIds, next.excludedServerRoomUserIds)
      || normalizeLogLevel(previous.logLevel, 'info') !== normalizeLogLevel(next.logLevel, 'info')
      || (previous.messageQueueMaxSize ?? 20000) !== (next.messageQueueMaxSize ?? 20000)
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
    const excludedServerRoomUserIdsChanged = !this.areNumberListsEqual(
      previous.excludedServerRoomUserIds,
      next.excludedServerRoomUserIds
    );

    if (cookieChanged) {
      this.rebuildAuthManager(next);
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
      || excludedServerRoomUserIdsChanged
    ) {
      this.updateConnections();
    }

    if (excludedServerRoomUserIdsChanged && this.isHoldingRoomRequestEnabled(next)) {
      await this.refreshHoldingRoomsIfNeeded(next.maxConnections, 'account-config-excluded-uids-changed', {
        force: true
      });
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

  private rebuildAuthManager(config: DanmakuConfig): void {
    this.baseLocalCookieProvider = config.cookieProvider;
    this.interactiveLoginProvider = config.interactiveLoginProvider;
    this.authManager?.dispose();
    this.authManager = new AuthManager({
      localCookieProvider: () => this.readLocalCookie(),
      cookieCloudKey: config.cookieCloudKey,
      cookieCloudPassword: config.cookieCloudPassword,
      cookieCloudHost: config.cookieCloudHost,
      cookieRefreshInterval: config.cookieRefreshInterval,
      fetchImpl: config.fetchImpl,
    });
    this.authManager.onStateChanged((state) => {
      this.emit('authStateChanged', state);
      this.emit('cookieUpdated');
    });
    this.authManager.start();
    void this.authManager.refreshState({ validateProfile: true, force: true }).catch(() => undefined);
  }

  private rebuildLiveWsAuthApi(config: DanmakuConfig): void {
    this.bilibiliLiveWsAuthApi = new BilibiliLiveWsAuthApi(config.fetchImpl);
  }

  private readLocalCookie(): string {
    const ephemeralCookie = this.ephemeralLocalCookie.trim();
    if (ephemeralCookie) {
      return ephemeralCookie;
    }
    return this.baseLocalCookieProvider?.()?.trim() || '';
  }

  private rebuildStatusManager(config: DanmakuConfig): void {
    this.statusManager?.stop();
    this.statusManager = new StreamerStatusManager(
      config.statusCheckInterval,
      config.runtimeUrl,
      config.fetchImpl,
      this.logger.child('StatusManager')
    );
    this.statusManager.updateHoldingRooms(this.holdingRoomCoordinator.getHoldingRoomIds());
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

      await this.refreshHoldingRoomsIfNeeded(config.maxConnections, 'runtime-rebuild', { force: true });
    } finally {
      this.suppressRuntimeAutoRegister = false;
    }

    this.updateConnections();
    await this.syncRuntimeState();
    this.messageQueue.scheduleMessageDispatch(0);
  }

  private triggerRuntimeClientRegistration(reason: 'connected' | 'reconnected'): void {
    this.runtimeSync.triggerRuntimeClientRegistration(reason);
  }

  private handleRuntimeSessionInvalid(reason: string): void {
    this.runtimeSync.handleRuntimeSessionInvalid(reason);
  }

  private handleRuntimeLockConflict(reason: string): void {
    if (!this.isRunning || this.isStopping || this.runtimeLockConflictStopping) {
      return;
    }

    this.runtimeLockConflictStopping = true;
    const normalizedReason = reason.trim() || '核心锁已失效';
    const error = new Error(normalizedReason);
    this.logger.warn(`检测到核心锁失效，停止客户端以避免重复录制: ${normalizedReason}`);
    this.emit('error', error);
    void this.stop({ suppressReleaseErrors: true, skipRuntimeRelease: true })
      .catch((stopError) => {
        this.recordError(stopError, { category: 'lock', code: 'LOCK_CONFLICT_STOP_FAILED' });
        this.logger.error('核心锁失效后停止客户端失败', stopError);
      })
      .finally(() => {
        this.runtimeLockConflictStopping = false;
      });
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

  private areNumberListsEqual(left?: number[] | null, right?: number[] | null): boolean {
    const lhs = Array.isArray(left) ? left : [];
    const rhs = Array.isArray(right) ? right : [];
    if (lhs.length !== rhs.length) {
      return false;
    }

    return lhs.every((value, index) => value === rhs[index]);
  }

  private recordError(error: unknown, context?: ClientErrorContext): void {
    const message = this.getErrorMessage(error);
    const category = context?.category ?? 'unknown';
    const code = context?.code ?? this.defaultErrorCodeByCategory(category);
    const recoverable = context?.recoverable ?? false;
    const roomId = context?.roomId;
    const record: ClientErrorRecord = {
      timestamp: Date.now(),
      category,
      code,
      message,
      recoverable,
      ...(typeof roomId === 'number' ? { roomId } : {})
    };
    this.activeError = record;

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

  private getActiveErrorRecord(now: number = Date.now()): ClientErrorRecord | null {
    if (this.activeError === null) {
      return null;
    }

    if (this.activeError.timestamp + ACTIVE_RUNTIME_ERROR_RETENTION_MS > now) {
      return this.activeError;
    }

    this.activeError = null;
    return null;
  }

  private getActiveErrorText(now: number = Date.now()): string | undefined {
    const record = this.getActiveErrorRecord(now);
    if (record === null) {
      return undefined;
    }

    return `[${record.code}] ${record.message}`;
  }

  private clearActiveError(options?: { codes?: string[]; expectedText?: string; }): boolean {
    const record = this.getActiveErrorRecord();
    if (record === null) {
      return false;
    }

    if (options?.codes && !options.codes.includes(record.code)) {
      return false;
    }

    const currentText = `[${record.code}] ${record.message}`;
    if (options?.expectedText && currentText !== options.expectedText) {
      return false;
    }

    this.activeError = null;
    return true;
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



