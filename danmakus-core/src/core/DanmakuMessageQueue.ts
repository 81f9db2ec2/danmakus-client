import {
  DanmakuConfig,
  ErrorCategory,
  LiveSessionOutboxItem,
  LiveSessionOutboxRescheduleUpdate,
  LiveSessionOutboxStore,
} from '../types/index.js';
import { ScopedLogger } from './Logger.js';
import type { RuntimeConnection } from './RuntimeConnection.js';

const MESSAGE_RETRY_MIN_DELAY = 200;
const MESSAGE_RETRY_MIN_ATTEMPTS = 1;
const MESSAGE_BATCH_MIN_SIZE = 1;
const MESSAGE_BATCH_MAX_SIZE = 500;
const MESSAGE_UPLOAD_INTERVAL_MS = 2000;
const OUTBOX_PERSIST_INTERVAL_MS = 1000;
const OUTBOX_BLOCKED_LOG_INTERVAL_MS = 10_000;

interface QueuedPacket {
  roomId: number;
  streamerUid: number | null;
  receivedTsMs: number;
  payload: Uint8Array;
  retryCount: number;
  nextRetryAt: number;
}

interface QueueErrorContext {
  category?: ErrorCategory;
  code?: string;
  recoverable?: boolean;
  roomId?: number;
}

interface DanmakuMessageQueueContext {
  isRunning(): boolean;
  isStopping(): boolean;
  getRuntimeConnection(): Pick<RuntimeConnection, 'sendArchiveBatch'> | undefined;
  getLiveSessionOutbox(): LiveSessionOutboxStore | undefined;
  resolveRecordingStreamerUid(roomId: number): number | null;
  logger: ScopedLogger;
  recordError(error: unknown, context?: QueueErrorContext): void;
  emitError(error: Error, roomId?: number): void;
  emitQueueChanged(pendingCount: number): void;
}

const normalizeStreamerUid = (value: number | null): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.floor(value);
};

export class DanmakuMessageQueue {
  private readonly context: DanmakuMessageQueueContext;
  private pendingPackets: QueuedPacket[] = [];
  private messageDispatchTimer?: ReturnType<typeof setTimeout>;
  private messageDispatching = false;
  private outboxUploading = false;
  private pendingDispatchDelayMs?: number;
  private outboxBlockedLastLogAt = 0;
  private messageRetryBaseDelay = 1000;
  private messageRetryMaxDelay = 30_000;
  private messageRetryMaxAttempts = 6;
  private messageBatchSize = 500;
  private readonly messageUploadInterval = MESSAGE_UPLOAD_INTERVAL_MS;
  private outboxPendingCount = 0;
  private outboxCountInitialized = false;

  constructor(context: DanmakuMessageQueueContext) {
    this.context = context;
  }

  getPendingCount(): number {
    return this.pendingPackets.length + this.outboxPendingCount;
  }

  getFailedCount(): number {
    return 0;
  }

  getMessageBatchSize(): number {
    return this.messageBatchSize;
  }

  getUploadInterval(): number {
    return this.messageUploadInterval;
  }

  async refreshArchiveStats(): Promise<void> {
    const outbox = this.context.getLiveSessionOutbox();
    if (!outbox) {
      this.outboxPendingCount = 0;
      this.outboxCountInitialized = true;
      this.emitPendingCountChanged();
      return;
    }

    this.outboxPendingCount = await outbox.countPending();
    this.outboxCountInitialized = true;
    this.emitPendingCountChanged();
  }

  resetState(): void {
    this.clearMessageDispatch();
    this.clearPendingPackets();
    this.outboxUploading = false;
    this.outboxPendingCount = 0;
    this.outboxCountInitialized = false;
    this.emitPendingCountChanged();
  }

  enqueuePacket(roomId: number, payload: Uint8Array, receivedTsMs: number = Date.now()): void {
    if (!this.context.isRunning() || this.context.isStopping() || payload.length === 0) {
      return;
    }

    this.pendingPackets.push({
      roomId,
      streamerUid: this.context.resolveRecordingStreamerUid(roomId),
      receivedTsMs,
      payload: payload.slice(),
      retryCount: 0,
      nextRetryAt: Date.now(),
    });

    this.emitPendingCountChanged();
    if (this.context.getLiveSessionOutbox()) {
      this.scheduleMessageDispatch(OUTBOX_PERSIST_INTERVAL_MS);
      return;
    }
    this.scheduleMessageDispatch(this.messageUploadInterval);
  }

