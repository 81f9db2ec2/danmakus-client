import { DanmakuClient } from 'danmakus-core';
import type {
  CoreControlStateSnapshot as CoreClientControlStateSnapshot,
  CoreRuntimeStateDto as CoreClientRuntimeStateDto,
  DanmakuMessage,
  StreamerStatus,
} from 'danmakus-core';
import { reactive } from 'vue';
import { biliCookie, getLiveWsRoomConfigAsync, getNavProfileAsync } from './bilibili';
import { ACCOUNT_API_BASE, RUNTIME_URL } from './env';
import { fetchImpl } from './fetchImpl';
import { getAuthToken } from './http';
import type { CoreControlConfigDto, LocalAppConfigDto, RecordingInfoDto, UserInfo } from '../types/api';

type ConnectionInfoSnapshot = { roomId: number; priority: string; connectedAt: number };

type RemoteClientSnapshot = {
  clientId: string;
  clientVersion: string | null;
  ip: string | null;
  isRunning: boolean;
  runtimeConnected: boolean;
  cookieValid: boolean;
  connectedRooms: number[];
  connectionInfo: ConnectionInfoSnapshot[];
  holdingRooms: number[];
  messageCount: number;
  lastRoomAssigned: number | null;
  lastError: string | null;
  lastHeartbeat: number | null;
};

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

const parseServerTimeMs = (value: unknown, fieldName: string): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  let ms: number;
  if (typeof value === 'number') {
    ms = value;
  } else {
    const raw = String(value).trim();
    if (raw && /^[0-9]+$/.test(raw)) {
      ms = Number(raw);
    } else {
      ms = Date.parse(raw);
    }
  }

  if (ms > 100000000 && ms < 10000000000) {
    ms *= 1000;
  }
  if (!Number.isFinite(ms)) {
    throw new Error(`账号中心返回的 ${fieldName} 无效`);
  }
  return ms;
};

const normalizeConnectionInfo = (info: {
  roomId: number;
  priority: unknown;
  connectedAt: string | number;
}): ConnectionInfoSnapshot => {
  const connectedAt = parseServerTimeMs(info.connectedAt, 'connectedAt');
  if (connectedAt === null) {
    throw new Error('账号中心返回的 connectedAt 无效');
  }
  return {
    roomId: info.roomId,
    priority: String(info.priority),
    connectedAt,
  };
};

const sortRecordings = (items: RecordingInfoDto[]): RecordingInfoDto[] => {
  return [...items].sort((a, b) => {
    const liveA = a.channel?.isLiving ? 1 : 0;
    const liveB = b.channel?.isLiving ? 1 : 0;
    if (liveA !== liveB) {
      return liveB - liveA;
    }
    const uidA = Number(a.channel?.uId ?? 0);
    const uidB = Number(b.channel?.uId ?? 0);
    return uidA - uidB;
  });
};

const toRecordingInfoDto = (items: CoreClientControlStateSnapshot['recordings']): RecordingInfoDto[] =>
  items.map(item => ({
    channel: { ...item.channel },
    setting: { ...item.setting },
    todayDanmakusCount: Number(item.todayDanmakusCount ?? 0),
    providedDanmakuDataCount: Number(item.providedDanmakuDataCount ?? 0),
    providedMessageCount: Number(item.providedMessageCount ?? 0),
  }));

const toRemoteClientSnapshot = (remote: CoreClientRuntimeStateDto): RemoteClientSnapshot => ({
  clientId: String(remote.clientId ?? '').trim(),
  clientVersion: remote.clientVersion == null ? null : String(remote.clientVersion),
  ip: remote.ip == null ? null : String(remote.ip),
  isRunning: Boolean(remote.isRunning),
  runtimeConnected: Boolean(remote.runtimeConnected),
  cookieValid: Boolean(remote.cookieValid),
  connectedRooms: remote.connectedRooms.map(roomId => Number(roomId)).filter(roomId => Number.isFinite(roomId) && roomId > 0).map(roomId => Math.floor(roomId)),
  connectionInfo: remote.connectionInfo.map(normalizeConnectionInfo),
  holdingRooms: remote.holdingRooms.map(roomId => Number(roomId)).filter(roomId => Number.isFinite(roomId) && roomId > 0).map(roomId => Math.floor(roomId)),
  messageCount: Number.isFinite(Number(remote.messageCount)) ? Number(remote.messageCount) : 0,
  lastRoomAssigned: Number.isFinite(Number(remote.lastRoomAssigned)) ? Number(remote.lastRoomAssigned) : null,
  lastError: typeof remote.lastError === 'string' ? remote.lastError : (remote.lastError == null ? null : String(remote.lastError)),
  lastHeartbeat: parseServerTimeMs(remote.lastHeartbeat, 'lastHeartbeat'),
});

