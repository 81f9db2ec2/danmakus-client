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
  StreamerConfig,
  StreamerStatus,
  CoreRuntimeStateDto,
  CoreConnectionInfoDto
} from '../types';

const HEARTBEAT_INTERVAL = 8000;

function generateClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(16).slice(2);
  return `client-${Date.now().toString(36)}-${random}`;
}

interface ConnectionInfo {
  connection: LiveWS;
  roomId: number;
  priority: 'high' | 'normal' | 'low' | 'server';
  connectedAt: number;
}

export class DanmakuClient extends EventEmitter {
  private configManager: ConfigManager;
  private cookieManager?: CookieManager;
  private cookieProvider?: () => string | null | undefined;
  private signalrConnection?: SignalRConnection;
  private statusManager?: StreamerStatusManager;
  private accountClient?: AccountApiClient;
  private clientId: string;
  private connections: Map<number, ConnectionInfo> = new Map();
  private serverAssignedRooms: number[] = [];
  private lastServerRoomRequestAt = 0;
  private isRunning: boolean = false;
  private updateConnectionsTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private accountConfigRefreshTimer?: ReturnType<typeof setInterval>;
  private accountConfigRefreshing = false;
  private messageCount = 0;
  private lastRoomAssigned?: number;
  private lastError?: string;
  private lastHeartbeat = 0;

  constructor(config: Partial<DanmakuConfig> = {}) {
    super();

    this.clientId = config.clientId || generateClientId();
    this.cookieProvider = config.cookieProvider;

    this.configManager = new ConfigManager({
      ...config,
      clientId: this.clientId
    });
    this.configManager.validate();

    if (config.accountToken) {
      this.accountClient = new AccountApiClient(
        config.accountToken,
        config.accountApiBase,
        config.fetchImpl
      );
    }

    this.initializeManagers();
  }

  private initializeManagers(): void {
    const finalConfig = this.configManager.getConfig();

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
      finalConfig.signalrHeaders
    );
    this.setupSignalREvents();

    if (this.statusManager) {
      this.statusManager.stop();
    }

