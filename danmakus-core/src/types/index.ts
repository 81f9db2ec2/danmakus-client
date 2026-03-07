// 统一的弹幕消息类型
export type RecorderEventType = 'record_start' | 'record_interrupt' | 'record_end';

export interface DanmakuMessage {
  roomId: number;
  cmd: string;
  data: any;
  raw: string;
  timestamp: number;
  recorderEventType?: RecorderEventType;
  recorderEventMessage?: string;
}

// 发送给后端的消息格式
export interface ClientDanmakuMessage {
  roomId: number;
  raw?: string;
  timestamp: number;
  eventType?: RecorderEventType;
  eventMessage?: string;
}

// 主播优先级类型
export type StreamerPriority = 'high' | 'normal' | 'low';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type ErrorCategory = 'network' | 'runtime' | 'runtime-sync' | 'livews' | 'config' | 'queue' | 'lock' | 'unknown';

export interface ClientErrorRecord {
  timestamp: number;
  category: ErrorCategory;
  code: string;
  message: string;
  recoverable: boolean;
  roomId?: number;
}

// 主播配置类型
export interface StreamerConfig {
  roomId: number;
  priority: StreamerPriority;
  name?: string;
}

// 主播状态类型
export interface StreamerStatus {
  roomId: number;
  uid?: number;
  isLive: boolean;
  title?: string;
  username?: string;
  faceUrl?: string;
  viewerCount?: number;
  liveStartTime?: number;
}

export interface LiveWsRoomConfig {
  roomId?: number;
  address: string;
  key: string;
  uid?: number;
  buvid?: string;
  protover?: 1 | 2 | 3;
}

export interface LiveWsConnection {
  addEventListener(type: string, listener: (event: any) => void): void;
  close(): void;
}

// 配置类型
export interface DanmakuConfig {
  maxConnections: number;
  capacityOverride?: number;
  streamers: StreamerConfig[]; // 替换原来的 roomIds
  cookieCloudKey?: string;
  cookieCloudPassword?: string;
  cookieCloudHost?: string;
  cookieProvider?: () => string | null | undefined;
  runtimeUrl: string;
  runtimeHeaders?: Record<string, string>;
  cookieRefreshInterval: number; // 秒
  autoReconnect: boolean;
  reconnectInterval: number; // 毫秒
  statusCheckInterval: number; // 状态检查间隔（秒）
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  liveWsConfigProvider?: (roomId: number) => Promise<LiveWsRoomConfig | null | undefined>;
  liveWsConnectionFactory?: (
    roomId: number,
    options: LiveWsRoomConfig
  ) => Promise<LiveWsConnection>;
  requestServerRooms?: boolean;
  allowedAreas?: string[];
  allowedParentAreas?: string[];
  accountToken?: string;
  accountApiBase?: string;
  clientId?: string;
  clientVersion?: string;
  logLevel?: LogLevel;
  messageQueueMaxSize?: number;
  messageRetryBaseDelay?: number;
  messageRetryMaxDelay?: number;
  messageRetryMaxAttempts?: number;
  batchUploadSize?: number;
  heartbeatInterval?: number;
  lockAcquireRetryCount?: number;
  lockAcquireRetryDelay?: number;
  lockAcquireForceTakeover?: boolean;
  errorHistoryLimit?: number;
}

// CookieCloud响应类型
export interface CookieCloudResponse {
  cookie_data: {
    [domain: string]: {
      [name: string]: {
        name: string;
        value: string;
        domain: string;
        path: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
      };
    };
  };
}

// 直播间信息类型
export interface RoomInfo {
  roomId: number;
  uid: number;
  username: string;
  title: string;
  isLive: boolean;
  viewerCount?: number;
}

