import {
  ArchiveUploadRejectedItem,
  ArchiveUploadResponse,
  LiveSessionOutboxItem,
} from '../types/index.js';
import { ScopedLogger } from './Logger.js';
import { encodeArchiveUploadEnvelope } from './DanmakuUploadCodec.js';
import { normalizeBinaryPayload } from './RawPacketCodec.js';
import {
  CoreWsOpCode,
  decodeMsgPackPayload,
  decodeWsFrame,
  encodeMsgPackPayload,
  encodeWsFrame,
} from './CoreWebSocketCodec.js';
import type {
  DanmakuExtractionRuleSet,
  ExtractedUploadBatch,
  ExtractedUploadEvent,
} from './DanmakuExtractionTypes.js';
import { DEFAULT_CORE_CLIENT_VERSION } from '../version.js';

export interface ServerPushRoomAssignPayload {
  holdingRooms: number[];
  newlyAssigned: number[];
  dropped: number[];
  effectiveCapacity?: number;
  nextRequestAfter?: number;
  shortfall?: any;
}

export interface RuntimeWsConnectionOptions {
  runtimeUrl: string;
  token?: string;
  clientId?: string;
  version?: string;
  headers?: Record<string, string>;
  onConnected?: () => void;
  onDisconnected?: (error?: Error) => void;
  onReconnected?: () => void;
  onStreamerStatusPush?: (updates: Array<{
    roomId: number;
    uId?: number;
    isLive: boolean;
    title?: string;
    username?: string;
    faceUrl?: string;
    viewerCount?: number;
    liveStartTime?: number;
  }>) => void;
  onRoomAssignPush?: (data: ServerPushRoomAssignPayload) => void;
  onExtractionRules?: (rules: DanmakuExtractionRuleSet) => void;
  getStateReportPayload?: () => {
    holdingRooms: number[];
    connectedRooms: number[];
    desiredCount?: number;
    capacity?: number;
    capacityOverride?: number;
    reason?: string;
  } | null;
}