    this.statusManager = new StreamerStatusManager(
      finalConfig.streamers,
      finalConfig.statusCheckInterval,
      finalConfig.signalrUrl,
      finalConfig.fetchImpl
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
      console.log(`收到服务器分配的房间: ${roomId}`);
      if (!this.serverAssignedRooms.includes(roomId)) {
        this.serverAssignedRooms.push(roomId);
      }
      this.statusManager?.updateServerRooms(this.serverAssignedRooms);
      this.statusManager?.refreshNow();
      this.lastRoomAssigned = roomId;
      this.updateConnections();
      void this.syncRuntimeState();
      this.emit('roomAssigned', roomId);
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
      console.log(`更新主播状态: ${statuses.filter(s => s.isLive).length}/${statuses.length} 在线`);
      this.updateConnections();
      this.emit('streamerStatusUpdated', statuses);
    };
  }

  /**
   * 启动客户端
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('客户端已在运行中');
      return;
    }

    try {
      console.log('正在启动弹幕客户端... (v_hot_reload)');

      await this.prepareAccountConfig();
      await this.syncRuntimeState({}, { strict: true });

      // 启动CookieManager
      if (this.cookieManager) {
        console.log('启动Cookie管理器...');
        this.cookieManager.startPeriodicUpdate();
      }

      // 连接SignalR
      console.log('连接到SignalR服务器...');
      const signalrConnection = this.ensureSignalRConnection();
      const signalrConnected = await signalrConnection.connect();
      if (!signalrConnected) {
        throw new Error('无法连接到SignalR服务器');
      }

      // 注册客户端
      const streamers = this.configManager.getStreamers();
      await signalrConnection.registerClient(streamers.map(s => s.roomId));

      // 启动状态管理器
      console.log('启动状态检查器...');
      const statusManager = this.ensureStatusManager();
      statusManager.updateServerRooms(this.serverAssignedRooms);
      statusManager.start();
      this.startAccountConfigRefresh();

      // 请求服务器分配房间（如果需要）
      const finalConfig = this.configManager.getConfig();
      if ((finalConfig.requestServerRooms ?? true) && streamers.length === 0) {
        console.log('没有配置主播，请求服务器分配房间...');
        await signalrConnection.requestRoomAssignment();
      }

      this.isRunning = true;
      this.messageCount = 0;
      console.log('弹幕客户端启动成功');
      await this.syncRuntimeState();
      this.ensureHeartbeat();

    } catch (error) {
      console.error('启动弹幕客户端失败:', error);
      this.recordError(error);
      await this.stop({ suppressReleaseErrors: true });
      throw error;
    }
  }

  /**
   * 停止客户端
   */
  async stop(options?: { suppressReleaseErrors?: boolean }): Promise<void> {
    console.log('正在停止弹幕客户端...');

    this.stopAccountConfigRefresh();

    // 停止状态管理器
    this.statusManager?.stop();

    // 停止所有直播间连接
    for (const [roomId, connInfo] of this.connections) {
      try {
        connInfo.connection.close();
      } catch (error) {
        console.error(`关闭房间 ${roomId} 连接失败:`, error);
      }
    }
    this.connections.clear();

    // 停止CookieManager
    if (this.cookieManager) {
      this.cookieManager.stopPeriodicUpdate();
    }

    // 断开SignalR连接
    await this.signalrConnection?.disconnect();

    if (this.updateConnectionsTimer) {
      clearTimeout(this.updateConnectionsTimer);
      this.updateConnectionsTimer = undefined;
    }

    this.isRunning = false;
    this.serverAssignedRooms = [];
    this.statusManager?.updateServerRooms([]);
    this.messageCount = 0;
    this.lastRoomAssigned = undefined;
    this.lastError = undefined;
    this.clearHeartbeat();
    await this.syncRuntimeState();
    if (this.accountClient) {
      try {
        await this.accountClient.releaseRuntimeState(this.clientId);
      } catch (releaseError) {
        this.recordError(releaseError);
        if (options?.suppressReleaseErrors) {
          console.warn('释放核心锁失败', releaseError);
        } else {
          throw releaseError;
        }
      }
    }
    console.log('弹幕客户端已停止');
  }

  /**
   * 更新连接状态
   */
  private updateConnections(): void {
    if (this.updateConnectionsTimer) {
      clearTimeout(this.updateConnectionsTimer);
    }

    this.updateConnectionsTimer = setTimeout(() => {
      this.updateConnectionsTimer = undefined;
      this.applyConnectionsUpdate();
    }, 300);
  }

  private applyConnectionsUpdate(): void {
    const streamers = this.configManager.getStreamers();
    const config = this.configManager.getConfig();

    // 获取应该连接的房间
    const statusManager = this.ensureStatusManager();
    const roomsToConnect = statusManager.getRoomsToConnect(
      streamers,
      this.serverAssignedRooms,
      config.maxConnections
    );

    // 当前连接的房间
    const currentConnections = Array.from(this.connections.keys());
    const targetRooms = roomsToConnect.map(r => r.roomId);

    // 断开不需要的连接
    for (const roomId of currentConnections) {
      if (!targetRooms.includes(roomId)) {
        this.disconnectFromRoom(roomId);
      }
    }

    // 建立新的连接
    for (const roomConfig of roomsToConnect) {
      if (!this.connections.has(roomConfig.roomId)) {
        this.connectToRoom(roomConfig.roomId, roomConfig.priority);
      }
    }

    // 本地无直播/有空闲时：请求服务器分配补位房间
    if ((config.requestServerRooms ?? true) && roomsToConnect.length < config.maxConnections) {
      this.maybeRequestServerRoomAssignment(config.maxConnections);
    }

    void this.syncRuntimeState();
  }

  /**
   * 连接到单个房间
   */
  private async connectToRoom(roomId: number, priority: 'high' | 'normal' | 'low' | 'server'): Promise<void> {
    if (this.connections.has(roomId)) {
      console.warn(`房间 ${roomId} 已经连接`);
      return;
    }

    try {
      console.log(`正在连接到房间 ${roomId} (优先级: ${priority})...`);

      const connectionOptions = this.buildConnectionOptionsFromCookie();

      const liveWS = new LiveWS(roomId, connectionOptions);

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

      console.log(`✓ 房间 ${roomId} 连接成功`);

    } catch (error) {
      console.error(`连接到房间 ${roomId} 失败:`, error);
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.recordError(normalizedError);
      this.emit('error', normalizedError, roomId);
    }
  }

  private buildConnectionOptionsFromCookie(): Record<string, number | string> {
    const cookie = this.cookieProvider?.()?.trim();
    if (!cookie) {
      return {};
    }

    const options: Record<string, number | string> = {};

    const uidText = DanmakuClient.readCookieValue(cookie, 'DedeUserID');
    if (uidText && /^[0-9]+$/.test(uidText)) {
      options.uid = Number(uidText);
    }

    const buvid = DanmakuClient.readCookieValue(cookie, 'buvid3')
      ?? DanmakuClient.readCookieValue(cookie, 'buvid4')
      ?? DanmakuClient.readCookieValue(cookie, 'buvid_fp');
    if (buvid) {
      options.buvid = buvid;
    }

    return options;
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

  /**
   * 设置LiveWS事件监听
   */
  private setupLiveWSEvents(liveWS: LiveWS, roomId: number): void {
    liveWS.addEventListener('open', () => {
      console.log(`房间 ${roomId} WebSocket连接已建立`);
    });

    liveWS.addEventListener('close', () => {
      const connectionInfo = this.connections.get(roomId);
      console.log(`房间 ${roomId} WebSocket连接已关闭`);
      this.connections.delete(roomId);
      this.emit('disconnected', roomId);
      void this.syncRuntimeState();

      // 服务器分配的房间如果“连上立刻断”，通常代表房间不在直播/不可用；移除后再申请补位
      if (connectionInfo?.priority === 'server') {
        const lifetimeMs = Date.now() - connectionInfo.connectedAt;
        if (lifetimeMs < 10_000) {
          this.serverAssignedRooms = this.serverAssignedRooms.filter(id => id !== roomId);
          this.statusManager?.updateServerRooms(this.serverAssignedRooms);
          this.maybeRequestServerRoomAssignment(this.configManager.getConfig().maxConnections);
          this.updateConnections();
        }
      }
    });

    liveWS.addEventListener('error', (event: any) => {
      console.error(`房间 ${roomId} WebSocket错误:`, event);
      const error = new Error(`房间 ${roomId} WebSocket错误`);
      this.recordError(error);
      this.emit('error', error, roomId);
    });

    // 监听所有消息，统一处理
    liveWS.addEventListener('MESSAGE', ({ data }: any) => {
      const message = this.parseMessage(data, roomId);
      this.handleMessage(message).catch(error => {
        console.error(`处理房间 ${roomId} 消息时发生错误:`, error);
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.recordError(normalizedError);
        this.emit('error', normalizedError, roomId);
      });
    });
  }

  /**
   * 解析消息为统一格式
   */
  private parseMessage(data: any, roomId: number, cmd?: string): DanmakuMessage {
    const actualCmd = cmd || data.cmd || 'UNKNOWN';

    return {
      roomId,
      cmd: actualCmd,
      data: data,
      raw: JSON.stringify(data),
      timestamp: Date.now()
    };
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

    // 发送到SignalR服务器
    const connection = this.ensureSignalRConnection();
    await connection.sendMessage(message);
  }

  /**
   * 断开房间连接
   */
  private disconnectFromRoom(roomId: number): void {
    const connectionInfo = this.connections.get(roomId);
    if (connectionInfo) {
      connectionInfo.connection.close();
      this.connections.delete(roomId);
      console.log(`✗ 房间 ${roomId} 连接已断开`);
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
      cookieValid: this.cookieManager?.isValid() || !!this.cookieProvider?.()?.trim(),
      streamerStatuses,
      serverAssignedRooms: [...this.serverAssignedRooms],
      messageCount: this.messageCount,
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

    console.log('正在从账号中心加载核心配置...');
    const remoteConfig = await this.accountClient.getCoreConfig();
    this.configManager.applyAccountConfig(remoteConfig);
    this.initializeManagers();
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

    this.heartbeatTimer = setTimeout(beat, HEARTBEAT_INTERVAL);
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
      this.recordError(error);
      console.warn('同步核心运行状态失败', error);
      if (options?.strict) {
        throw error;
      }
    }
  }

  private maybeRequestServerRoomAssignment(maxConnections: number): void {
    const signalrConnection = this.signalrConnection;
    if (!signalrConnection?.getConnectionState()) {
      return;
    }

    // 避免 serverAssignedRooms 失控增长：超过上限时不再继续申请
    if (this.serverAssignedRooms.length >= maxConnections) {
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
      void this.refreshAccountStreamers();
    }, 30_000);
  }

  private stopAccountConfigRefresh(): void {
    if (this.accountConfigRefreshTimer) {
      clearInterval(this.accountConfigRefreshTimer);
      this.accountConfigRefreshTimer = undefined;
    }
    this.accountConfigRefreshing = false;
  }

  private async refreshAccountStreamers(): Promise<void> {
    if (!this.accountClient || this.accountConfigRefreshing) {
      return;
    }

    this.accountConfigRefreshing = true;
    try {
      const remoteConfig = await this.accountClient.getCoreConfig();

      const toPriority = (value: unknown): StreamerConfig['priority'] =>
        value === 'high' || value === 'normal' || value === 'low'
          ? value
          : 'normal';

      const normalize = (items: StreamerConfig[]) =>
        items
          .map(item => ({
            roomId: Number(item.roomId),
            priority: toPriority(item.priority),
            name: item.name || undefined
          }))
          .filter(item => Number.isFinite(item.roomId) && item.roomId > 0)
          .sort((a, b) =>
            a.roomId - b.roomId
            || a.priority.localeCompare(b.priority)
            || (a.name ?? '').localeCompare(b.name ?? '')
          );

      const current = normalize(this.configManager.getStreamers());

      const next = normalize(remoteConfig.streamers.map(s => ({
        roomId: Number(s.roomId),
        priority: toPriority(s.priority),
        name: s.name || undefined
      })));

      const isSame = current.length === next.length
        && current.every((item, index) => {
          const other = next[index];
          return other.roomId === item.roomId
            && other.priority === item.priority
            && (other.name ?? undefined) === (item.name ?? undefined);
        });

      if (isSame) {
        return;
      }

      this.configManager.updateConfig({ streamers: next });
      this.statusManager?.updateStreamers(next);

      if (this.signalrConnection?.getConnectionState()) {
        await this.signalrConnection.registerClient(next.map(s => s.roomId));
      }

      this.updateConnections();
    } catch (error) {
      this.recordError(error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.accountConfigRefreshing = false;
    }
  }

  private recordError(error: unknown): void {
    if (error instanceof Error) {
      this.lastError = error.message;
    } else if (typeof error === 'string') {
      this.lastError = error;
    } else {
      this.lastError = JSON.stringify(error);
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
