import { HubConnection, HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr';
import { DanmakuMessage } from '../types';
import { ScopedLogger } from './Logger';

const MAX_RECONNECT_INTERVAL = 60_000;
const RECONNECT_JITTER_RATIO = 0.2;

export class SignalRConnection {
  private connection: HubConnection;
  private isConnected: boolean = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private manuallyClosed = false;
  private batchUploadState: 'unknown' | 'available' | 'unavailable' = 'unknown';

  constructor(
    private url: string,
    private autoReconnect: boolean = true,
    private reconnectInterval: number = 5000,
    private signalrHeaders?: Record<string, string>,
    private logger: ScopedLogger = new ScopedLogger('SignalRConnection')
  ) {
    const builder = new HubConnectionBuilder();

    const { urlWithToken, headers } = this.prepareConnectionOptions(this.url, this.signalrHeaders);

    builder.withUrl(urlWithToken, {
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
      ...(headers ? { headers } : {})
    });

    if (this.autoReconnect) {
      builder.withAutomaticReconnect([0, 2000, 5000, 10000]);
    }

    this.connection = builder.configureLogging(LogLevel.Warning).build();

    this.setupEventHandlers();
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    this.connection.onreconnecting(() => {
      this.logger.warn('SignalR正在重连...');
      this.isConnected = false;
      this.onDisconnected?.();
    });

    this.connection.onreconnected(() => {
      this.logger.info('SignalR重连成功');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.onReconnected?.();
      this.onConnected?.();
    });

    this.connection.onclose((error) => {
      this.logger.warn('SignalR连接已关闭', error);
      this.isConnected = false;
      this.onDisconnected?.(error as Error | undefined);

      if (this.autoReconnect && !this.manuallyClosed) {
        this.scheduleReconnect();
      }
    });

    // 监听服务器下发的房间分配
    this.connection.on('AssignRoom', (roomId: number) => {
      this.logger.info(`服务器分配房间: ${roomId}`);
      this.onRoomAssigned?.(roomId);
    });

    this.connection.on('ReplaceRoom', (oldRoomId: number, newRoomId: number) => {
      this.logger.info(`服务器要求替换房间: ${oldRoomId} -> ${newRoomId}`);
      this.onRoomReplaced?.(oldRoomId, newRoomId);
    });

    // 监听服务器消息
    this.connection.on('ServerMessage', (message: string) => {
      this.logger.debug(`服务器消息: ${message}`);
    });

    // 处理服务器要求断开的通知（UserHub 会发送 Disconnect）
    this.connection.on('Disconnect', async (reason?: string) => {
      this.logger.warn('服务器请求断开连接', reason);
      this.onServerDisconnect?.(reason);

      try {
        await this.disconnect();
      } catch (error) {
        this.logger.warn('主动断开连接时发生错误', error);
      }
    });
  }

  /**
   * 连接到SignalR Hub
   */
  async connect(scheduleOnFailure: boolean = true): Promise<boolean> {
    try {
      this.manuallyClosed = false;
      this.clearReconnectTimer();
      this.logger.info(`正在连接到SignalR: ${this.url}`);
      await this.connection.start();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.logger.info('SignalR连接成功');
      this.onConnected?.();
      return true;
    } catch (error) {
      this.logger.error('SignalR连接失败:', error);
      this.isConnected = false;

      if (this.autoReconnect && scheduleOnFailure && !this.manuallyClosed) {
        this.scheduleReconnect();
      }

      return false;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.manuallyClosed = true;
    this.clearReconnectTimer();

    if (this.connection) {
      await this.connection.stop();
      this.isConnected = false;
      this.logger.info('SignalR连接已断开');
    }
  }

  /**
   * 发送消息到服务器
   */
  async sendMessage(message: DanmakuMessage): Promise<boolean> {
    if (!this.isConnected) {
      this.logger.warn('SignalR未连接，无法发送消息');
      return false;
    }

    try {
      const result = await this.connection.invoke<unknown>('ReceiveMessage', message);
      if (typeof result === 'string' && result.trim()) {
        this.logger.warn(`发送消息被服务端拒绝: room=${message.roomId}, cmd=${message.cmd}, reason=${result}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error('发送消息失败:', error);
      return false;
    }
  }

  async sendMessages(messages: DanmakuMessage[]): Promise<number> {
    if (messages.length === 0) {
      return 0;
    }

    if (!this.isConnected) {
      this.logger.warn('SignalR未连接，无法批量发送消息');
      return 0;
    }

    if (messages.length === 1) {
      return (await this.sendMessage(messages[0])) ? 1 : 0;
    }

    if (this.batchUploadState !== 'unavailable') {
      try {
        const result = await this.connection.invoke<unknown>('ReceiveMessages', messages);
        this.batchUploadState = 'available';
        const failedCount = this.resolveBatchFailedCount(result, messages.length);
        if (failedCount > 0) {
          this.logger.warn(`批量上行失败: total=${messages.length}, failed=${failedCount}`);
          return 0;
        }
        return messages.length;
      } catch (error) {
        if (this.isMissingHubMethodError(error)) {
          this.batchUploadState = 'unavailable';
          this.logger.warn('服务端未实现 ReceiveMessages，降级为逐条发送');
        } else {
          this.logger.error('批量发送消息失败:', error);
          return 0;
        }
      }
    }

    let sentCount = 0;
    for (const message of messages) {
      if (!(await this.sendMessage(message))) {
        break;
      }
      sentCount += 1;
    }
    return sentCount;
  }

  /**
   * 注册客户端（告知服务器当前监听的房间）
   */
  async registerClient(roomIds: number[]): Promise<boolean> {
    if (!this.isConnected) {
      this.logger.warn('SignalR未连接，无法注册客户端');
      return false;
    }

    try {
      await this.connection.invoke('RegisterClient', roomIds);
      this.logger.info('客户端注册成功');
      return true;
    } catch (error) {
      this.logger.error('客户端注册失败:', error);
      return false;
    }
  }

  /**
   * 请求分配新房间
   */
  async requestRoomAssignment(): Promise<boolean> {
    if (!this.isConnected) {
      this.logger.warn('SignalR未连接，无法请求房间分配');
      return false;
    }

    try {
      await this.connection.invoke('RequestRoomAssignment');
      return true;
    } catch (error) {
      this.logger.error('请求房间分配失败:', error);
      return false;
    }
  }

  /**
   * 计划重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.manuallyClosed || !this.autoReconnect) {
      return;
    }

    const attempt = this.reconnectAttempts + 1;
    const delay = this.calculateReconnectDelay(attempt);
    this.reconnectAttempts = attempt;

    this.logger.warn(`SignalR重连计划: ${delay}ms 后执行 (attempt=${attempt})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      this.logger.info(`尝试重新连接SignalR... (attempt=${attempt})`);
      const success = await this.connect(false);

      if (!success && this.autoReconnect && !this.manuallyClosed) {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private calculateReconnectDelay(attempt: number): number {
    const baseInterval = Math.max(500, this.reconnectInterval);
    const exponential = Math.min(baseInterval * (2 ** Math.max(0, attempt - 1)), MAX_RECONNECT_INTERVAL);
    const jitter = 1 + (Math.random() * RECONNECT_JITTER_RATIO);
    return Math.floor(exponential * jitter);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /**
   * 检查连接状态
   */
  getConnectionState(): boolean {
    return this.isConnected;
  }

  /**
   * 获取连接ID
   */
  getConnectionId(): string | null {
    return this.connection.connectionId || null;
  }

  private prepareConnectionOptions(
    url: string,
    headers?: Record<string, string>
  ): { urlWithToken: string; headers?: Record<string, string> } {
    if (!headers) {
      return { urlWithToken: url, headers: undefined };
    }

    let urlWithToken = url;
    const sanitizedHeaders = { ...headers };

    if (headers.Token) {
      urlWithToken = this.appendQueryParam(urlWithToken, 'token', headers.Token);
      delete sanitizedHeaders.Token;
    }

    if (headers.ClientId) {
      urlWithToken = this.appendQueryParam(urlWithToken, 'clientId', headers.ClientId);
      delete sanitizedHeaders.ClientId;
    }

    return {
      urlWithToken,
      headers: Object.keys(sanitizedHeaders).length > 0 ? sanitizedHeaders : undefined
    };
  }

  private appendQueryParam(url: string, key: string, value: string): string {
    try {
      const urlObj = new URL(url);
      urlObj.searchParams.set(key, value);
      return urlObj.toString();
    } catch {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
  }

  private resolveBatchFailedCount(result: unknown, messageCount: number): number {
    if (result === null || result === undefined || result === '') {
      return 0;
    }

    if (Array.isArray(result)) {
      return result.reduce((total, item) => {
        if (typeof item === 'string' && item.trim()) {
          return total + 1;
        }
        return total;
      }, 0);
    }

    if (typeof result === 'string') {
      return result.trim() ? messageCount : 0;
    }

    if (typeof result === 'object') {
      const failedCountRaw = (result as { failedCount?: unknown }).failedCount;
      const failedCount = Number(failedCountRaw);
      if (Number.isFinite(failedCount) && failedCount > 0) {
        return Math.min(messageCount, Math.floor(failedCount));
      }
    }

    return 0;
  }

  private isMissingHubMethodError(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error ?? '');
    return text.includes('does not exist')
      || text.includes('unknown hub method')
      || text.includes('Method does not exist');
  }

  // 事件回调
  onRoomAssigned?: (roomId: number) => void;
  onRoomReplaced?: (oldRoomId: number, newRoomId: number) => void;
  onServerDisconnect?: (reason?: string) => void;
  onConnected?: () => void;
  onDisconnected?: (error?: Error) => void;
  onReconnected?: () => void;
}
