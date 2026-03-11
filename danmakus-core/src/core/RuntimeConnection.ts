import { DanmakuMessage, ClientDanmakuMessage } from '../types';
import { ScopedLogger } from './Logger';
import { encodeZstdJson } from './DanmakuUploadCodec';
import { fetchBackendApiWithFallback } from './BackendApiFallback';

type RuntimeEnvelope<T> = {
  code?: number;
  data?: T;
  message?: string;
};

type RequestRoomPayload = {
  reason?: string;
  holdingRooms: number[];
  connectedRooms: number[];
  desiredCount: number;
  capacityOverride?: number;
};

type RequestRoomResponse = {
  holdingRooms: number[];
  newlyAssignedRooms: number[];
  droppedRooms: number[];
  effectiveCapacity: number;
  nextRequestAfter?: number | null;
  shortfall?: {
    reason?: string | null;
    missingCount?: number | null;
    candidateCount?: number | null;
    assignableCandidateCount?: number | null;
    blockedBySameAccountCount?: number | null;
    blockedByOtherAccountsCount?: number | null;
  } | null;
};

type UploadDanmakusResponse = {
  acceptedCount?: number;
  failedCount?: number;
  consumedCount?: number;
  firstError?: string | null;
};

const RUNTIME_REQUEST_TIMEOUT_MS = 10_000;

export class RuntimeConnection {
  private isConnected = false;
  private hasConnectedOnce = false;
  private readonly runtimeBaseUrl: string;
  private readonly token?: string;
  private readonly clientId?: string;
  private readonly passthroughHeaders?: Record<string, string>;

  constructor(
    url: string,
    _autoReconnect: boolean = true,
    _reconnectInterval: number = 5000,
    runtimeHeaders?: Record<string, string>,
    private logger: ScopedLogger = new ScopedLogger('RuntimeConnection')
  ) {
    const runtimeContext = this.resolveRuntimeContext(url, runtimeHeaders);
    this.runtimeBaseUrl = runtimeContext.runtimeBaseUrl;
    this.token = runtimeContext.token;
    this.clientId = runtimeContext.clientId;
    this.passthroughHeaders = runtimeContext.passthroughHeaders;
  }

