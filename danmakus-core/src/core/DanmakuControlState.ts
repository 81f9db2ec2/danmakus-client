import { AccountApiClient } from './AccountApiClient';
import { ScopedLogger } from './Logger';
import {
  CoreControlConfigDto,
  CoreControlStateSnapshot,
  CoreRuntimeStateDto,
  CoreSyncTagSnapshot,
  RecordingInfoDto,
  UserInfo,
} from '../types';

const CONTROL_SYNC_INTERVAL_MS = 5000;

interface ControlStateErrorContext {
  category?: 'config' | 'runtime-sync' | 'unknown';
  code?: string;
  recoverable?: boolean;
}

interface DanmakuControlStateContext {
  requireAccountClient(): AccountApiClient;
  getOptionalAccountClient(): AccountApiClient | undefined;
  isRunning(): boolean;
  isStopping(): boolean;
  logger: ScopedLogger;
  emitError(error: Error): void;
  emitControlStateChanged(): void;
  getControlState(): CoreControlStateSnapshot;
  applyAccountConfigSnapshot(remoteConfig: CoreControlConfigDto, nextTag: string | null): Promise<void>;
  recordError(error: unknown, context?: ControlStateErrorContext): void;
  syncRuntimeState(overrides?: Partial<CoreRuntimeStateDto>, options?: { force?: boolean; strict?: boolean }): Promise<void>;
  refreshHoldingRoomsIfNeeded(maxConnections: number, reason: string, options?: { force?: boolean }): Promise<boolean>;
  updateConnections(): void;
  refreshStatusNow(): void;
  replaceUserInfo(userInfo: UserInfo | null): void;
  replaceRemoteClients(remoteClients: CoreRuntimeStateDto[]): void;
  replaceRecordings(recordings: RecordingInfoDto[]): void;
  getRecordingRoomIds(): number[];
  getAccountConfigTag(): string | null;
  getClientsTag(): string | null;
  getRecordingTag(): string | null;
  updateSyncTags(tags: Partial<CoreSyncTagSnapshot>): void;
  areRoomIdsEqual(left: number[], right: number[]): boolean;
}

export class DanmakuControlState {
  private readonly context: DanmakuControlStateContext;
  private controlSyncTimer?: ReturnType<typeof setTimeout>;
  private controlSyncRefreshing = false;
  private accountConfigRefreshing = false;

  constructor(context: DanmakuControlStateContext) {
    this.context = context;
  }

  async refreshControlState(): Promise<CoreControlStateSnapshot> {
    this.context.requireAccountClient();

    await this.refreshUserInfo();
    await this.pullAccountConfig();
    await this.refreshRecordingList(true);
    await this.refreshRemoteClients(true);
    this.context.emitControlStateChanged();
    return this.context.getControlState();
  }

  async refreshRuntimeControlState(): Promise<CoreControlStateSnapshot> {
    this.context.requireAccountClient();

    await this.refreshRemoteClients(true);
    return this.context.getControlState();
  }

  async refreshRecordingControlState(): Promise<CoreControlStateSnapshot> {
    this.context.requireAccountClient();

    await this.refreshRecordingList(true);
    return this.context.getControlState();
  }

  startControlSync(): void {
    this.scheduleControlSync(0);
  }

  stopControlSync(): void {
    if (!this.controlSyncTimer) {
      return;
    }

    clearTimeout(this.controlSyncTimer);
    this.controlSyncTimer = undefined;
  }

  async saveCoreConfig(config: CoreControlConfigDto): Promise<CoreControlStateSnapshot> {
    const accountClient = this.context.requireAccountClient();
    const result = await accountClient.updateCoreConfig(config);
    await this.context.applyAccountConfigSnapshot(result.data, result.tags.configTag);
    this.updateSyncTags(result.tags);
    this.context.emitControlStateChanged();
    return this.context.getControlState();
  }

  async addRecording(uid: number): Promise<RecordingInfoDto> {
    const accountClient = this.context.requireAccountClient();
    const result = await accountClient.addRecording(uid);
    this.updateSyncTags(result.tags);
    await this.refreshRecordingList(true);
    return result.data;
  }

  async removeRecording(uid: number): Promise<void> {
    const accountClient = this.context.requireAccountClient();
    const result = await accountClient.removeRecording(uid);
    this.updateSyncTags(result.tags);
    await this.refreshRecordingList(true);
  }

  async updateRecordingPublic(uid: number, isPublic: boolean): Promise<void> {
    const accountClient = this.context.requireAccountClient();
    const result = await accountClient.updateRecordingSetting([
      {
        id: uid,
        setting: { isPublic },
      },
    ]);

    if (!result.data.includes(uid)) {
      throw new Error('更新录制公开状态失败');
    }

    this.updateSyncTags(result.tags);
    await this.refreshRecordingList(true);
  }

  async forceTakeoverRuntimeState(): Promise<CoreControlStateSnapshot> {
    await this.context.syncRuntimeState({}, { strict: true, force: true });
    await this.refreshRemoteClients(true);
    this.context.emitControlStateChanged();
    return this.context.getControlState();
  }

