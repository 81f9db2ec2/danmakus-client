import {
  ArchiveUploadResponse,
  LiveSessionOutboxItem,
} from '../types/index.js';
import { ScopedLogger } from './Logger.js';
import { resolveCoreRuntimeBaseUrl } from './CoreRuntimeUrl.js';
import type { RuntimeEndpoints } from './RuntimeEndpoints.js';
import { RuntimeWsConnection } from './RuntimeWsConnection.js';
import type {
  DanmakuExtractionRuleSet,
} from './DanmakuExtractionTypes.js';

export class RuntimeConnection {
  private readonly resolvedBaseUrl: string;
  private readonly endpoints?: RuntimeEndpoints;
  private readonly token?: string;
  private readonly clientId?: string;
  private readonly passthroughHeaders?: Record<string, string>;
  private wsConnection?: RuntimeWsConnection;

  constructor(
    url: string,
    _autoReconnect: boolean = true,
    _reconnectInterval: number = 5000,
    runtimeHeaders?: Record<string, string>,
    private logger: ScopedLogger = new ScopedLogger('RuntimeConnection'),
    endpoints?: RuntimeEndpoints
  ) {
    const runtimeContext = this.resolveRuntimeContext(url, runtimeHeaders);
    this.resolvedBaseUrl = runtimeContext.runtimeBaseUrl;
    this.endpoints = endpoints;
    this.token = runtimeContext.token;
    this.clientId = runtimeContext.clientId;
    this.passthroughHeaders = runtimeContext.passthroughHeaders;
    this.ensureWsConnection();
  }

  // 接口地址懒读：注入共享源时始终取其当前值，否则用构造时解析的地址。
  get runtimeBaseUrl(): string {
    return this.endpoints?.getCoreRuntimeBaseUrl() ?? this.resolvedBaseUrl;
  }

  async connect(): Promise<boolean> {
    if (!this.token) {
      throw new Error('缺少账号 Token，无法建立核心运行态通道');
    }
    if (!this.clientId) {
      throw new Error('缺少 ClientId，无法建立核心运行态通道');
    }

    const ws = this.ensureWsConnection();
    if (!ws) {
      return false;
    }

    return await ws.connect();
  }

  async disconnect(): Promise<void> {
    this.wsConnection?.disconnect();
    this.logger.info('核心运行态接口连接已断开');
  }

  async sendArchiveBatch(records: LiveSessionOutboxItem[]): Promise<ArchiveUploadResponse> {
    if (records.length === 0) {
      return {
        rejected: [],
      };
    }

    if (!this.wsConnection?.connected) {
      throw new Error('WebSocket 未连接');
    }

    return await this.wsConnection.sendArchiveBatch(records);
  }

  sendStateReport(state: {
    holdingRooms: number[];
    connectedRooms: number[];
    desiredCount?: number;
    capacity?: number;
    capacityOverride?: number;
    shortfall?: unknown;
    reason?: string;
  }): boolean {
    if (this.wsConnection?.connected) {
      return this.wsConnection.sendStateReport(state);
    }
    return false;
  }

  setCallbacks(callbacks: {
    onStreamerStatusPush?: (updates: any[]) => void;
    onRoomAssignPush?: (data: any) => void;
    onExtractionRules?: (rules: DanmakuExtractionRuleSet) => void;
  }): void {
    this.wsConnection?.setCallbacks(callbacks);
  }

  getConnectionState(): boolean {
    return this.wsConnection?.connected ?? false;
  }

  private ensureWsConnection(): RuntimeWsConnection | undefined {
    if (!this.token || !this.clientId) {
      return undefined;
    }

    if (!this.wsConnection) {
      this.wsConnection = new RuntimeWsConnection({
        runtimeUrl: this.runtimeBaseUrl,
        token: this.token,
        clientId: this.clientId,
        headers: this.passthroughHeaders,
        onConnected: () => {
          this.onConnected?.();
        },
        onDisconnected: (error?: Error) => {
          this.onDisconnected?.(error);
        },
        onReconnected: () => {
          this.onReconnected?.();
        },
      }, this.logger);
    }

    return this.wsConnection;
  }

  private resolveRuntimeContext(
    url: string,
    headers?: Record<string, string>
  ): {
    runtimeBaseUrl: string;
    token?: string;
    clientId?: string;
    passthroughHeaders?: Record<string, string>;
  } {
    let token = headers?.Token;
    let clientId = headers?.ClientId;
    const passthroughHeaders = { ...(headers ?? {}) };
    delete passthroughHeaders.Token;
    delete passthroughHeaders.ClientId;

    try {
      const parsed = new URL(url);
      token = token || parsed.searchParams.get('token') || undefined;
      clientId = clientId || parsed.searchParams.get('clientId') || undefined;
    } catch {
      // 非完整 URL 时无法解析 query 参数，token/clientId 仅来自 headers。
    }

    return {
      runtimeBaseUrl: resolveCoreRuntimeBaseUrl(url),
      token,
      clientId,
      passthroughHeaders: Object.keys(passthroughHeaders).length > 0 ? passthroughHeaders : undefined
    };
  }

  onConnected?: () => void;
  onDisconnected?: (error?: Error) => void;
  onReconnected?: () => void;
}