// 事件类型
export interface DanmakuClientEvents {
  'msg': (message: DanmakuMessage) => void; // 订阅所有消息
  'connected': (roomId: number) => void;
  'disconnected': (roomId: number) => void;
  'controlStateChanged': (state: CoreControlStateSnapshot) => void;
  'error': (error: Error, roomId?: number) => void;
  'cookieUpdated': () => void;
  'queueChanged': (pendingMessageCount: number) => void;
  'streamerStatusUpdated': (statuses: StreamerStatus[]) => void;
}

// 通用响应包装
export interface ResponseValue<T> {
  code: number;
  message?: string;
  data: T;
}

// 账号 API - 配置 DTO
export interface CoreStreamerConfigDto {
  roomId: number;
  priority: StreamerPriority;
  name?: string;
}

export interface CoreControlConfigDto {
  maxConnections: number;
  runtimeUrl: string;
  autoReconnect: boolean;
  reconnectInterval: number;
  statusCheckInterval: number;
  streamers: CoreStreamerConfigDto[];
  requestServerRooms: boolean;
  allowedAreas: string[];
  allowedParentAreas: string[];
}

export interface RecordingChannelDto {
  uId: number;
  uName: string;
  roomId: number;
  faceUrl: string;
  isLiving: boolean;
}

export interface RecordingSettingDto {
  isPublic: boolean;
}

export interface RecordingInfoDto {
  channel: RecordingChannelDto;
  setting: RecordingSettingDto;
  todayDanmakusCount: number;
  providedDanmakuDataCount?: number;
  providedMessageCount?: number;
}

export interface UpdateRecordingSettingPayload {
  id: number;
  setting: {
    isPublic: boolean;
  };
}

export interface UserInfo {
  id: number;
  name: string;
  bindedOAuth: string[];
  recievedDanmakusCount: number;
}

export interface CoreSyncTagSnapshot {
  configTag: string | null;
  clientsTag: string | null;
  recordingTag: string | null;
}

export interface CoreTaggedApiResult<T> {
  data: T;
  tags: CoreSyncTagSnapshot;
}

export type CoreConnectionPriority = 'high' | 'normal' | 'low' | 'server';

export interface CoreConnectionInfoDto {
  roomId: number;
  priority: CoreConnectionPriority | string;
  connectedAt: string | number;
}

export interface CoreRuntimeStateDto {
  clientId: string;
  clientVersion?: string | null;
  ip?: string | null;
  isRunning: boolean;
  runtimeConnected: boolean;
  cookieValid: boolean;
  connectedRooms: number[];
  connectionInfo: CoreConnectionInfoDto[];
  holdingRooms: number[];
  messageCount: number;
  pendingMessageCount?: number;
  lastRoomAssigned?: number | null;
  lastError?: string | null;
  lastHeartbeat: string | number | null;
}

export interface CoreControlStateSnapshot {
  userInfo: UserInfo | null;
  config: CoreControlConfigDto;
  recordings: RecordingInfoDto[];
  remoteClients: CoreRuntimeStateDto[];
  tags: CoreSyncTagSnapshot;
}

export interface RuntimeRoomPullRequestDto {
  holdingRooms: number[];
  connectedRooms: number[];
  desiredCount: number;
  capacityOverride?: number;
  reason?: string;
}

export interface RuntimeRoomPullResponseDto {
  holdingRooms: number[];
  newlyAssignedRooms: number[];
  droppedRooms: number[];
  effectiveCapacity: number;
  nextRequestAfter?: number | null;
}

// 动态事件类型，支持特定cmd的订阅
export type DanmakuEventMap = DanmakuClientEvents & {
  [cmd: string]: (message: DanmakuMessage) => void;
}

// CLI选项类型
export interface CliOptions {
  maxConnections?: number;
  capacityOverride?: number;
  cookieKey?: string;
  cookiePassword?: string;
  cookieHost?: string;
  runtimeUrl?: string;
  statusCheckInterval?: number;
  verbose?: boolean;
  token?: string;
  accountApi?: string;
  logLevel?: LogLevel;
}
