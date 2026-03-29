import {
  DanmakuConfig,
  DanmakuMessage,
  ErrorCategory,
  LiveSessionOutboxItem,
  LiveSessionOutboxRescheduleUpdate,
  LiveSessionOutboxStore,
} from '../types/index.js';
import { compressRawPacket } from './RawPacketCodec.js';
import { ScopedLogger } from './Logger.js';
import type { RuntimeConnection } from './RuntimeConnection.js';

const MESSAGE_QUEUE_MIN_SIZE = 100;
const MESSAGE_RETRY_MIN_DELAY = 200;
const MESSAGE_RETRY_MIN_ATTEMPTS = 1;
const MESSAGE_BATCH_MIN_SIZE = 1;
const MESSAGE_BATCH_MAX_SIZE = 500;
const MESSAGE_UPLOAD_INTERVAL_MS = 2000;
const OUTBOX_PERSIST_MAX_BATCH_SIZE = 100;
const QUEUE_OVERFLOW_LOG_INTERVAL_MS = 10_000;
const OUTBOX_BLOCKED_LOG_INTERVAL_MS = 10_000;
const MESSAGE_DEDUP_WINDOW_MS = 2_000;
const MESSAGE_DEDUP_CACHE_LIMIT = 4_000;

interface QueuedMessage {
  message: DanmakuMessage;
  streamerUid: number | null;
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
  getRuntimeConnection(): Pick<RuntimeConnection, 'getConnectionState' | 'sendArchiveBatch'> | undefined;
  getLiveSessionOutbox(): LiveSessionOutboxStore | undefined;
  resolveRecordingStreamerUid(roomId: number): number | null;
  logger: ScopedLogger;
  recordError(error: unknown, context?: QueueErrorContext): void;
  emitError(error: Error, roomId?: number): void;
  emitQueueChanged(pendingCount: number): void;
}

export class DanmakuMessageQueue {
  private readonly context: DanmakuMessageQueueContext;
  private readonly recentMessageDedup = new Map<string, number>();
  private pendingMessages: QueuedMessage[] = [];
  private messageDispatchTimer?: ReturnType<typeof setTimeout>;
  private messageDispatching = false;
  private pendingDispatchDelayMs?: number;
  private messageQueueMaxSize = 20000;
  private queueOverflowLastLogAt = 0;
  private queueOverflowSuppressedCount = 0;
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
    return this.pendingMessages.length + this.outboxPendingCount;
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

  clearRecentMessageDedup(): void {
    this.recentMessageDedup.clear();
  }

  getPendingMessages(): readonly DanmakuMessage[] {
    return this.pendingMessages.map(item => item.message);
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
    this.clearPendingMessages();
    this.outboxPendingCount = 0;
    this.outboxCountInitialized = false;
    this.queueOverflowLastLogAt = 0;
    this.queueOverflowSuppressedCount = 0;
    this.clearRecentMessageDedup();
    this.emitPendingCountChanged();
  }

  isDuplicateIncomingMessage(message: DanmakuMessage): boolean {
    const dedupKey = this.buildIncomingMessageDedupKey(message);
    if (!dedupKey) {
      return false;
    }

    const now = Date.now();
    this.pruneRecentMessageDedup(now);
    const previousTimestamp = this.recentMessageDedup.get(dedupKey);
    if (typeof previousTimestamp === 'number' && now - previousTimestamp <= MESSAGE_DEDUP_WINDOW_MS) {
      this.context.logger.debug(`跳过重复消息: room=${message.roomId}, cmd=${message.cmd}`);
      return true;
    }

    this.recentMessageDedup.set(dedupKey, now);
    return false;
  }

