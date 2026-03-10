import { DanmakuConfig, DanmakuMessage, ErrorCategory } from '../types';
import { ScopedLogger } from './Logger';
import type { RuntimeConnection } from './RuntimeConnection';

const MESSAGE_QUEUE_MIN_SIZE = 100;
const MESSAGE_RETRY_MIN_DELAY = 200;
const MESSAGE_RETRY_MIN_ATTEMPTS = 1;
const MESSAGE_BATCH_MIN_SIZE = 1;
const MESSAGE_BATCH_MAX_SIZE = 500;
const MESSAGE_UPLOAD_INTERVAL_MS = 2000;
const QUEUE_OVERFLOW_LOG_INTERVAL_MS = 10_000;
const MESSAGE_DEDUP_WINDOW_MS = 2_000;
const MESSAGE_DEDUP_CACHE_LIMIT = 4_000;

interface QueuedMessage {
  message: DanmakuMessage;
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
  getRuntimeConnection(): Pick<RuntimeConnection, 'getConnectionState' | 'sendMessages'> | undefined;
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
  private messageQueueMaxSize = 2000;
  private queueOverflowLastLogAt = 0;
  private queueOverflowSuppressedCount = 0;
  private messageRetryBaseDelay = 1000;
  private messageRetryMaxDelay = 30_000;
  private messageRetryMaxAttempts = 6;
  private messageBatchSize = 500;
  private readonly messageUploadInterval = MESSAGE_UPLOAD_INTERVAL_MS;

  constructor(context: DanmakuMessageQueueContext) {
    this.context = context;
  }

  getPendingCount(): number {
    return this.pendingMessages.length;
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

  resetState(): void {
    this.clearMessageDispatch();
    this.clearPendingMessages();
    this.queueOverflowLastLogAt = 0;
    this.queueOverflowSuppressedCount = 0;
    this.clearRecentMessageDedup();
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

    const queuedMessage: DanmakuMessage = {
      roomId: message.roomId,
      cmd: message.cmd,
      data: undefined,
      raw: message.raw,
      timestamp: message.timestamp,
      recorderEventType: message.recorderEventType,
      recorderEventMessage: message.recorderEventMessage,
    };

    this.pendingMessages.push({
      message: queuedMessage,
      retryCount: 0,
      nextRetryAt: Date.now(),
    });

    this.context.emitQueueChanged(this.pendingMessages.length);
    this.scheduleMessageDispatch(this.messageUploadInterval);
  }

  clearPendingMessages(): void {
    for (const queued of this.pendingMessages) {
      this.releaseQueuedMessage(queued);
    }
    this.pendingMessages = [];
    this.context.emitQueueChanged(this.pendingMessages.length);
  }

  scheduleMessageDispatch(delayMs: number = this.messageUploadInterval): void {
    if (this.pendingMessages.length === 0) {
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
      if (this.pendingMessages.length === 0) {
        return;
      }

      const now = Date.now();
      const queued = this.pendingMessages[0];

      if (queued.nextRetryAt > now) {
        this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, queued.nextRetryAt - now));
        return;
      }

      const runtimeConnection = this.context.getRuntimeConnection();
      if (!runtimeConnection?.getConnectionState()) {
        this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, this.messageRetryBaseDelay));
        return;
      }

      const batch: QueuedMessage[] = [];
      for (const item of this.pendingMessages) {
        if (item.nextRetryAt > now || batch.length >= this.messageBatchSize) {
          break;
        }
        batch.push(item);
      }
      if (batch.length === 0) {
        this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, this.messageRetryBaseDelay));
        return;
      }

      const sentCount = await runtimeConnection.sendMessages(batch.map(item => item.message));
      if (sentCount > 0) {
        const sentMessages = this.pendingMessages.splice(0, sentCount);
        for (const sent of sentMessages) {
          this.releaseQueuedMessage(sent);
        }
        this.context.emitQueueChanged(this.pendingMessages.length);
        return;
      }

      const failed = this.pendingMessages[0];
      failed.retryCount += 1;
      if (failed.retryCount >= this.messageRetryMaxAttempts) {
        const dropped = this.pendingMessages.shift();
        if (!dropped) {
          return;
        }
        const { roomId, cmd } = dropped.message;
        const sendError = new Error(`消息上行失败: room=${roomId}, cmd=${cmd}, retry=${dropped.retryCount}`);
        this.context.recordError(sendError, {
          category: 'runtime',
          code: 'MESSAGE_UPLOAD_FAILED',
          roomId,
          recoverable: false,
        });
        this.context.emitError(sendError, roomId);
        this.releaseQueuedMessage(dropped);
        this.context.emitQueueChanged(this.pendingMessages.length);
        return;
      }

      const delay = this.calculateMessageRetryDelay(failed.retryCount);
      failed.nextRetryAt = now + delay;
      this.context.logger.warn(
        `消息上行失败，${delay}ms 后重试 (room=${failed.message.roomId}, cmd=${failed.message.cmd}, retry=${failed.retryCount})`
      );
      this.scheduleMessageDispatch(Math.max(this.messageUploadInterval, delay));
    } finally {
      this.messageDispatching = false;
      if (this.pendingMessages.length > 0 && !this.messageDispatchTimer && this.context.isRunning() && !this.context.isStopping()) {
        const nextDelay = this.pendingDispatchDelayMs ?? this.messageUploadInterval;
        this.pendingDispatchDelayMs = undefined;
        this.scheduleMessageDispatch(nextDelay);
      } else {
        this.pendingDispatchDelayMs = undefined;
      }
    }
  }

  applyRuntimeTunings(config: DanmakuConfig): void {
    const queueSize = Math.floor(config.messageQueueMaxSize ?? 2000);
    this.messageQueueMaxSize = Math.max(MESSAGE_QUEUE_MIN_SIZE, queueSize);
    if (this.pendingMessages.length > this.messageQueueMaxSize) {
      const overflowCount = this.pendingMessages.length - this.messageQueueMaxSize;
      const dropped = this.pendingMessages.splice(0, overflowCount);
      for (const item of dropped) {
        this.releaseQueuedMessage(item);
      }
      this.context.emitQueueChanged(this.pendingMessages.length);
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
}