  async handleAccountConfigTagChange(nextTag: string | null): Promise<void> {
    if (nextTag === null || nextTag === this.context.getAccountConfigTag()) {
      return;
    }

    await this.refreshAccountConfig(nextTag);
  }

  async handleClientsTagChange(nextTag: string | null): Promise<void> {
    if (nextTag === null || nextTag === this.context.getClientsTag()) {
      return;
    }

    await this.refreshRemoteClients(true, nextTag);
  }

  async handleRecordingTagChange(nextTag: string | null): Promise<void> {
    if (nextTag === null || nextTag === this.context.getRecordingTag()) {
      return;
    }

    await this.refreshRecordingList(true, nextTag);
  }

  updateSyncTags(tags: CoreSyncTagSnapshot): void {
    this.context.updateSyncTags(tags);
  }

  async refreshUserInfo(): Promise<void> {
    const accountClient = this.context.getOptionalAccountClient();
    if (!accountClient) {
      return;
    }

    this.context.replaceUserInfo(await accountClient.getUserInfo());
    this.context.emitControlStateChanged();
  }

  async pullAccountConfig(): Promise<void> {
    const accountClient = this.context.getOptionalAccountClient();
    if (!accountClient) {
      return;
    }

    const remoteConfig = await accountClient.getCoreConfig();
    await this.context.applyAccountConfigSnapshot(remoteConfig, accountClient.getCoreConfigTag());
  }

  async refreshRemoteClients(force: boolean, nextTag: string | null = null): Promise<void> {
    const accountClient = this.context.getOptionalAccountClient();
    if (!accountClient) {
      return;
    }
    if (!force && (nextTag === null || nextTag === this.context.getClientsTag())) {
      return;
    }

    const result = await accountClient.getCoreClients();
    this.context.replaceRemoteClients(result.data);
    this.updateSyncTags(result.tags);
    if (nextTag !== null) {
      this.context.updateSyncTags({ clientsTag: nextTag });
    }
    this.context.emitControlStateChanged();
  }

  async refreshRecordingList(force: boolean, nextTag: string | null = null): Promise<void> {
    const accountClient = this.context.getOptionalAccountClient();
    if (!accountClient) {
      return;
    }
    if (!force && (nextTag === null || nextTag === this.context.getRecordingTag())) {
      return;
    }

    const result = await accountClient.getRecordingList();
    const previousRecordingRoomIds = [...this.context.getRecordingRoomIds()];
    this.context.replaceRecordings(result.data);
    this.updateSyncTags(result.tags);
    if (nextTag !== null) {
      this.context.updateSyncTags({ recordingTag: nextTag });
    }
    if (
      this.context.isRunning()
      && !this.context.isStopping()
      && !this.context.areRoomIdsEqual(previousRecordingRoomIds, this.context.getRecordingRoomIds())
    ) {
      this.context.refreshStatusNow();
      await this.context.refreshHoldingRoomsIfNeeded(
        this.context.getControlState().config.maxConnections,
        'recording-list-changed',
        { force: true }
      );
      this.context.updateConnections();
    }
    this.context.emitControlStateChanged();
  }

  async refreshAccountConfig(nextTag: string): Promise<void> {
    const accountClient = this.context.getOptionalAccountClient();
    if (!accountClient || this.accountConfigRefreshing || this.context.isStopping()) {
      return;
    }

    this.accountConfigRefreshing = true;
    try {
      const remoteConfig = await accountClient.getCoreConfig();
      await this.context.applyAccountConfigSnapshot(remoteConfig, accountClient.getCoreConfigTag() ?? nextTag);
    } catch (error) {
      this.context.recordError(error, { category: 'config', code: 'HOT_RELOAD_FAILED', recoverable: true });
      this.context.emitError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.accountConfigRefreshing = false;
    }
  }

  private scheduleControlSync(delayMs: number): void {
    if (this.controlSyncTimer || !this.context.getOptionalAccountClient() || this.context.isStopping()) {
      return;
    }

    const delay = Math.max(0, Math.floor(delayMs));
    this.controlSyncTimer = setTimeout(() => {
      this.controlSyncTimer = undefined;
      void this.pollControlState();
    }, delay);
  }

  private async pollControlState(): Promise<void> {
    const accountClient = this.context.getOptionalAccountClient();
    if (!accountClient || this.controlSyncRefreshing || this.context.isStopping()) {
      return;
    }

    this.controlSyncRefreshing = true;
    try {
      if (!this.context.isRunning()) {
        const tags = await accountClient.getCoreHeartbeatTags();
        await this.handleAccountConfigTagChange(tags.configTag);
        await this.handleClientsTagChange(tags.clientsTag);
        await this.handleRecordingTagChange(tags.recordingTag);
      }
    } catch (error) {
      this.context.recordError(error, { category: 'runtime-sync', code: 'CONTROL_SYNC_FAILED', recoverable: true });
      this.context.logger.warn('同步控制面板数据失败', error);
    } finally {
      this.controlSyncRefreshing = false;
      if (this.context.getOptionalAccountClient() && !this.context.isStopping()) {
        this.scheduleControlSync(CONTROL_SYNC_INTERVAL_MS);
      }
    }
  }
}