  enqueueMessage(message: DanmakuMessage): void {
    if (!this.context.isRunning() || this.context.isStopping()) {
      return;
    }

    if (this.pendingMessages.length >= this.messageQueueMaxSize) {
      const dropped = this.pendingMessages.shift();
      const queueError = new Error(`消息队列已满(${this.messageQueueMaxSize})，最早消息已丢弃`);
      this.context.recordError(queueError, {
        category: 'queue',
        code: 'QUEUE_OVERFLOW',
        recoverable: true,
        roomId: dropped?.message.roomId,
      });
      this.logQueueOverflow(queueError, dropped);
      this.context.emitError(queueError, dropped?.message.roomId);
      this.releaseQueuedMessage(dropped);
    }

    this.pendingMessages.push({
      message: {
        roomId: message.roomId,
        cmd: message.cmd,
        data: undefined,
        raw: message.raw,
        timestamp: message.timestamp,
      },
      streamerUid: this.context.resolveRecordingStreamerUid(message.roomId),
      retryCount: 0,
      nextRetryAt: Date.now(),
    });

    this.emitPendingCountChanged();
    if (this.context.getLiveSessionOutbox() && this.pendingMessages.length >= this.getOutboxPersistBatchSize()) {
      this.scheduleMessageDispatch(0);
      return;
    }
    this.scheduleMessageDispatch(this.messageUploadInterval);
  }

  clearPendingMessages(): void {
    for (const queued of this.pendingMessages) {
      this.releaseQueuedMessage(queued);
    }
    this.pendingMessages = [];
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
      void this.flushPendingMessages();
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
    if (this.messageDispatching || this.context.isStopping() || !this.context.isRunning()) {
      return;
    }

    this.messageDispatching = true;
    try {
      const outbox = this.context.getLiveSessionOutbox();
      if (!outbox) {
        return;
      }
      await this.flushLiveSessionOutbox(outbox);
    } finally {
      this.messageDispatching = false;
      if (this.hasPendingWork() && !this.messageDispatchTimer && this.context.isRunning() && !this.context.isStopping()) {
        const nextDelay = this.pendingDispatchDelayMs ?? this.messageUploadInterval;
        this.pendingDispatchDelayMs = undefined;
        this.scheduleMessageDispatch(nextDelay);
      } else {
        this.pendingDispatchDelayMs = undefined;
      }
    }
  }

  applyRuntimeTunings(config: DanmakuConfig): void {
    const queueSize = Math.floor(config.messageQueueMaxSize ?? 20000);
    this.messageQueueMaxSize = Math.max(MESSAGE_QUEUE_MIN_SIZE, queueSize);
    if (this.pendingMessages.length > this.messageQueueMaxSize) {
      const overflowCount = this.pendingMessages.length - this.messageQueueMaxSize;
      const dropped = this.pendingMessages.splice(0, overflowCount);
      for (const item of dropped) {
        this.releaseQueuedMessage(item);
      }
      this.emitPendingCountChanged();
      this.context.logger.warn(`消息队列容量调整后丢弃 ${overflowCount} 条待发送消息`);
    }

    const retryBaseDelay = Math.floor(config.messageRetryBaseDelay ?? 1000);
    this.messageRetryBaseDelay = Math.max(MESSAGE_RETRY_MIN_DELAY, retryBaseDelay);

    const retryMaxDelay = Math.floor(config.messageRetryMaxDelay ?? 30_000);
    this.messageRetryMaxDelay = Math.max(this.messageRetryBaseDelay, retryMaxDelay);

    const retryMaxAttempts = Math.floor(config.messageRetryMaxAttempts ?? 6);
    this.messageRetryMaxAttempts = Math.max(MESSAGE_RETRY_MIN_ATTEMPTS, retryMaxAttempts);

    const batchSize = Math.floor(config.batchUploadSize ?? 500);
    this.messageBatchSize = Math.min(MESSAGE_BATCH_MAX_SIZE, Math.max(MESSAGE_BATCH_MIN_SIZE, batchSize));
  }

