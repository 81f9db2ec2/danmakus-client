import { AccountApiClient } from './AccountApiClient';
import { ScopedLogger } from './Logger';
import { RuntimeConnection } from './RuntimeConnection';
import { CoreRuntimeStateDto, DanmakuConfig, ErrorCategory } from '../types';

const HEARTBEAT_MIN_INTERVAL = 2000;
const LOCK_RETRY_MIN_COUNT = 1;
const LOCK_RETRY_MIN_DELAY = 200;

interface RuntimeSyncErrorContext {
  category?: ErrorCategory;
  code?: string;
  recoverable?: boolean;
  roomId?: number;
}

interface DanmakuRuntimeSyncContext {
  getAccountClient(): AccountApiClient | undefined;
  getRuntimeConnection(): RuntimeConnection | undefined;
  getConfig(): DanmakuConfig;
  getClientId(): string;
  isRunning(): boolean;
  isStopping(): boolean;
  isAutoRegisterSuppressed(): boolean;
  logger: ScopedLogger;
  recordError(error: unknown, context?: RuntimeSyncErrorContext): void;
  buildRuntimeStateSnapshot(): CoreRuntimeStateDto;
  buildRuntimeHeartbeatPayload(): Partial<CoreRuntimeStateDto> & { clientId: string };
  handleAccountConfigTagChange(nextTag: string | null): Promise<void>;
  handleClientsTagChange(nextTag: string | null): Promise<void>;
  handleRecordingTagChange(nextTag: string | null): Promise<void>;
  consumeAssignmentTag(nextTag: string | null): boolean;
  refreshHoldingRoomsIfNeeded(
    maxConnections: number,
    reason: string,
    options?: { force?: boolean }
  ): Promise<boolean>;
  clearHoldingRooms(): void;
  updateConnections(): void;
}

export class DanmakuRuntimeSync {
  private readonly context: DanmakuRuntimeSyncContext;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private lastHeartbeat = 0;
  private heartbeatInterval = 5000;
  private lockAcquireRetryCount = 4;
  private lockAcquireRetryDelay = 1200;
  private lockAcquireForceTakeover = false;
  private runtimeClientRegistering = false;
  private lastRuntimeClientRegisterAt = 0;

  constructor(context: DanmakuRuntimeSyncContext) {
    this.context = context;
  }

  getLastHeartbeat(): number {
    return this.lastHeartbeat;
  }

  applyRuntimeTunings(config: DanmakuConfig): void {
    const heartbeat = Math.floor(config.heartbeatInterval ?? 5000);
    this.heartbeatInterval = Math.max(HEARTBEAT_MIN_INTERVAL, heartbeat);

    const lockRetryCount = Math.floor(config.lockAcquireRetryCount ?? 4);
    this.lockAcquireRetryCount = Math.max(LOCK_RETRY_MIN_COUNT, lockRetryCount);

    const lockRetryDelay = Math.floor(config.lockAcquireRetryDelay ?? 1200);
    this.lockAcquireRetryDelay = Math.max(LOCK_RETRY_MIN_DELAY, lockRetryDelay);

    this.lockAcquireForceTakeover = config.lockAcquireForceTakeover ?? false;
  }

  ensureHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    const beat = async () => {
      this.heartbeatTimer = undefined;
      await this.heartbeatRuntimeState();
      this.ensureHeartbeat();
    };

