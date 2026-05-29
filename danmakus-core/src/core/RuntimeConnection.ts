import {
  ArchiveUploadRequest,
  ArchiveUploadResponse,
  ClientDanmakuArchiveItem,
  LiveSessionOutboxItem,
} from '../types/index.js';
import { ScopedLogger } from './Logger.js';
import { encodeArchiveUploadEnvelope } from './DanmakuUploadCodec.js';
import { fetchBackendApiWithFallback } from './BackendApiFallback.js';
import { normalizeBinaryPayload } from './RawPacketCodec.js';

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

const RUNTIME_REQUEST_TIMEOUT_MS = 30_000;
const ARCHIVE_COMPRESSION_HEADER = 'X-Archive-Compression';

const toArchiveItem = (record: LiveSessionOutboxItem): ClientDanmakuArchiveItem => ({
  localId: record.id,
  streamerUid: record.streamerUid,
  eventTsMs: record.eventTsMs,
  payload: normalizeBinaryPayload(record.payload),
});

const buildArchiveUploadRequest = (
  items: LiveSessionOutboxItem[],
): ArchiveUploadRequest => ({
  items: items.map(toArchiveItem),
});

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

      this.markConnected();
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

  // 归档上传不检查 isConnected：上传请求成功本身就是恢复连接标记的信号，
  // 失败时由 markDisconnected 标记断线并交给上层重试。requestRooms 则相反，
  // 断线时直接跳过以免无谓地占用房间分配配额。
  async sendArchiveBatch(records: LiveSessionOutboxItem[]): Promise<ArchiveUploadResponse> {
    if (records.length === 0) {
      return {
        rejected: [],
      };
    }

    return await this.requestRuntimeArchive<ArchiveUploadResponse>(
      '/upload-danmakus-v5',
      buildArchiveUploadRequest(records),
    );
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

      const result = await this.unwrapRuntimeResponse<T>(response);
      this.markConnected();
      return result;
    } catch (error) {
      this.markDisconnected(error, path);
      throw error;
    }
  }

  private async requestRuntimeArchive<T>(path: string, payload: unknown): Promise<T> {
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
    headers.set('Content-Type', 'application/x-msgpack');

    try {
      const encoded = await encodeArchiveUploadEnvelope(payload);
      headers.set(ARCHIVE_COMPRESSION_HEADER, encoded.compression);
      const response = await fetchBackendApiWithFallback(fetch, `${this.runtimeBaseUrl}${path}`, {
        method: 'POST',
        headers,
        body: encoded.body as unknown as BodyInit
      }, {
        timeoutMs: RUNTIME_REQUEST_TIMEOUT_MS,
      });

      const result = await this.unwrapRuntimeResponse<T>(response);
      this.markConnected();
      return result;
    } catch (error) {
      this.markDisconnected(error, path);
      throw error;
    }
  }

  private markConnected(): void {
    if (this.isConnected) {
      return;
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

      const alreadyNormalized = parsed.pathname.endsWith('/api/v2/core-runtime')
        || parsed.pathname.endsWith('/api/core-runtime');
      if (!alreadyNormalized) {
        parsed.pathname = parsed.pathname.includes('/api/v2/')
          ? '/api/v2/core-runtime'
          : '/api/core-runtime';
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
      let runtimeBaseUrl: string;
      if (/\/api\/v2\/core-runtime\b/.test(normalized) || /\/api\/core-runtime\b/.test(normalized)) {
        runtimeBaseUrl = normalized;
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

  onConnected?: () => void;
  onDisconnected?: (error?: Error) => void;
  onReconnected?: () => void;
}
