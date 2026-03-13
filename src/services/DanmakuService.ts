import { DanmakuClient } from 'danmakus-core';
import type {
  AuthStateSnapshot,
  CoreControlStateSnapshot as CoreClientControlStateSnapshot,
  DanmakuMessage,
  RuntimeRoomPullShortfallDto,
  StreamerStatus,
} from 'danmakus-core';
import { reactive } from 'vue';
import { biliCookie } from './bilibili';
import {
  cloneAuthState,
  cloneHoldingRoomShortfall,
  cloneRecordingInfo,
  createDefaultCoreConfig,
  createEmptyAuthState,
  normalizeConnectionInfo,
  sortRecordings,
  toRemoteClientSnapshot
} from './danmakuServiceState';
import type { ConnectionInfoSnapshot, RemoteClientSnapshot } from './danmakuServiceState';
import { RUNTIME_URL } from './env';
import { fetchImpl } from './fetchImpl';
import { getAuthToken } from './http';
import type { CoreControlConfigDto, LocalAppConfigDto, RecordingInfoDto, UserInfo } from '../types/api';

const clientIdStorageKey = 'danmakus_client_id';

const generateClientId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `client_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const getOrCreateClientId = (): string => {
  if (typeof localStorage === 'undefined') {
    return generateClientId();
  }
  const existing = localStorage.getItem(clientIdStorageKey)?.trim();
  if (existing) {
    return existing;
  }
  const created = generateClientId();
  localStorage.setItem(clientIdStorageKey, created);
  return created;
};

const hasRuntimeLockConflict = (message: string | null | undefined): boolean => {
  if (!message) {
    return false;
  }

  const normalized = message.replace(/\s+/g, '');
  return normalized.includes('同一IP已存在其他客户端连接');
};

class DanmakuService {
  private static instance: DanmakuService;
  private client: DanmakuClient | null = null;
  private localClientId: string;
  private lastInitializationSignature: string | null = null;

  public state = reactive({
    userInfo: null as UserInfo | null,
    isRunning: false,
    runtimeConnected: false,
    connectedRooms: [] as number[],
    connectionInfo: [] as ConnectionInfoSnapshot[],
    messageCount: 0,
    pendingMessageCount: 0,
    messageCmdCountMap: {} as Record<string, number>,
    roomMessageCountMap: {} as Record<string, number>,
    streamerStatuses: [] as StreamerStatus[],
    holdingRooms: [] as number[],
    holdingRoomShortfall: null as RuntimeRoomPullShortfallDto | null,
    lastError: null as string | null,
    lockConflict: false,
    lockConflictOwnerClientId: null as string | null,
    lastRoomAssigned: null as number | null,
    cookieValid: false,
    authState: createEmptyAuthState() as AuthStateSnapshot,
    lastHeartbeat: null as number | null,
    remoteClients: [] as RemoteClientSnapshot[],
    recordings: [] as RecordingInfoDto[],
    coreConfig: createDefaultCoreConfig(),
    syncTags: {
      configTag: null as string | null,
      clientsTag: null as string | null,
      recordingTag: null as string | null,
    },
  });

  private constructor() {
    this.localClientId = getOrCreateClientId();
  }

  public static getInstance(): DanmakuService {
    if (!DanmakuService.instance) {
      DanmakuService.instance = new DanmakuService();
    }
    return DanmakuService.instance;
  }

  public async initialize(localConfig?: Pick<LocalAppConfigDto, 'cookieCloudKey' | 'cookieCloudPassword' | 'cookieCloudHost' | 'cookieRefreshInterval' | 'capacityOverride'>): Promise<void> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('请先登录并提供 Token');
    }

    const signature = JSON.stringify({
      token,
      cookieCloudKey: localConfig?.cookieCloudKey?.trim() || '',
      cookieCloudPassword: localConfig?.cookieCloudPassword?.trim() || '',
      cookieCloudHost: localConfig?.cookieCloudHost?.trim() || '',
      cookieRefreshInterval: localConfig?.cookieRefreshInterval ?? null,
      capacityOverride: localConfig?.capacityOverride ?? null,
    });

    if (this.client && this.lastInitializationSignature === signature) {
      this.client.startControlSync();
      return;
    }

    await this.disposeExistingClient();

    this.client = new DanmakuClient({
      clientId: this.localClientId,
      fetchImpl,
      cookieProvider: () => biliCookie.getBiliCookie(),
      cookieCloudKey: localConfig?.cookieCloudKey?.trim() || undefined,
      cookieCloudPassword: localConfig?.cookieCloudPassword?.trim() || undefined,
      cookieCloudHost: localConfig?.cookieCloudHost?.trim() || undefined,
      cookieRefreshInterval: localConfig?.cookieRefreshInterval,
      capacityOverride: localConfig?.capacityOverride ?? undefined,
      runtimeHeaders: this.buildRuntimeHeaders(),
      accountToken: token,
      clientVersion: 'desktop',
      runtimeUrl: RUNTIME_URL,
    });
    this.lastInitializationSignature = signature;

    this.setupListeners();
    this.applyStatusSnapshot();
    this.syncCurrentControlState();
    this.client.startControlSync();
  }

  public async refreshControlState(): Promise<void> {
    const snapshot = await this.requireClient().refreshControlState();
    this.applyControlStateSnapshot(snapshot);
  }

  public async refreshRemoteState(): Promise<typeof this.state.syncTags> {
    await this.refreshRuntimeState();
    return { ...this.state.syncTags };
  }

  public async refreshRuntimeState(): Promise<void> {
    const client = this.requireClient();
    this.applyStatusSnapshot();
    const snapshot = await client.refreshRuntimeControlState();
    this.applyControlStateSnapshot(snapshot);
  }

  public async refreshAuthState(options?: { force?: boolean }): Promise<void> {
    await this.requireClient().refreshAuthState(options);
    this.applyStatusSnapshot();
  }

  public async syncCookieCloud(): Promise<void> {
    await this.requireClient().syncCookieCloud();
    this.applyStatusSnapshot();
  }

  public applyLocalConfig(localConfig: Pick<LocalAppConfigDto, 'cookieCloudKey' | 'cookieCloudPassword' | 'cookieCloudHost' | 'cookieRefreshInterval' | 'capacityOverride'>): void {
    if (!this.client) {
      return;
    }

    this.client.updateLocalRuntimeConfig({
      cookieCloudKey: localConfig.cookieCloudKey,
      cookieCloudPassword: localConfig.cookieCloudPassword,
      cookieCloudHost: localConfig.cookieCloudHost,
      cookieRefreshInterval: localConfig.cookieRefreshInterval,
      capacityOverride: localConfig.capacityOverride ?? undefined,
    });
    this.applyStatusSnapshot();
  }

  public async refreshRecordingState(): Promise<void> {
    const snapshot = await this.requireClient().refreshRecordingControlState();
    this.applyControlStateSnapshot(snapshot);
  }

  public async saveCoreConfig(config: CoreControlConfigDto): Promise<void> {
    const snapshot = await this.requireClient().saveCoreConfig(config);
    this.applyControlStateSnapshot(snapshot);
  }

  public async addRecording(uid: number): Promise<RecordingInfoDto> {
    const client = this.requireClient();
    const added = await client.addRecording(uid);
    this.syncCurrentControlState();
    return cloneRecordingInfo(added);
  }

  public async removeRecording(uid: number): Promise<void> {
    const client = this.requireClient();
    await client.removeRecording(uid);
    this.syncCurrentControlState();
  }

  public async updateRecordingPublic(uid: number, isPublic: boolean): Promise<void> {
    const client = this.requireClient();
    await client.updateRecordingPublic(uid, isPublic);
    this.syncCurrentControlState();
  }

  public async forceTakeoverRuntimeState(): Promise<void> {
    const snapshot = await this.requireClient().forceTakeoverRuntimeState();
    this.applyControlStateSnapshot(snapshot);
  }

  public async dispose(): Promise<void> {
    await this.disposeExistingClient();
  }

  public async start(): Promise<void> {
    await this.requireClient().start();
    this.applyStatusSnapshot();
  }

  public async stop(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }

    try {
      await client.stop();
    } finally {
      this.applyStatusSnapshot();
    }
  }

  public getClientId(): string {
    return this.localClientId;
  }

  public getClient(): DanmakuClient | null {
    return this.client;
  }

  private requireClient(): DanmakuClient {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }
    return this.client;
  }

  private syncCurrentControlState(): void {
    this.applyControlStateSnapshot(this.requireClient().getControlState());
  }

  private applyCoreConfigState(config: CoreControlConfigDto): void {
    this.state.coreConfig.maxConnections = config.maxConnections;
    this.state.coreConfig.runtimeUrl = config.runtimeUrl || RUNTIME_URL;
    this.state.coreConfig.autoReconnect = config.autoReconnect;
    this.state.coreConfig.reconnectInterval = config.reconnectInterval;
    this.state.coreConfig.statusCheckInterval = config.statusCheckInterval;
    this.state.coreConfig.requestServerRooms = config.requestServerRooms;
    this.state.coreConfig.allowedAreas = [...config.allowedAreas];
    this.state.coreConfig.allowedParentAreas = [...config.allowedParentAreas];
    this.state.coreConfig.streamers.splice(0, this.state.coreConfig.streamers.length, ...config.streamers.map(item => ({ ...item })));
  }

  private async disposeExistingClient(): Promise<void> {
    let stopError: unknown | undefined;
    if (this.client) {
      this.client.stopControlSync();
      try {
        await this.client.stop();
      } catch (error) {
        stopError = error;
      }
      this.client.removeAllListeners();
      this.client = null;
    }

    this.lastInitializationSignature = null;
    this.resetRuntimeState();
    this.resetControlState();
    if (stopError) {
      throw stopError;
    }
  }

  private resetRuntimeState(): void {
    this.state.isRunning = false;
    this.state.runtimeConnected = false;
    this.state.connectedRooms = [];
    this.state.connectionInfo = [];
    this.state.messageCount = 0;
    this.state.pendingMessageCount = 0;
    this.state.messageCmdCountMap = {};
    this.state.roomMessageCountMap = {};
    this.state.streamerStatuses = [];
    this.state.holdingRooms = [];
    this.state.holdingRoomShortfall = null;
    this.state.lastError = null;
    this.state.lockConflict = false;
    this.state.lockConflictOwnerClientId = null;
    this.state.lastRoomAssigned = null;
    this.state.cookieValid = false;
    this.state.lastHeartbeat = null;
  }

  private resetControlState(): void {
    this.state.userInfo = null;
    this.state.remoteClients = [];
    this.state.recordings = [];
    this.state.authState = createEmptyAuthState();
    this.state.syncTags.configTag = null;
    this.state.syncTags.clientsTag = null;
    this.state.syncTags.recordingTag = null;
    this.applyCoreConfigState(createDefaultCoreConfig());
  }

  private setupListeners(): void {
    if (!this.client) return;

    this.client.on('connected', () => {
      this.state.isRunning = true;
      this.applyStatusSnapshot();
    });

    this.client.on('controlStateChanged', (snapshot) => {
      this.applyControlStateSnapshot(snapshot);
    });

    this.client.on('authStateChanged', (authState) => {
      this.state.authState = cloneAuthState(authState);
      this.state.cookieValid = authState.hasUsableCookie;
    });

    this.client.on('disconnected', () => {
      this.applyStatusSnapshot();
    });

    this.client.on('statusChanged', () => {
      this.applyStatusSnapshot();
    });

    this.client.on('streamerStatusUpdated', (statuses: StreamerStatus[]) => {
      this.state.streamerStatuses = statuses.map(status => ({ ...status }));
    });

    this.client.on('queueChanged', (pendingMessageCount: number) => {
      this.state.pendingMessageCount = pendingMessageCount;
    });

    this.client.on('msg', (message: DanmakuMessage) => {
      this.state.messageCount += 1;
      const cmd = message.cmd;
      this.state.messageCmdCountMap[cmd] = (this.state.messageCmdCountMap[cmd] || 0) + 1;
      const roomKey = String(message.roomId);
      this.state.roomMessageCountMap[roomKey] = (this.state.roomMessageCountMap[roomKey] || 0) + 1;
    });

    this.client.on('error', (error: Error) => {
      this.state.lastError = error.message;
      this.refreshRuntimeIndicators();
    });
  }

  private applyControlStateSnapshot(snapshot: CoreClientControlStateSnapshot): void {
    this.state.userInfo = snapshot.userInfo;
    this.applyCoreConfigState(snapshot.config);
    this.state.recordings = sortRecordings(snapshot.recordings);
    this.state.remoteClients = snapshot.remoteClients.map(toRemoteClientSnapshot);
    this.state.syncTags.configTag = snapshot.tags.configTag;
    this.state.syncTags.clientsTag = snapshot.tags.clientsTag;
    this.state.syncTags.recordingTag = snapshot.tags.recordingTag;
    this.refreshRuntimeIndicators();
  }

  private refreshRuntimeIndicators(): void {
    const normalizedClients = this.state.remoteClients;
    const conflictOwner = normalizedClients
      .filter(client => client.clientId !== this.localClientId)
      .sort((a, b) => (b.lastHeartbeat ?? 0) - (a.lastHeartbeat ?? 0))[0]
      ?? null;

    this.state.lockConflict = hasRuntimeLockConflict(this.state.lastError);
    this.state.lockConflictOwnerClientId = this.state.lockConflict ? (conflictOwner?.clientId ?? null) : null;

    if (!this.client?.getStatus().isRunning && normalizedClients.length === 0) {
      this.state.isRunning = false;
      this.state.runtimeConnected = false;
      this.state.connectedRooms = [];
      this.state.connectionInfo = [];
      this.state.holdingRooms = [];
      this.state.holdingRoomShortfall = null;
      this.state.messageCount = 0;
      this.state.pendingMessageCount = 0;
      this.state.messageCmdCountMap = {};
      this.state.lastRoomAssigned = null;
      this.state.lastError = null;
      this.state.lockConflict = false;
      this.state.lockConflictOwnerClientId = null;
    }
  }

  private applyStatusSnapshot(): void {
    if (!this.client) {
      return;
    }

    const status = this.client.getStatus();
    this.state.isRunning = status.isRunning;
    this.state.runtimeConnected = status.runtimeConnected;
    this.state.connectedRooms = [...status.connectedRooms];
    this.state.connectionInfo = status.connectionInfo.map(normalizeConnectionInfo);
    this.state.cookieValid = status.cookieValid;
    this.state.authState = cloneAuthState(status.authState);
    this.state.holdingRooms = [...status.holdingRooms];
    this.state.holdingRoomShortfall = cloneHoldingRoomShortfall(status.holdingRoomShortfall);
    this.state.messageCount = status.messageCount;
    this.state.pendingMessageCount = status.pendingMessageCount;
    this.state.lastRoomAssigned = status.lastRoomAssigned ?? null;
    this.state.lastError = status.lastError ?? null;
    this.state.lastHeartbeat = status.lastHeartbeat ?? null;
    this.refreshRuntimeIndicators();
  }

  private buildRuntimeHeaders(): Record<string, string> | undefined {
    const token = getAuthToken()?.trim();
    if (!token) {
      return undefined;
    }
    return {
      Token: token,
      ClientId: this.localClientId,
    };
  }
}

export const danmakuService = DanmakuService.getInstance();