  clearPendingPackets(): void {
    for (const queued of this.pendingPackets) {
      this.releaseQueuedPacket(queued);
    }
    this.pendingPackets = [];
    this.emitPendingCountChanged();
  }

  scheduleMessageDispatch(delayMs: number = this.messageUploadInterval): void {
    if (!this.hasPendingWork()) {
      if (this.messageDispatchTimer) {
        clearTimeout(this.messageDispatchTimer);
        this.messageDispatchTimer = undefined;
      }
      this.pendingDispatchDelayMs = undefined;
      return;
    }

    const delay = Math.max(0, Math.floor(delayMs));
    if (this.messageDispatching) {
      this.pendingDispatchDelayMs = typeof this.pendingDispatchDelayMs === 'number'
        ? Math.min(this.pendingDispatchDelayMs, delay)
        : delay;
      return;
    }

    if (this.messageDispatchTimer) {
      if (delay > 0) {
        return;
      }
      clearTimeout(this.messageDispatchTimer);
      this.messageDispatchTimer = undefined;
    }

    this.messageDispatchTimer = setTimeout(() => {
      this.messageDispatchTimer = undefined;
      void this.flushPendingMessages().catch(error => {
        this.handleFlushError(error);
      });
    }, delay);
  }

  clearMessageDispatch(): void {
    if (this.messageDispatchTimer) {
      clearTimeout(this.messageDispatchTimer);
      this.messageDispatchTimer = undefined;
    }
    this.messageDispatching = false;
    this.pendingDispatchDelayMs = undefined;
  }

  async flushPendingMessages(): Promise<void> {
    if (this.context.isStopping() || !this.context.isRunning()) {
      return;
    }

    const outbox = this.context.getLiveSessionOutbox();
    if (!outbox) {
      return;
    }

    await this.persistBufferedPackets(outbox);
    await this.startOutboxUpload(outbox);
  }

  private async persistBufferedPackets(outbox: LiveSessionOutboxStore): Promise<void> {
    if (this.messageDispatching || this.context.isStopping() || !this.context.isRunning()) {
      return;
    }

    this.messageDispatching = true;
    try {
      await this.ensureOutboxCountInitialized(outbox);
      await this.persistDueBufferedPackets(outbox, Date.now());
    } finally {
      this.messageDispatching = false;
      this.scheduleNextDispatchIfNeeded();
    }
  }

  applyRuntimeTunings(config: DanmakuConfig): void {
    const retryBaseDelay = Math.floor(config.messageRetryBaseDelay ?? 1000);
    this.messageRetryBaseDelay = Math.max(MESSAGE_RETRY_MIN_DELAY, retryBaseDelay);

    const retryMaxDelay = Math.floor(config.messageRetryMaxDelay ?? 30_000);
    this.messageRetryMaxDelay = Math.max(this.messageRetryBaseDelay, retryMaxDelay);

    const retryMaxAttempts = Math.floor(config.messageRetryMaxAttempts ?? 6);
    this.messageRetryMaxAttempts = Math.max(MESSAGE_RETRY_MIN_ATTEMPTS, retryMaxAttempts);

    const batchSize = Math.floor(config.batchUploadSize ?? 500);
    this.messageBatchSize = Math.min(MESSAGE_BATCH_MAX_SIZE, Math.max(MESSAGE_BATCH_MIN_SIZE, batchSize));
  }

  private async startOutboxUpload(outbox: LiveSessionOutboxStore): Promise<void> {
    if (this.outboxUploading) {
      return;
    }

    await this.uploadDueOutboxRecords(outbox).catch(error => {
      this.handleFlushError(error);
    });
  }

  private async uploadDueOutboxRecords(outbox: LiveSessionOutboxStore): Promise<void> {
    if (this.outboxUploading || this.context.isStopping() || !this.context.isRunning()) {
      return;
    }

    this.outboxUploading = true;
    try {
      await this.ensureOutboxCountInitialized(outbox);
      const now = Date.now();

      const runtimeConnection = this.context.getRuntimeConnection();
      if (!runtimeConnection) {
        this.logOutboxBlocked(`runtime 未连接: pendingBuffered=${this.pendingPackets.length}, pendingOutbox=${this.outboxPendingCount}`);
        if (this.hasPendingWork()) {
          this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, this.messageRetryBaseDelay));
        }
        return;
      }

      const dueRecords = await outbox.listDue({
        nowMs: now,
        limit: this.messageBatchSize,
      });
      if (dueRecords.length === 0) {
        return;
      }