    this.heartbeatTimer = setTimeout(beat, this.heartbeatInterval);
  }

  clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  async acquireRuntimeLock(): Promise<void> {
    const accountClient = this.context.getAccountClient();
    if (!accountClient) {
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.lockAcquireRetryCount; attempt++) {
      try {
        await this.syncRuntimeState({}, { strict: true });
        if (attempt > 1) {
          this.context.logger.info(`核心锁获取成功 (attempt=${attempt})`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (!this.isLockConflictError(error)) {
          throw error;
        }

        this.context.recordError(error, {
          category: 'lock',
          code: 'LOCK_CONFLICT',
          recoverable: true,
        });

        if (attempt >= this.lockAcquireRetryCount) {
          break;
        }

        const delay = this.lockAcquireRetryDelay * attempt + Math.floor(Math.random() * 300);
        this.context.logger.warn(`核心锁冲突，${delay}ms 后重试 (attempt=${attempt}/${this.lockAcquireRetryCount})`);
        await DanmakuRuntimeSync.waitMs(delay);
      }
    }

    if (this.lockAcquireForceTakeover && this.isLockConflictError(lastError)) {
      this.context.logger.warn('核心锁冲突持续存在，执行 force 接管');
      await this.syncRuntimeState({}, { strict: true, force: true });
      return;
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? '核心锁获取失败'));
  }

  async heartbeatRuntimeState(options?: { force?: boolean; strict?: boolean }): Promise<void> {
    const accountClient = this.context.getAccountClient();
    if (!accountClient) {
      return;
    }

    try {
      const result = await accountClient.heartbeatRuntimeState(this.context.buildRuntimeHeartbeatPayload(), {
        force: options?.force,
      });
      this.lastHeartbeat = Date.now();
      await this.context.handleAccountConfigTagChange(result.configTag);
      await this.context.handleClientsTagChange(result.clientsTag);
      await this.context.handleRecordingTagChange(result.recordingTag);
      if (this.context.consumeAssignmentTag(result.assignmentTag)) {
        await this.context.refreshHoldingRoomsIfNeeded(this.context.getConfig().maxConnections, 'assignment-tag-changed', {
          force: true,
        });
      }

      const runtimeConnection = this.context.getRuntimeConnection();
      if (runtimeConnection && !runtimeConnection.getConnectionState()) {
        await runtimeConnection.connect();
      }
    } catch (error) {
      this.context.recordError(error, {
        category: 'runtime-sync',
        code: 'RUNTIME_HEARTBEAT_FAILED',
        recoverable: true,
      });
      this.context.logger.warn('同步核心心跳失败', error);
      if (options?.strict) {
        throw error;
      }
    }
  }

  async syncRuntimeState(
    overrides: Partial<CoreRuntimeStateDto> = {},
    options?: { force?: boolean; strict?: boolean }
  ): Promise<void> {
    const accountClient = this.context.getAccountClient();
    if (!accountClient) {
      return;
    }

    const fullState = {
      ...this.context.buildRuntimeStateSnapshot(),
      ...overrides,
      clientId: this.context.getClientId(),
    };

    const { lastHeartbeat: _lastHeartbeat, ...payload } = fullState;

    try {
      await accountClient.syncRuntimeState(payload as any, { force: options?.force });
      this.lastHeartbeat = Date.now();
    } catch (error) {
      this.context.recordError(error, {
        category: 'runtime-sync',
        code: 'RUNTIME_SYNC_FAILED',
        recoverable: true,
      });
      this.context.logger.warn('同步核心运行状态失败', error);
      if (options?.strict) {
        throw error;
      }
    }
  }

  triggerRuntimeClientRegistration(reason: 'connected' | 'reconnected'): void {
    if (!this.context.isRunning() || this.context.isStopping() || this.context.isAutoRegisterSuppressed()) {
      return;
    }

    const now = Date.now();
    if (this.runtimeClientRegistering || now - this.lastRuntimeClientRegisterAt < 1000) {
      return;
    }

    this.runtimeClientRegistering = true;
    this.lastRuntimeClientRegisterAt = now;
    this.context.logger.info(`Runtime ${reason} 后重新注册客户端`);
    void this.reRegisterRuntimeClient().finally(() => {
      this.runtimeClientRegistering = false;
    });
  }

  handleRuntimeSessionInvalid(reason: string): void {
    if (!this.context.isRunning() || this.context.isStopping()) {
      return;
    }

    this.context.logger.warn(`检测到 Runtime 会话失效，准备重新注册客户端: ${reason}`);
    this.triggerRuntimeClientRegistration('reconnected');
  }

  async reRegisterRuntimeClient(): Promise<void> {
    const runtimeConnection = this.context.getRuntimeConnection();
    if (!runtimeConnection?.getConnectionState()) {
      return;
    }

    await this.syncRuntimeState({}, { force: true });
    await this.context.refreshHoldingRoomsIfNeeded(this.context.getConfig().maxConnections, 'runtime-reconnect', {
      force: true,
    });

    this.context.updateConnections();
    void this.syncRuntimeState();
  }

  private isLockConflictError(error: unknown): boolean {
    const message = this.getErrorMessage(error);
    return message.includes('同一 IP 已存在其他客户端连接')
      || message.includes('客户端未持有锁')
      || message.includes('423');
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return JSON.stringify(error);
  }

  private static waitMs(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
