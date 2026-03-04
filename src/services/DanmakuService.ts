import { DanmakuClient } from 'danmakus-core';
import type { DanmakuMessage, StreamerStatus } from 'danmakus-core';
import { reactive } from 'vue';
import { getCoreClients } from './account';
import { biliCookie, getLiveWsRoomConfigAsync, getNavProfileAsync } from './bilibili';
import { ACCOUNT_API_BASE, SIGNALR_URL } from './env';
import { fetchImpl } from './fetchImpl';
import { getAuthToken } from './http';

type ConnectionInfoSnapshot = { roomId: number; priority: string; connectedAt: number };
type RemoteClientSnapshot = {
  clientId: string;
  clientVersion: string | null;
  ip: string | null;
  isRunning: boolean;
  signalrConnected: boolean;
  cookieValid: boolean;
  connectedRooms: number[];
  connectionInfo: ConnectionInfoSnapshot[];
  serverAssignedRooms: number[];
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

  // 兼容服务端返回 unix 秒
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
    connectedAt
  };
};

const ensureNumberArray = (value: unknown, fieldName: string): number[] => {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`账号中心返回的 ${fieldName} 无效`);
  }
  return value.map((item) => {
    const num = typeof item === 'number' ? item : Number(item);
    if (!Number.isFinite(num)) {
      throw new Error(`账号中心返回的 ${fieldName} 无效`);
    }
    return num;
  });
};

const ensureObjectArray = <T = unknown>(value: unknown, fieldName: string): T[] => {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`账号中心返回的 ${fieldName} 无效`);
  }
  return value as T[];
};

const getRemoteField = (raw: Record<string, unknown>, camel: string, pascal: string) =>
  (raw[camel] ?? raw[pascal]) as unknown;

const getRemoteString = (raw: Record<string, unknown>, camel: string, pascal: string): string => {
  const value = getRemoteField(raw, camel, pascal);
  return typeof value === 'string' ? value : String(value ?? '');
};

const getRemoteBoolean = (raw: Record<string, unknown>, camel: string, pascal: string): boolean => {
  const value = getRemoteField(raw, camel, pascal);
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return false;
  if (value === 0 || value === '0' || value === 'false') return false;
  if (value === 1 || value === '1' || value === 'true') return true;
  throw new Error(`账号中心返回的 ${camel} 无效`);
};

class DanmakuService {
  private static instance: DanmakuService;
  private client: DanmakuClient | null = null;
  private localClientId: string;
  private readonly debugMessageConsoleEnabled: boolean;
  private debugMessageCounter = 0;
  private lastNavCookieCheckAt = 0;
  private readonly navCookieCheckIntervalMs = 30_000;

  public state = reactive({
    isRunning: false,
    signalrConnected: false,
    connectedRooms: [] as number[],
    connectionInfo: [] as ConnectionInfoSnapshot[],
    messageCount: 0,
    messageCmdCountMap: {} as Record<string, number>,
    roomMessageCountMap: {} as Record<string, number>,
    streamerStatuses: [] as StreamerStatus[],
    serverAssignedRooms: [] as number[],
    lastError: null as string | null,
    lastRoomAssigned: null as number | null,
    cookieValid: false,
    lockedByOther: false,
    ownerClientId: null as string | null,
    lastHeartbeat: null as number | null,
    remoteClients: [] as RemoteClientSnapshot[]
  });

  private constructor() {
    this.localClientId = getOrCreateClientId();
    const debugFlag = typeof localStorage !== 'undefined' && localStorage.getItem('danmakus_debug_msg') === '1';
    this.debugMessageConsoleEnabled = Boolean(import.meta.env.DEV || debugFlag);
  }

  public static getInstance(): DanmakuService {
    if (!DanmakuService.instance) {
      DanmakuService.instance = new DanmakuService();
    }
    return DanmakuService.instance;
  }

  public async initialize(): Promise<void> {
    await this.disposeExistingClient();

    const token = getAuthToken();
    if (!token) {
      throw new Error('请先登录并提供 Token');
    }
    await this.assertBiliLoginReady();

    this.client = new DanmakuClient({
      clientId: this.localClientId,
      fetchImpl,
      cookieProvider: () => biliCookie.getBiliCookie(),
      liveWsConfigProvider: getLiveWsRoomConfigAsync,
      signalrHeaders: this.buildSignalRHeaders(),
      accountToken: token,
      clientVersion: 'desktop',
      accountApiBase: ACCOUNT_API_BASE,
      signalrUrl: SIGNALR_URL
    });

    this.setupListeners();
    this.applyStatusSnapshot();
  }