class DanmakuService {
  private static instance: DanmakuService;
  private client: DanmakuClient | null = null;
  private localClientId: string;
  private lastNavCookieCheckAt = 0;
  private lastInitializationSignature: string | null = null;
  private readonly navCookieCheckIntervalMs = 5 * 60_000;

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
    lastError: null as string | null,
    lastRoomAssigned: null as number | null,
    cookieValid: false,
    lockedByOther: false,
    ownerClientId: null as string | null,
    lastHeartbeat: null as number | null,
    remoteClients: [] as RemoteClientSnapshot[],
    recordings: [] as RecordingInfoDto[],
    coreConfig: {
      maxConnections: 5,
      runtimeUrl: RUNTIME_URL,
      autoReconnect: true,
      reconnectInterval: 5000,
      statusCheckInterval: 30,
      streamers: [],
      requestServerRooms: true,
      allowedAreas: [],
      allowedParentAreas: [],
    } as CoreControlConfigDto,
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
      liveWsConfigProvider: getLiveWsRoomConfigAsync,
      cookieCloudKey: localConfig?.cookieCloudKey?.trim() || undefined,
      cookieCloudPassword: localConfig?.cookieCloudPassword?.trim() || undefined,
      cookieCloudHost: localConfig?.cookieCloudHost?.trim() || undefined,
      cookieRefreshInterval: localConfig?.cookieRefreshInterval,
      capacityOverride: localConfig?.capacityOverride ?? undefined,
      runtimeHeaders: this.buildRuntimeHeaders(),
      accountToken: token,
      clientVersion: 'desktop',
      accountApiBase: ACCOUNT_API_BASE,
      runtimeUrl: RUNTIME_URL,
    });
    this.lastInitializationSignature = signature;

    this.setupListeners();
    this.applyStatusSnapshot();
    this.applyControlStateSnapshot(this.client.getControlState());
    this.client.startControlSync();
  }

  public async refreshControlState(): Promise<void> {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }

    const snapshot = await this.client.refreshControlState();
    this.applyControlStateSnapshot(snapshot);
  }

  public async refreshRemoteState(): Promise<typeof this.state.syncTags> {
    await this.refreshRuntimeState();
    return { ...this.state.syncTags };
  }

  public async refreshRuntimeState(): Promise<void> {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }

    this.applyStatusSnapshot();
    const snapshot = await this.client.refreshRuntimeControlState();
    this.applyControlStateSnapshot(snapshot);
  }

  public async refreshRecordingState(): Promise<void> {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }

    const snapshot = await this.client.refreshRecordingControlState();
    this.applyControlStateSnapshot(snapshot);
  }

  public async saveCoreConfig(config: CoreControlConfigDto): Promise<void> {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }

    const snapshot = await this.client.saveCoreConfig(config);
    this.applyControlStateSnapshot(snapshot);
  }

  public async addRecording(uid: number): Promise<RecordingInfoDto> {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }

    const added = await this.client.addRecording(uid);
    this.applyControlStateSnapshot(this.client.getControlState());
    return {
      channel: { ...added.channel },
      setting: { ...added.setting },
      todayDanmakusCount: Number(added.todayDanmakusCount ?? 0),
      providedDanmakuDataCount: Number(added.providedDanmakuDataCount ?? 0),
      providedMessageCount: Number(added.providedMessageCount ?? 0),
    };
  }

  public async removeRecording(uid: number): Promise<void> {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }

    await this.client.removeRecording(uid);
    this.applyControlStateSnapshot(this.client.getControlState());
  }

  public async updateRecordingPublic(uid: number, isPublic: boolean): Promise<void> {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }

    await this.client.updateRecordingPublic(uid, isPublic);
    this.applyControlStateSnapshot(this.client.getControlState());
  }

  public async forceTakeoverRuntimeState(): Promise<void> {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }

    const snapshot = await this.client.forceTakeoverRuntimeState();
    this.applyControlStateSnapshot(snapshot);
  }

  public async dispose(): Promise<void> {
    await this.disposeExistingClient();
  }

  public async start(): Promise<void> {
    if (!this.client) {
      throw new Error('DanmakuClient 尚未初始化');
    }
    await this.assertBiliLoginReady();

    await this.client.start();
    this.applyStatusSnapshot();
  }

  public async stop(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.stop();
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
    this.state.lastError = null;
    this.state.lastRoomAssigned = null;
    this.state.cookieValid = false;
    this.state.lockedByOther = false;
    this.state.ownerClientId = null;
    this.state.lastHeartbeat = null;
  }

  private resetControlState(): void {
    this.state.userInfo = null;
    this.state.remoteClients = [];
    this.state.recordings = [];
    this.state.syncTags.configTag = null;
    this.state.syncTags.clientsTag = null;
    this.state.syncTags.recordingTag = null;
    this.state.coreConfig.maxConnections = 5;
    this.state.coreConfig.runtimeUrl = RUNTIME_URL;
    this.state.coreConfig.autoReconnect = true;
    this.state.coreConfig.reconnectInterval = 5000;
    this.state.coreConfig.statusCheckInterval = 30;
    this.state.coreConfig.requestServerRooms = true;
    this.state.coreConfig.allowedAreas = [];
    this.state.coreConfig.allowedParentAreas = [];
    this.state.coreConfig.streamers.splice(0);
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

    this.client.on('disconnected', () => {
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
    });
  }

  private applyControlStateSnapshot(snapshot: CoreClientControlStateSnapshot): void {
    this.state.userInfo = snapshot.userInfo ? { ...snapshot.userInfo } : null;
    this.state.coreConfig.maxConnections = snapshot.config.maxConnections;
    this.state.coreConfig.runtimeUrl = snapshot.config.runtimeUrl || RUNTIME_URL;
    this.state.coreConfig.autoReconnect = snapshot.config.autoReconnect;
    this.state.coreConfig.reconnectInterval = snapshot.config.reconnectInterval;
    this.state.coreConfig.statusCheckInterval = snapshot.config.statusCheckInterval;
    this.state.coreConfig.requestServerRooms = snapshot.config.requestServerRooms;
    this.state.coreConfig.allowedAreas = [...snapshot.config.allowedAreas];
    this.state.coreConfig.allowedParentAreas = [...snapshot.config.allowedParentAreas];
    this.state.coreConfig.streamers.splice(0, this.state.coreConfig.streamers.length, ...snapshot.config.streamers.map(item => ({ ...item })));

    this.state.recordings = sortRecordings(toRecordingInfoDto(snapshot.recordings));
    this.state.remoteClients = snapshot.remoteClients.map(toRemoteClientSnapshot);
    this.state.syncTags.configTag = snapshot.tags.configTag;
    this.state.syncTags.clientsTag = snapshot.tags.clientsTag;
    this.state.syncTags.recordingTag = snapshot.tags.recordingTag;
    this.refreshRemoteOwnership();
  }

  private refreshRemoteOwnership(): void {
    const normalizedClients = this.state.remoteClients;
    const self = normalizedClients.find(client => client.clientId === this.localClientId) ?? null;
    const activeOwner = normalizedClients
      .filter(client => client.clientId !== this.localClientId && (client.isRunning || client.runtimeConnected))
      .sort((a, b) => (b.lastHeartbeat ?? 0) - (a.lastHeartbeat ?? 0))[0]
      ?? normalizedClients.find(client => client.clientId !== this.localClientId)
      ?? null;

    const owner = self ?? activeOwner;
    this.state.ownerClientId = owner?.clientId ?? null;
    this.state.lastHeartbeat = owner?.lastHeartbeat ?? null;
    this.state.lockedByOther = self === null && activeOwner !== null;

    if (!this.client?.getStatus().isRunning && normalizedClients.length === 0) {
      this.state.isRunning = false;
      this.state.runtimeConnected = false;
      this.state.connectedRooms = [];
      this.state.connectionInfo = [];
      this.state.holdingRooms = [];
      this.state.messageCount = 0;
      this.state.pendingMessageCount = 0;
      this.state.messageCmdCountMap = {};
      this.state.lastRoomAssigned = null;
      this.state.lastError = null;
      void this.refreshCookieValidityFromNav(false);
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
    this.state.holdingRooms = [...status.holdingRooms];
    this.state.messageCount = status.messageCount;
    this.state.pendingMessageCount = status.pendingMessageCount;
    this.state.lastRoomAssigned = status.lastRoomAssigned ?? null;
    this.state.lastError = status.lastError ?? null;
    this.state.lastHeartbeat = status.lastHeartbeat ?? null;
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

  private async assertBiliLoginReady(): Promise<void> {
    const cookie = biliCookie.getBiliCookie().trim();
    if (!cookie) {
      this.state.cookieValid = false;
      throw new Error('未提供 Bilibili Cookie，无法连接弹幕客户端，请先完成 Bilibili 登录');
    }

    const profile = await getNavProfileAsync({ force: true });
    this.state.cookieValid = profile !== null;
    if (!profile) {
      throw new Error('Bilibili Cookie 无效或已过期，无法获取直播鉴权 Token，请重新登录');
    }
  }

  private async refreshCookieValidityFromNav(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastNavCookieCheckAt < this.navCookieCheckIntervalMs) {
      return;
    }

    this.lastNavCookieCheckAt = now;
    try {
      const profile = await getNavProfileAsync({ force });
      this.state.cookieValid = profile !== null;
    } catch (error) {
      console.error(error);
      this.state.cookieValid = false;
    }
  }
}

export const danmakuService = DanmakuService.getInstance();