  private async flushLiveSessionOutbox(outbox: LiveSessionOutboxStore): Promise<void> {
    await this.ensureOutboxCountInitialized(outbox);
    const now = Date.now();
    await this.persistDueBufferedMessages(outbox, now);

    const runtimeConnection = this.context.getRuntimeConnection();
    if (!runtimeConnection?.getConnectionState()) {
      this.logOutboxBlocked(`runtime 未连接: pendingBuffered=${this.pendingMessages.length}, pendingOutbox=${this.outboxPendingCount}`);
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
  }

  private async persistDueBufferedMessages(outbox: LiveSessionOutboxStore, now: number): Promise<void> {
    const dueItems = this.pendingMessages
      .filter(item => item.nextRetryAt <= now)
      .slice(0, this.getOutboxPersistBatchSize());

    if (dueItems.length === 0) {
      const nextRetryAt = this.pendingMessages.reduce<number | null>(
        (current, item) => current === null ? item.nextRetryAt : Math.min(current, item.nextRetryAt),
        null,
      );
      if (typeof nextRetryAt === 'number' && nextRetryAt > now) {
        this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, nextRetryAt - now));
      }
      return;
    }

    const persistableItems: QueuedMessage[] = [];
    const inserts = [];
    for (const item of dueItems) {
      const resolvedStreamerUid = item.streamerUid ?? this.context.resolveRecordingStreamerUid(item.message.roomId);
      if (typeof resolvedStreamerUid !== 'number' || !Number.isFinite(resolvedStreamerUid) || resolvedStreamerUid <= 0) {
        continue;
      }

      const normalizedStreamerUid = Math.floor(resolvedStreamerUid);
      item.streamerUid = normalizedStreamerUid;
      persistableItems.push(item);
      inserts.push({
        streamerUid: normalizedStreamerUid,
        eventTsMs: item.message.timestamp,
        payload: await compressRawPacket(item.message.raw),
      });
    }

    if (persistableItems.length === 0) {
      const unresolvedRoomIds = Array.from(new Set(
        dueItems
          .filter(item => {
            const resolvedStreamerUid = item.streamerUid ?? this.context.resolveRecordingStreamerUid(item.message.roomId);
            return !(typeof resolvedStreamerUid === 'number' && Number.isFinite(resolvedStreamerUid) && resolvedStreamerUid > 0);
          })
          .map(item => item.message.roomId)
      ));
      this.logOutboxBlocked(
        `消息暂无法落本地 outbox: 未解析到 streamerUid, rooms=${unresolvedRoomIds.join(',') || 'unknown'}, pendingBuffered=${this.pendingMessages.length}`,
      );
      this.scheduleMessageDispatch(this.messageUploadInterval);
      return;
    }