      await this.uploadOutboxBatch(outbox, runtimeConnection, dueRecords, now);
    } finally {
      this.outboxUploading = false;
      this.scheduleNextDispatchIfNeeded();
    }
  }

  private async persistDueBufferedPackets(outbox: LiveSessionOutboxStore, now: number): Promise<void> {
    const dueItems = this.pendingPackets.filter(item => item.nextRetryAt <= now);
    if (dueItems.length === 0) {
      const nextRetryAt = this.pendingPackets.reduce<number | null>(
        (current, item) => current === null ? item.nextRetryAt : Math.min(current, item.nextRetryAt),
        null,
      );
      if (typeof nextRetryAt === 'number' && nextRetryAt > now) {
        this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, nextRetryAt - now));
      }
      return;
    }

    const persistableItems: QueuedPacket[] = [];
    const inserts = [];
    const unresolvedItems: QueuedPacket[] = [];
    for (const item of dueItems) {
      const normalizedStreamerUid = normalizeStreamerUid(item.streamerUid ?? this.context.resolveRecordingStreamerUid(item.roomId));
      if (normalizedStreamerUid === null) {
        unresolvedItems.push(item);
        continue;
      }

      item.streamerUid = normalizedStreamerUid;
      persistableItems.push(item);
      inserts.push({
        streamerUid: normalizedStreamerUid,
        eventTsMs: item.receivedTsMs,
        payload: item.payload,
      });
    }

    this.dropUnresolvedStreamerPackets(unresolvedItems);
    if (persistableItems.length === 0) {
      return;
    }

    try {
      const inserted = await outbox.append(inserts);
      if (inserted !== persistableItems.length) {
        throw new Error(`live session outbox 写入数量异常: expected=${persistableItems.length}, actual=${inserted}`);
      }

      const persistedSet = new Set(persistableItems);
      this.pendingPackets = this.pendingPackets.filter(item => {
        if (!persistedSet.has(item)) {
          return true;
        }
        this.releaseQueuedPacket(item);
        return false;
      });
      this.outboxPendingCount += inserted;
      this.outboxCountInitialized = true;
      this.emitPendingCountChanged();
    } catch (error) {
      const reason = this.getErrorMessage(error);
      for (const item of persistableItems) {
        this.retryBufferedPacket(item, now, reason);
      }
    }
  }

  private dropUnresolvedStreamerPackets(items: QueuedPacket[]): void {
    if (items.length === 0) {
      return;
    }

    const droppedSet = new Set(items);
    this.pendingPackets = this.pendingPackets.filter(item => {
      if (!droppedSet.has(item)) {
        return true;
      }
      this.releaseQueuedPacket(item);
      return false;
    });

    const roomIds = Array.from(new Set(items.map(item => item.roomId))).join(',') || 'unknown';
    const error = new Error(`消息缺少 streamerUid，已丢弃 ${items.length} 条无法归档消息: rooms=${roomIds}`);
    this.context.recordError(error, {
      category: 'queue',
      code: 'MESSAGE_STREAMER_UID_MISSING',
      recoverable: true,
      roomId: items[0]?.roomId,
    });
    this.context.emitError(error, items[0]?.roomId);
    this.logOutboxBlocked(`${error.message}, pendingBuffered=${this.pendingPackets.length}`);
    this.emitPendingCountChanged();
  }

  private async uploadOutboxBatch(
    outbox: LiveSessionOutboxStore,
    runtimeConnection: Pick<RuntimeConnection, 'sendArchiveBatch'>,
    records: LiveSessionOutboxItem[],
    now: number,
  ): Promise<void> {
    try {
      const response = await runtimeConnection.sendArchiveBatch(records);
      const rejectedById = new Map(
        (response.rejected ?? [])
          .filter(item => item && Number.isFinite(Number(item.localId)) && Number(item.localId) > 0)
          .map(item => [Math.floor(Number(item.localId)), item] as const),
      );
      const deleted = await outbox.ack(records.map(record => record.id));
      this.outboxPendingCount = Math.max(0, this.outboxPendingCount - deleted);
      this.emitPendingCountChanged();

      const rejectedRecords = records
        .map(record => {
          const rejected = rejectedById.get(record.id);
          return rejected
            ? { record, code: rejected.code, message: rejected.message }
            : null;
        })
        .filter((item): item is { record: LiveSessionOutboxItem; code: string; message: string } => item !== null);
      if (rejectedRecords.length > 0) {
        this.emitRejectedOutboxErrors(rejectedRecords);
      }
    } catch (error) {
      const retryUpdates: LiveSessionOutboxRescheduleUpdate[] = [];

      for (const record of records) {
        const retryCount = record.retryCount + 1;
        retryUpdates.push({
          id: record.id,
          retryCount,
          nextRetryAtMs: now + this.calculateMessageRetryDelay(retryCount),
        });
      }

      if (retryUpdates.length > 0) {
        await outbox.reschedule(retryUpdates);
      }

      this.emitPendingCountChanged();
      this.context.logger.error('live session outbox 上传失败:', error);
    }
  }

  private emitRejectedOutboxErrors(rejectedRecords: Array<{
    record: LiveSessionOutboxItem;
    code: string;
    message: string;
  }>): void {
    const summaries = new Map<string, {
      streamerUid: number;
      code: string;
      message: string;
      count: number;
      firstLocalId: number;
    }>();

    for (const item of rejectedRecords) {
      const key = `${item.record.streamerUid}:${item.code}\u0000${item.message}`;
      const existing = summaries.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }

      summaries.set(key, {
        streamerUid: item.record.streamerUid,
        code: item.code,
        message: item.message,
        count: 1,
        firstLocalId: item.record.id,
      });
    }

    for (const summary of summaries.values()) {
      const localIdText = summary.count > 1
        ? `count=${summary.count}, firstLocalId=${summary.firstLocalId}`
        : `localId=${summary.firstLocalId}`;
      this.context.emitError(new Error(
        `归档弹幕被后端拒绝: streamerUid=${summary.streamerUid}, ${localIdText}, code=${summary.code}, err=${summary.message}`
      ));
    }
  }

  private retryBufferedPacket(item: QueuedPacket, now: number, reason: string): void {
    item.retryCount += 1;
    if (item.retryCount >= this.messageRetryMaxAttempts) {
      this.pendingPackets = this.pendingPackets.filter(candidate => candidate !== item);
      this.context.emitError(new Error(`消息落 session outbox 失败且重试次数已耗尽: room=${item.roomId}, err=${reason}`), item.roomId);
      this.releaseQueuedPacket(item);
      this.emitPendingCountChanged();
      return;
    }

    const delay = this.calculateMessageRetryDelay(item.retryCount);
    item.nextRetryAt = now + delay;
    this.context.logger.warn(
      `消息落 session outbox 失败，${delay}ms 后重试 (room=${item.roomId}, retry=${item.retryCount}, err=${reason})`
    );
    this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, delay));
  }

  private async ensureOutboxCountInitialized(outbox: LiveSessionOutboxStore): Promise<void> {
    if (this.outboxCountInitialized) {
      return;
    }

    this.outboxPendingCount = await outbox.countPending();
    this.outboxCountInitialized = true;
    this.emitPendingCountChanged();
  }

  private emitPendingCountChanged(): void {
    this.context.emitQueueChanged(this.getPendingCount());
  }

  private scheduleNextDispatchIfNeeded(): void {
    if (this.hasPendingWork() && !this.messageDispatchTimer && this.context.isRunning() && !this.context.isStopping()) {
      const nextDelay = this.pendingDispatchDelayMs ?? this.messageUploadInterval;
      this.pendingDispatchDelayMs = undefined;
      this.scheduleMessageDispatch(nextDelay);
      return;
    }

    this.pendingDispatchDelayMs = undefined;
  }

  private hasPendingWork(): boolean {
    return this.pendingPackets.length > 0
      || this.outboxPendingCount > 0
      || (!!this.context.getLiveSessionOutbox() && !this.outboxCountInitialized);
  }

  private releaseQueuedPacket(queued?: QueuedPacket): void {
    if (queued) {
      queued.payload = new Uint8Array(0);
    }
  }

  private logOutboxBlocked(message: string): void {
    const now = Date.now();
    if (now - this.outboxBlockedLastLogAt < OUTBOX_BLOCKED_LOG_INTERVAL_MS) {
      return;
    }

    this.outboxBlockedLastLogAt = now;
    this.context.logger.warn(message);
  }

  private calculateMessageRetryDelay(retryCount: number): number {
    const exponential = this.messageRetryBaseDelay * (2 ** Math.max(0, retryCount - 1));
    return Math.min(exponential, this.messageRetryMaxDelay);
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private handleFlushError(error: unknown): void {
    this.context.recordError(error, {
      category: 'queue',
      code: 'MESSAGE_FLUSH_FAILED',
      recoverable: true,
    });
    this.context.logger.error('live session outbox 调度失败:', error);
  }
}
