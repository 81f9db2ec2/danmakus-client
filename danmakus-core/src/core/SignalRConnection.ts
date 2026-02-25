import { HubConnection, HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr';
import { DanmakuMessage } from '../types';

export class SignalRConnection {
  private connection: HubConnection;
  private isConnected: boolean = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private url: string,
    private autoReconnect: boolean = true,
    private reconnectInterval: number = 5000,
    private signalrHeaders?: Record<string, string>
  ) {
    const builder = new HubConnectionBuilder();

    const { urlWithToken, headers } = this.prepareConnectionOptions(this.url, this.signalrHeaders);

    builder.withUrl(urlWithToken, {
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
      ...(headers ? { headers } : {})
    });

    if (this.autoReconnect) {
      builder.withAutomaticReconnect();
    }

    this.connection = builder.configureLogging(LogLevel.Information).build();

    this.setupEventHandlers();
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    this.connection.onreconnecting(() => {
      console.log('SignalR正在重连...');
      this.isConnected = false;
    });

    this.connection.onreconnected(() => {
      console.log('SignalR重连成功');
      this.isConnected = true;
    });

    this.connection.onclose((error) => {
      console.log('SignalR连接已关闭', error);
      this.isConnected = false;

      if (this.autoReconnect) {
        this.scheduleReconnect();
      }
    });

    // 监听服务器下发的房间分配
    this.connection.on('AssignRoom', (roomId: number) => {
      console.log(`服务器分配房间: ${roomId}`);
      this.onRoomAssigned?.(roomId);
    });

    // 监听服务器消息
    this.connection.on('ServerMessage', (message: string) => {
      console.log(`服务器消息: ${message}`);
    });

    // 处理服务器要求断开的通知（UserHub 会发送 Disconnect）
    this.connection.on('Disconnect', async (reason?: string) => {
      console.warn('服务器请求断开连接', reason);
      this.onServerDisconnect?.(reason);

      try {
        await this.disconnect();
      } catch (error) {
        console.warn('主动断开连接时发生错误', error);
      }
    });
  }

  /**
   * 连接到SignalR Hub
   */
  async connect(): Promise<boolean> {
    try {
      console.log(`正在连接到SignalR: ${this.url}`);
      await this.connection.start();
      this.isConnected = true;
      console.log('SignalR连接成功');
      return true;
    } catch (error) {
      console.error('SignalR连接失败:', error);
      this.isConnected = false;

      if (this.autoReconnect) {
        this.scheduleReconnect();
      }

      return false;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.connection) {
      await this.connection.stop();
      this.isConnected = false;
      console.log('SignalR连接已断开');
    }
  }

  /**
   * 发送消息到服务器
   */
  async sendMessage(message: DanmakuMessage): Promise<boolean> {
    if (!this.isConnected) {
      console.warn('SignalR未连接，无法发送消息');
      return false;
    }

    try {
      await this.connection.invoke('ReceiveMessage', message);
      return true;
    } catch (error) {
      console.error('发送消息失败:', error);
      return false;
    }
  }

  /**
   * 注册客户端（告知服务器当前监听的房间）
   */
  async registerClient(roomIds: number[]): Promise<boolean> {
    if (!this.isConnected) {
      console.warn('SignalR未连接，无法注册客户端');
      return false;
    }

    try {
      await this.connection.invoke('RegisterClient', roomIds);
      console.log('客户端注册成功');
      return true;
    } catch (error) {
      console.error('客户端注册失败:', error);
      return false;
    }
  }

  /**
   * 请求分配新房间
   */
  async requestRoomAssignment(): Promise<boolean> {
    if (!this.isConnected) {
      console.warn('SignalR未连接，无法请求房间分配');
      return false;
    }

    try {
      await this.connection.invoke('RequestRoomAssignment');
      return true;
    } catch (error) {
      console.error('请求房间分配失败:', error);
      return false;
    }
  }

  /**
   * 计划重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      console.log('尝试重新连接SignalR...');
      const success = await this.connect();

      if (!success && this.autoReconnect) {
        this.scheduleReconnect();
      }
    }, this.reconnectInterval);
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

  // 事件回调
  onRoomAssigned?: (roomId: number) => void;
  onServerDisconnect?: (reason?: string) => void;
}