    try {
      const inserted = await outbox.append(inserts);
      if (inserted !== persistableItems.length) {
        throw new Error(`live session outbox 写入数量异常: expected=${persistableItems.length}, actual=${inserted}`);
      }

      const persistedSet = new Set(persistableItems);
      this.pendingMessages = this.pendingMessages.filter(item => {
        if (!persistedSet.has(item)) {
          return true;
        }
        this.releaseQueuedMessage(item);
        return false;
      });
      this.outboxPendingCount += inserted;
      this.outboxCountInitialized = true;
      this.emitPendingCountChanged();
    } catch (error) {
      const reason = this.getErrorMessage(error);
      for (const item of persistableItems) {
        this.retryBufferedMessage(item, now, reason);
      }
    }
  }

  private async uploadOutboxBatch(
    outbox: LiveSessionOutboxStore,
    runtimeConnection: Pick<RuntimeConnection, 'sendArchiveBatch'>,
    records: LiveSessionOutboxItem[],
    now: number,
  ): Promise<void> {
    try {
      const response = await runtimeConnection.sendArchiveBatch(records);
      const ackedIds = [...new Set(
        (response.ackedLocalIds ?? [])
          .map(id => Number(id))
          .filter(id => Number.isFinite(id) && id > 0)
          .map(id => Math.floor(id)),
      )];

      if (ackedIds.length > 0) {
        const deleted = await outbox.ack(ackedIds);
        this.outboxPendingCount = Math.max(0, this.outboxPendingCount - deleted);
      }

      const rejectedById = new Map(
        (response.rejected ?? [])
          .filter(item => item && Number.isFinite(Number(item.localId)) && Number(item.localId) > 0)
          .map(item => [Math.floor(Number(item.localId)), item] as const),
      );
      const ackedIdSet = new Set(ackedIds);

      const retryUpdates: LiveSessionOutboxRescheduleUpdate[] = [];
      const rejectedIds: number[] = [];
      const rejectedRecords: Array<{
        record: LiveSessionOutboxItem;
        code: string;
        message: string;
      }> = [];
      for (const record of records) {
        if (ackedIdSet.has(record.id)) {
          continue;
        }

        const rejected = rejectedById.get(record.id);
        if (rejected) {
          rejectedIds.push(record.id);
          rejectedRecords.push({
            record,
            code: rejected.code,
            message: rejected.message,
          });
          continue;
        }

        const retryCount = record.retryCount + 1;
        retryUpdates.push({
          id: record.id,
          retryCount,
          nextRetryAtMs: now + this.calculateMessageRetryDelay(retryCount),
        });
      }

      if (rejectedIds.length > 0) {
        const deleted = await outbox.ack(rejectedIds);
        this.outboxPendingCount = Math.max(0, this.outboxPendingCount - deleted);
        if (deleted !== rejectedIds.length) {
          throw new Error(`live session outbox 删除 rejected 记录数量异常: expected=${rejectedIds.length}, actual=${deleted}`);
        }
      }
      if (retryUpdates.length > 0) {
        await outbox.reschedule(retryUpdates);
      }
      this.emitPendingCountChanged();
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

  private retryBufferedMessage(item: QueuedMessage, now: number, reason: string): void {
    item.retryCount += 1;
    if (item.retryCount >= this.messageRetryMaxAttempts) {
      this.pendingMessages = this.pendingMessages.filter(candidate => candidate !== item);
      this.context.emitError(new Error(`消息落 session outbox 失败且重试次数已耗尽: room=${item.message.roomId}, cmd=${item.message.cmd}, err=${reason}`), item.message.roomId);
      this.releaseQueuedMessage(item);
      this.emitPendingCountChanged();
      return;
    }

    const delay = this.calculateMessageRetryDelay(item.retryCount);
    item.nextRetryAt = now + delay;
    this.context.logger.warn(
      `消息落 session outbox 失败，${delay}ms 后重试 (room=${item.message.roomId}, cmd=${item.message.cmd}, retry=${item.retryCount}, err=${reason})`
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

  private getOutboxPersistBatchSize(): number {
    return Math.min(this.messageBatchSize, OUTBOX_PERSIST_MAX_BATCH_SIZE);
  }

  private hasPendingWork(): boolean {
    return this.pendingMessages.length > 0
      || this.outboxPendingCount > 0
      || (!!this.context.getLiveSessionOutbox() && !this.outboxCountInitialized);
  }

  private releaseQueuedMessage(queued?: QueuedMessage): void {
    if (!queued) {
      return;
    }

    queued.message.raw = '';
    queued.message.data = undefined;
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

    this.context.logger.error(`${queueError.message}${throttleHint}`, {
      roomId: dropped?.message.roomId,
      cmd: dropped?.message.cmd,
    });
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

  private buildIncomingMessageDedupKey(message: DanmakuMessage): string | null {
    if (message.roomId <= 0 || typeof message.raw !== 'string' || message.raw.length === 0) {
      return null;
    }

    return `${message.roomId}:${message.cmd}:${message.raw}`;
  }

  private pruneRecentMessageDedup(now: number = Date.now()): void {
    if (this.recentMessageDedup.size === 0) {
      return;
    }

    for (const [key, timestamp] of this.recentMessageDedup) {
      if (now - timestamp > MESSAGE_DEDUP_WINDOW_MS) {
        this.recentMessageDedup.delete(key);
      }
    }

    while (this.recentMessageDedup.size > MESSAGE_DEDUP_CACHE_LIMIT) {
      const oldestKey = this.recentMessageDedup.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.recentMessageDedup.delete(oldestKey);
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
