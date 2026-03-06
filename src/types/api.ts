export type StreamerPriority = 'high' | 'normal' | 'low';

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

export interface LocalAppConfigDto {
  autoStart: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  cookieCloudKey: string;
  cookieCloudPassword: string;
  cookieCloudHost: string;
  cookieRefreshInterval: number;
  capacityOverride: number | null;
}

export interface UserInfo {
  id: number;
  name: string;
  bindedOAuth: string[];
  recievedDanmakusCount: number;
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
  lastRoomAssigned?: number | null;
  lastError?: string | null;
  lastHeartbeat: string | number | null;
}