  async connect(_scheduleOnFailure: boolean = true): Promise<boolean> {
    try {
      if (!this.token) {
        throw new Error('缺少账号 Token，无法建立核心运行态通道');
      }
      if (!this.clientId) {
        throw new Error('缺少 ClientId，无法建立核心运行态通道');
      }

      if (this.isConnected) {
        return true;
      }

      const isReconnect = this.hasConnectedOnce;
      this.isConnected = true;
      this.hasConnectedOnce = true;
      this.logger.info(`${isReconnect ? '已重新连接' : '已连接'}核心运行态接口: ${this.runtimeBaseUrl}`);
      if (isReconnect) {
        this.onReconnected?.();
      } else {
        this.onConnected?.();
      }
      return true;
    } catch (error) {
      this.isConnected = false;
      this.logger.error('核心运行态接口连接失败:', error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    this.isConnected = false;
    this.logger.info('核心运行态接口连接已断开');
  }

  async sendMessage(message: DanmakuMessage): Promise<boolean> {
    return (await this.sendMessages([message])) === 1;
  }

  async sendMessages(messages: DanmakuMessage[]): Promise<number> {
    if (messages.length === 0) {
      return 0;
    }

    if (!this.isConnected) {
      this.logger.warn('核心运行态接口未连接，无法上传弹幕');
      return 0;
    }

    const payload: ClientDanmakuMessage[] = messages.map((msg) => ({
      roomId: msg.roomId,
      raw: this.resolveRawPayload(msg),
      timestamp: msg.timestamp,
    }));

    try {
      const result = await this.requestRuntimeZstd<UploadDanmakusResponse>('/upload-danmakus', payload);

      const consumedCountRaw = Number(result?.consumedCount);
      if (Number.isFinite(consumedCountRaw)) {
        return Math.max(0, Math.min(payload.length, Math.floor(consumedCountRaw)));
      }

      const acceptedCountRaw = Number(result?.acceptedCount);
      return Number.isFinite(acceptedCountRaw)
        ? Math.max(0, Math.min(payload.length, Math.floor(acceptedCountRaw)))
        : payload.length;
    } catch (error) {
      this.logger.error('批量上传弹幕失败:', error);
      return 0;
    }
  }

  async requestRooms(payload: RequestRoomPayload): Promise<RequestRoomResponse | null> {
    if (!this.isConnected) {
      this.logger.warn('核心运行态接口未连接，无法请求房间分配');
      return null;
    }

    try {
      const result = await this.requestRuntime<RequestRoomResponse>('/request-room', {
        method: 'POST',
        body: JSON.stringify({
          clientId: this.clientId,
          reason: payload.reason,
          holdingRooms: payload.holdingRooms,
          connectedRooms: payload.connectedRooms,
          desiredCount: payload.desiredCount,
          capacityOverride: payload.capacityOverride,
        })
      });

      return {
        holdingRooms: this.normalizeRoomIds(result?.holdingRooms),
        newlyAssignedRooms: this.normalizeRoomIds(result?.newlyAssignedRooms),
        droppedRooms: this.normalizeRoomIds(result?.droppedRooms),
        effectiveCapacity: this.normalizeCapacity(result?.effectiveCapacity),
        nextRequestAfter: this.normalizeUnixTime(result?.nextRequestAfter),
        shortfall: result?.shortfall
          ? {
              reason: typeof result.shortfall.reason === 'string' ? result.shortfall.reason : null,
              missingCount: this.normalizeNonNegativeInt(result.shortfall.missingCount),
              candidateCount: this.normalizeNonNegativeInt(result.shortfall.candidateCount),
              assignableCandidateCount: this.normalizeNonNegativeInt(result.shortfall.assignableCandidateCount),
              blockedBySameAccountCount: this.normalizeNonNegativeInt(result.shortfall.blockedBySameAccountCount),
              blockedByOtherAccountsCount: this.normalizeNonNegativeInt(result.shortfall.blockedByOtherAccountsCount),
            }
          : null,
      };
    } catch (error) {
      this.logger.error('请求房间分配失败:', error);
      return null;
    }
  }

  getConnectionState(): boolean {
    return this.isConnected;
  }

  getConnectionId(): string | null {
    return this.clientId ?? null;
  }

  private async requestRuntime<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.token) {
      throw new Error('缺少账号 Token');
    }

    const headers = new Headers(init?.headers ?? {});
    headers.set('Token', this.token);
    if (this.passthroughHeaders) {
      for (const [key, value] of Object.entries(this.passthroughHeaders)) {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      }
    }
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    try {
      const response = await fetchBackendApiWithFallback(fetch, `${this.runtimeBaseUrl}${path}`, {
        ...init,
        headers
      }, {
        timeoutMs: RUNTIME_REQUEST_TIMEOUT_MS,
      });

      return await this.unwrapRuntimeResponse<T>(response);
    } catch (error) {
      this.markDisconnected(error, path);
      throw error;
    }
  }

  private async requestRuntimeZstd<T>(path: string, payload: unknown): Promise<T> {
    if (!this.token) {
      throw new Error('缺少账号 Token');
    }
    if (!this.clientId) {
      throw new Error('缺少 ClientId');
    }

    const headers = new Headers();
    headers.set('Token', this.token);
    headers.set('ClientId', this.clientId);
    if (this.passthroughHeaders) {
      for (const [key, value] of Object.entries(this.passthroughHeaders)) {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      }
    }
    headers.set('Content-Type', 'application/json');
    headers.set('Content-Encoding', 'zstd');

    try {
      const compressedBody = await encodeZstdJson(payload);
      const response = await fetchBackendApiWithFallback(fetch, `${this.runtimeBaseUrl}${path}`, {
        method: 'POST',
        headers,
        body: compressedBody as unknown as BodyInit
      }, {
        timeoutMs: RUNTIME_REQUEST_TIMEOUT_MS,
      });

      return await this.unwrapRuntimeResponse<T>(response);
    } catch (error) {
      this.markDisconnected(error, path);
      throw error;
    }
  }