  public async refreshRemoteState(): Promise<void> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('请先登录并提供 Token');
    }

    const remotes = await getCoreClients();
    const normalizedClients = remotes.map((remote) => {
      const raw = remote as unknown as Record<string, unknown>;
      const clientId = getRemoteString(raw, 'clientId', 'ClientId').trim();
      if (!clientId) {
        throw new Error('账号中心返回的 clientId 无效');
      }

      const clientVersion = getRemoteField(raw, 'clientVersion', 'ClientVersion');
      const ip = getRemoteField(raw, 'ip', 'Ip');

      const connectedRooms = ensureNumberArray(getRemoteField(raw, 'connectedRooms', 'ConnectedRooms'), 'connectedRooms');
      const connectionInfo = ensureObjectArray<{
        roomId: number;
        priority: unknown;
        connectedAt: string | number;
      }>(getRemoteField(raw, 'connectionInfo', 'ConnectionInfo'), 'connectionInfo').map(normalizeConnectionInfo);

      const serverAssignedRooms = ensureNumberArray(
        getRemoteField(raw, 'serverAssignedRooms', 'ServerAssignedRooms'),
        'serverAssignedRooms'
      );

      const messageCountRaw = getRemoteField(raw, 'messageCount', 'MessageCount');
      const messageCount = typeof messageCountRaw === 'number' ? messageCountRaw : Number(messageCountRaw);

      const lastRoomAssignedRaw = getRemoteField(raw, 'lastRoomAssigned', 'LastRoomAssigned');
      const lastRoomAssigned = typeof lastRoomAssignedRaw === 'number' ? lastRoomAssignedRaw : Number(lastRoomAssignedRaw);

      const lastError = getRemoteField(raw, 'lastError', 'LastError');
      const lastHeartbeat = parseServerTimeMs(getRemoteField(raw, 'lastHeartbeat', 'LastHeartbeat'), 'lastHeartbeat');

      return {
        clientId,
        clientVersion: clientVersion == null ? null : String(clientVersion),
        ip: ip == null ? null : String(ip),
        isRunning: getRemoteBoolean(raw, 'isRunning', 'IsRunning'),
        signalrConnected: getRemoteBoolean(raw, 'signalrConnected', 'SignalrConnected'),
        cookieValid: getRemoteBoolean(raw, 'cookieValid', 'CookieValid'),
        connectedRooms,
        connectionInfo,
        serverAssignedRooms,
        messageCount: Number.isFinite(messageCount) ? messageCount : 0,
        lastRoomAssigned: Number.isFinite(lastRoomAssigned) ? lastRoomAssigned : null,
        lastError: typeof lastError === 'string' ? lastError : (lastError == null ? null : String(lastError)),
        lastHeartbeat
      } satisfies RemoteClientSnapshot;
    });

    this.state.remoteClients = normalizedClients;

    const self = normalizedClients.find((c) => c.clientId === this.localClientId) ?? null;
    const activeOwner = normalizedClients
      .filter((c) => c.clientId !== this.localClientId && (c.isRunning || c.signalrConnected))
      .sort((a, b) => (b.lastHeartbeat ?? 0) - (a.lastHeartbeat ?? 0))[0]
      ?? normalizedClients.find((c) => c.clientId !== this.localClientId)
      ?? null;

    const owner = self ?? activeOwner;
    this.state.ownerClientId = owner?.clientId ?? null;
    this.state.lastHeartbeat = owner?.lastHeartbeat ?? null;
    this.state.lockedByOther = self === null && activeOwner !== null;

    if (!this.client?.getStatus().isRunning && normalizedClients.length === 0) {
      this.state.isRunning = false;
      this.state.signalrConnected = false;
      this.state.connectedRooms = [];
      this.state.connectionInfo = [];
      this.state.serverAssignedRooms = [];
      this.state.messageCount = 0;
      this.state.messageCmdCountMap = {};
      this.state.lastRoomAssigned = null;
      this.state.lastError = null;
      await this.refreshCookieValidityFromNav(false);
    }
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
      try {
        await this.client.stop();
      } catch (error) {
        stopError = error;
      }
      this.client.removeAllListeners();
      this.client = null;
    }

    this.resetRuntimeState();
    if (stopError) {
      throw stopError;
    }
  }

  private resetRuntimeState(): void {
    this.state.isRunning = false;
    this.state.signalrConnected = false;
    this.state.connectedRooms = [];
    this.state.connectionInfo = [];
    this.state.messageCount = 0;
    this.state.messageCmdCountMap = {};
    this.state.roomMessageCountMap = {};
    this.state.streamerStatuses = [];
    this.state.serverAssignedRooms = [];
    this.state.lastError = null;
    this.state.lastRoomAssigned = null;
    this.state.cookieValid = false;
    this.state.lockedByOther = false;
    this.state.ownerClientId = null;
    this.state.lastHeartbeat = null;
  }

  private setupListeners(): void {
    if (!this.client) return;

    this.client.on('connected', () => {
      this.state.isRunning = true;
      this.applyStatusSnapshot();
    });

    this.client.on('disconnected', () => {
      this.applyStatusSnapshot();
    });

    this.client.on('streamerStatusUpdated', (statuses: StreamerStatus[]) => {
      this.state.streamerStatuses = statuses.map(status => ({ ...status }));
    });

    this.client.on('roomAssigned', (roomId: number) => {
      if (!this.state.serverAssignedRooms.includes(roomId)) {
        this.state.serverAssignedRooms = [...this.state.serverAssignedRooms, roomId];
      }
      this.state.lastRoomAssigned = roomId;
      this.applyStatusSnapshot();
    });

    this.client.on('roomReplaced', ({ oldRoomId, newRoomId }) => {
      const nextRooms = this.state.serverAssignedRooms.filter(roomId => roomId !== oldRoomId);
      if (!nextRooms.includes(newRoomId)) {
        nextRooms.push(newRoomId);
      }
      this.state.serverAssignedRooms = nextRooms;
      this.state.lastRoomAssigned = newRoomId;
      this.applyStatusSnapshot();
    });

    this.client.on('msg', (message: DanmakuMessage) => {
      this.state.messageCount += 1;
      const cmd = message.cmd;
      this.state.messageCmdCountMap[cmd] = (this.state.messageCmdCountMap[cmd] || 0) + 1;
      const roomKey = String(message.roomId);
      this.state.roomMessageCountMap[roomKey] = (this.state.roomMessageCountMap[roomKey] || 0) + 1;
      if (this.debugMessageConsoleEnabled) {
        this.debugMessageCounter += 1;
        console.debug(
          `[DanmakuService][msg#${this.debugMessageCounter}] room=${message.roomId} cmd=${cmd}`,
          message
        );
      }
    });

    this.client.on('error', (error: Error) => {
      this.state.lastError = error.message;
    });
  }

  private applyStatusSnapshot(): void {
    if (!this.client) {
      return;
    }

    const status = this.client.getStatus();
    this.state.isRunning = status.isRunning;
    this.state.signalrConnected = status.signalrConnected;
    this.state.connectedRooms = [...status.connectedRooms];
    this.state.connectionInfo = status.connectionInfo.map(normalizeConnectionInfo);
    this.state.cookieValid = status.cookieValid;
    
    // Update extended state
    this.state.serverAssignedRooms = [...status.serverAssignedRooms];
    this.state.messageCount = status.messageCount;
    this.state.lastRoomAssigned = status.lastRoomAssigned ?? null;
    this.state.lastError = status.lastError ?? null;
    this.state.lastHeartbeat = status.lastHeartbeat ?? null;
  }

  private buildSignalRHeaders(): Record<string, string> | undefined {
    const token = getAuthToken()?.trim();
    if (!token) {
      return undefined;
    }
    return {
      Token: token,
      ClientId: this.localClientId
    };
  }

  private async assertBiliLoginReady(): Promise<void> {
    const profile = await getNavProfileAsync();
    this.state.cookieValid = profile !== null;
    if (!profile) {
      throw new Error('未登录 Bilibili，无法获取直播鉴权 Token，请先完成 Bilibili 登录');
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