const WS_CONNECT_TIMEOUT_MS = 10_000;
const WS_REQUEST_TIMEOUT_MS = 30_000;
const WS_PING_INTERVAL_MS = 15_000;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RuntimeWsConnection {
  private ws?: WebSocket;
  private isConnected = false;
  private isConnecting = false;
  private hasConnectedOnce = false;
  private isClosedExplicitly = false;
  private nextSeq = 1;
  private pingTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private pendingUploads = new Map<number, PendingRequest<ArchiveUploadResponse>>();
  private logger: ScopedLogger;

  constructor(
    private options: RuntimeWsConnectionOptions,
    logger?: ScopedLogger,
  ) {
    this.logger = logger ?? new ScopedLogger('RuntimeWsConnection');
  }

  get connected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<boolean> {
    if (this.connected) {
      return true;
    }
    if (this.isConnecting) {
      return false;
    }
    if (!this.options.token || !this.options.clientId) {
      this.logger.warn('缺少 Token 或 ClientId，跳过 WebSocket 连接');
      return false;
    }

    this.isConnecting = true;
    this.isClosedExplicitly = false;

    try {
      const wsUrl = this.resolveWsUrl(this.options.runtimeUrl);
      this.logger.info(`正在建立 WebSocket 连接: ${wsUrl}`);

      if (this.ws) {
        const previous = this.ws;
        this.ws = undefined;
        previous.onclose = null;
        previous.onmessage = null;
        previous.onerror = null;
        previous.onopen = null;
        if (previous.readyState === WebSocket.OPEN || previous.readyState === WebSocket.CONNECTING) {
          try {
            previous.close();
          } catch {
            // ignore
          }
        }
      }

      const ws = this.options.headers && Object.keys(this.options.headers).length > 0
        ? new (WebSocket as any)(wsUrl, { headers: this.options.headers })
        : new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      const connected = await new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (value: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        };
        const timeout = setTimeout(() => {
          this.logger.warn('WebSocket 连接/鉴权超时');
          try {
            ws.close();
          } catch {
            // ignore
          }
          settle(false);
        }, WS_CONNECT_TIMEOUT_MS);

        ws.onopen = async () => {
          try {
            const authPayload = encodeMsgPackPayload({
              token: this.options.token,
              clientId: this.options.clientId,
              version: this.options.version || DEFAULT_CORE_CLIENT_VERSION,
            });
            const frame = encodeWsFrame(CoreWsOpCode.CLIENT_AUTH, 0, authPayload);
            ws.send(frame as any);
          } catch (err) {
            this.logger.error('发送鉴权帧失败', err);
            settle(false);
          }
        };

        ws.onmessage = (event: any) => {
          try {
            const data = new Uint8Array(event.data as ArrayBuffer);
            const frame = decodeWsFrame(data);

            if (frame.opCode === CoreWsOpCode.SERVER_AUTH_RESULT) {
              const result = decodeMsgPackPayload<{
                success: boolean;
                serverTime: number;
                error?: string;
                extractionRules?: DanmakuExtractionRuleSet;
              }>(frame.payload);
              if (result.success) {
                // 规则非法时 setRules 抛错：先应用规则再置连接态，避免半连接（isConnected=true 但从不 settle）
                if (result.extractionRules) {
                  try {
                    this.options.onExtractionRules?.(result.extractionRules);
                  } catch (error) {
                    this.logger.error('服务端解析规则无效，放弃本次连接', error);
                    ws.close();
                    settle(false);
                    return;
                  }
                }
                const isReconnect = this.hasConnectedOnce;
                this.ws = ws;
                this.isConnected = true;
                this.hasConnectedOnce = true;
                this.reconnectAttempts = 0;
                this.logger.info(`WebSocket 鉴权成功，长连接已${isReconnect ? '重新' : ''}建立`);
                if (isReconnect) {
                  this.options.onReconnected?.();
                } else {
                  this.options.onConnected?.();
                }
                settle(true);
              } else {
                this.logger.error(`WebSocket 鉴权拒绝: ${result.error}`);
                ws.close();
                settle(false);
              }
              return;
            }

            this.handleFrame(frame);
          } catch (error) {
            this.logger.error('处理 WebSocket 消息帧异常', error);
          }
        };

        ws.onerror = (error: any) => {
          this.logger.warn('WebSocket 错误', error);
        };

        ws.onclose = () => {
          if (this.ws !== undefined && this.ws !== ws) {
            return;
          }
          this.ws = undefined;
          this.handleDisconnect();
          settle(false);
        };
      });

      if (connected) {
        this.startPing();
      } else if (!this.isClosedExplicitly && this.hasConnectedOnce) {
        this.scheduleReconnect();
      }

      return connected;
    } catch (error) {
      this.logger.error('WebSocket 连接异常', error);
      if (!this.isClosedExplicitly && this.hasConnectedOnce) {
        this.scheduleReconnect();
      }
      return false;
    } finally {
      this.isConnecting = false;
    }
  }

  disconnect(): void {
    this.isClosedExplicitly = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectAllPending(new Error('WebSocket 已主动断开'));
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.isConnected = false;
  }

  async sendArchiveBatch(records: LiveSessionOutboxItem[]): Promise<ArchiveUploadResponse> {
    if (records.length === 0) {
      return { rejected: [] };
    }
    if (!this.connected || !this.ws) {
      throw new Error('WebSocket 未连接');
    }

    const seq = this.nextSeq++;
    const events: ExtractedUploadEvent[] = [];
    for (const record of records) {
      const payloadBytes = normalizeBinaryPayload(record.payload);
      try {
        const decoded = decodeMsgPackPayload<ExtractedUploadEvent>(payloadBytes);
        decoded.localId = record.id;
        decoded.streamerUid = record.streamerUid;
        decoded.eventTsMs = record.eventTsMs;
        events.push(decoded);
      } catch (error) {
        throw new Error(
          `outbox 记录 ${record.id} 不是结构化提取事件: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const batch: ExtractedUploadBatch = {
      events,
    };

    const encoded = await encodeArchiveUploadEnvelope(batch);
    const frame = encodeWsFrame(CoreWsOpCode.CLIENT_UPLOAD_DANMAKU, seq, encoded.body as Uint8Array);

    return await new Promise<ArchiveUploadResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUploads.delete(seq);
        reject(new Error(`WebSocket 上传批次超时 (seq=${seq})`));
      }, WS_REQUEST_TIMEOUT_MS);

      this.pendingUploads.set(seq, { resolve, reject, timer });
      try {
        this.ws!.send(frame as any);
      } catch (err) {
        clearTimeout(timer);
        this.pendingUploads.delete(seq);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
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
    if (!this.connected || !this.ws) {
      return false;
    }
    const seq = this.nextSeq++;
    const payload = encodeMsgPackPayload({
      ...state,
      clientId: this.options.clientId,
    });
    const frame = encodeWsFrame(CoreWsOpCode.CLIENT_STATE_REPORT, seq, payload);
    try {
      this.ws.send(frame as any);
      return true;
    } catch (err) {
      this.logger.warn('发送状态汇报失败', err);
      return false;
    }
  }

  setCallbacks(callbacks: {
    onStreamerStatusPush?: RuntimeWsConnectionOptions['onStreamerStatusPush'];
    onRoomAssignPush?: RuntimeWsConnectionOptions['onRoomAssignPush'];
    onExtractionRules?: RuntimeWsConnectionOptions['onExtractionRules'];
    getStateReportPayload?: RuntimeWsConnectionOptions['getStateReportPayload'];
  }): void {
    if (callbacks.onStreamerStatusPush) {
      this.options.onStreamerStatusPush = callbacks.onStreamerStatusPush;
    }
    if (callbacks.onRoomAssignPush) {
      this.options.onRoomAssignPush = callbacks.onRoomAssignPush;
    }
    if (callbacks.onExtractionRules) {
      this.options.onExtractionRules = callbacks.onExtractionRules;
    }
    if (callbacks.getStateReportPayload) {
      this.options.getStateReportPayload = callbacks.getStateReportPayload;
    }
  }

  private handleFrame(frame: { opCode: number; seq: number; payload: Uint8Array }): void {
    switch (frame.opCode) {
      case CoreWsOpCode.SERVER_UPLOAD_ACK: {
        const pending = this.pendingUploads.get(frame.seq);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingUploads.delete(frame.seq);
          const ack = decodeMsgPackPayload<{
            acceptedCount?: number;
            rejected?: Array<{ localId?: number; code?: string; message?: string }>;
            code?: string;
            error?: string;
          }>(frame.payload);
          pending.resolve({
            acceptedCount: ack.acceptedCount ?? 0,
            rejected: (ack.rejected ?? [])
              .map((item) => {
                const localId = Math.floor(Number(item?.localId));
                if (!Number.isFinite(localId) || localId <= 0) {
                  return null;
                }
                return {
                  localId,
                  code: String(item.code ?? ''),
                  message: String(item.message ?? ''),
                };
              })
              .filter((item): item is ArchiveUploadRejectedItem => item !== null),
            code: ack.code,
            error: ack.error,
          });
        }
        break;
      }

      case CoreWsOpCode.SERVER_PUSH_STREAMER_STATUS: {
        const payload = decodeMsgPackPayload<{ updates: any[] }>(frame.payload);
        if (Array.isArray(payload.updates)) {
          this.options.onStreamerStatusPush?.(payload.updates);
        }
        break;
      }

      case CoreWsOpCode.SERVER_PUSH_ROOM_ASSIGN: {
        const payload = decodeMsgPackPayload<ServerPushRoomAssignPayload>(frame.payload);
        this.options.onRoomAssignPush?.(payload);
        break;
      }

      case CoreWsOpCode.SERVER_ERROR_NOTIFY: {
        const err = decodeMsgPackPayload<{ code: string; message: string }>(frame.payload);
        this.logger.warn(`收到服务端错误通知: [${err.code}] ${err.message}`);
        break;
      }
    }
  }

  private handleDisconnect(error?: Error): void {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.ws = undefined;
    this.stopPing();
    this.rejectAllPending(new Error('WebSocket 连接已关闭'));

    if (wasConnected) {
      this.options.onDisconnected?.(error);
    }

    if (!this.isClosedExplicitly) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isClosedExplicitly || this.connected) {
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, Math.min(this.reconnectAttempts - 1, 8)), 10_000) + Math.floor(Math.random() * 500);
    this.logger.info(`WebSocket 将在 ${delay}ms 后尝试重连 (attempt=${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (this.isClosedExplicitly || this.connected) {
        return;
      }
      try {
        const ok = await this.connect();
        if (!ok && !this.isClosedExplicitly && !this.connected) {
          this.scheduleReconnect();
        }
      } catch (err) {
        this.logger.warn('重连尝试异常', err);
        if (!this.isClosedExplicitly && !this.connected) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws) {
        try {
          const reportPayload = this.options.getStateReportPayload?.();
          if (reportPayload) {
            this.sendStateReport({
              ...reportPayload,
              reason: reportPayload.reason || 'heartbeat-sync',
            });
          } else {
            // 发送轻量状态上报或空帧保持活跃
            const pingFrame = encodeWsFrame(CoreWsOpCode.CLIENT_STATE_REPORT, 0);
            this.ws.send(pingFrame as any);
          }
        } catch {
          // 忽略 ping 发送错误
        }
      }
    }, WS_PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingUploads.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingUploads.clear();
  }

  private resolveWsUrl(runtimeUrl: string): string {
    const url = new URL(runtimeUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (!url.pathname.endsWith('/ws')) {
      url.pathname = url.pathname.replace(/\/+$/, '') + '/ws';
    }
    return url.toString();
  }
}