  private markDisconnected(error: unknown, path: string): void {
    if (!this.isConnected) {
      return;
    }

    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.isConnected = false;
    this.logger.warn(`核心运行态接口请求失败，已标记断线: ${path}`, normalizedError);
    this.onDisconnected?.(normalizedError);
  }

  private async unwrapRuntimeResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json() as RuntimeEnvelope<T> | T
      : await response.text();

    if (!response.ok) {
      const message = typeof payload === 'object' && payload && 'message' in payload
        ? (payload as RuntimeEnvelope<T>).message
        : response.statusText;
      throw new Error(message || '请求失败');
    }

    if (typeof payload === 'object' && payload && 'code' in payload && 'data' in payload) {
      const envelope = payload as RuntimeEnvelope<T>;
      if (envelope.code !== 200) {
        throw new Error(envelope.message || '请求失败');
      }
      return envelope.data as T;
    }

    return payload as T;
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

      if (parsed.pathname.endsWith('/api/v2/core-runtime')) {
        parsed.pathname = parsed.pathname.replace(/\/api\/v2\/core-runtime$/, '/api/v2/core-runtime');
      } else if (parsed.pathname.endsWith('/api/core-runtime')) {
        parsed.pathname = parsed.pathname.replace(/\/api\/core-runtime$/, '/api/core-runtime');
      } else if (parsed.pathname.includes('/api/v2/')) {
        parsed.pathname = '/api/v2/core-runtime';
      } else {
        parsed.pathname = '/api/core-runtime';
      }

      parsed.search = '';
      parsed.hash = '';
      return {
        runtimeBaseUrl: parsed.toString().replace(/\/+$/, ''),
        token,
        clientId,
        passthroughHeaders: Object.keys(passthroughHeaders).length > 0 ? passthroughHeaders : undefined
      };
    } catch {
      const normalized = url.trim();
      let runtimeBaseUrl = normalized;
      if (/\/api\/v2\/core-runtime\b/.test(normalized)) {
        runtimeBaseUrl = normalized.replace(/\/api\/v2\/core-runtime\b/, '/api/v2/core-runtime');
      } else if (/\/api\/core-runtime\b/.test(normalized)) {
        runtimeBaseUrl = normalized.replace(/\/api\/core-runtime\b/, '/api/core-runtime');
      } else if (/\/api\/v2\//.test(normalized)) {
        runtimeBaseUrl = normalized.replace(/\/api\/v2\/.*/, '/api/v2/core-runtime');
      } else {
        runtimeBaseUrl = `${normalized.replace(/\/+$/, '')}/api/core-runtime`;
      }

      return {
        runtimeBaseUrl: runtimeBaseUrl.replace(/\/+$/, ''),
        token,
        clientId,
        passthroughHeaders: Object.keys(passthroughHeaders).length > 0 ? passthroughHeaders : undefined
      };
    }
  }

  private normalizeRoomIds(value: number[] | undefined): number[] {
    return Array.from(new Set(
      (Array.isArray(value) ? value : [])
        .map((roomId) => Number(roomId))
        .filter((roomId) => Number.isFinite(roomId) && roomId > 0)
    ));
  }

  private normalizeCapacity(value: number | undefined): number {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0 ? Math.floor(normalized) : 0;
  }

  private normalizeNonNegativeInt(value: number | null | undefined): number {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized >= 0 ? Math.floor(normalized) : 0;
  }

  private normalizeUnixTime(value: number | null | undefined): number | null {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0 ? Math.floor(normalized) : null;
  }

  private resolveRawPayload(message: DanmakuMessage): string {
    if (typeof message.raw === 'string' && message.raw.trim().length > 0) {
      return message.raw;
    }

    const seen = new WeakSet<object>();
    try {
      const serialized = JSON.stringify(message.data, (_key, item) => {
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
    } catch {
      // keep fallback
    }

    return `[Unserializable Message][cmd=${message.cmd}]`;
  }

  onServerDisconnect?: (reason?: string) => void;
  onConnected?: () => void;
  onDisconnected?: (error?: Error) => void;
  onReconnected?: () => void;
  onSessionInvalid?: (reason: string) => void;
}
