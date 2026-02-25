export type StreamerPriority = 'high' | 'normal' | 'low';

export interface CoreStreamerConfigDto {
  roomId: number;
  priority: StreamerPriority;
  name?: string;
}

export interface CoreControlConfigDto {
  maxConnections: number;
  signalrUrl: string;
  autoReconnect: boolean;
  reconnectInterval: number;
  statusCheckInterval: number;
  cookieCloudKey?: string | null;
  cookieCloudPassword?: string | null;
  cookieCloudHost?: string | null;
  cookieRefreshInterval: number;
  streamers: CoreStreamerConfigDto[];
  requestServerRooms: boolean;
}

export interface UserInfo {
  id: number;
  name: string;
  bindedOAuth: string[];
  recievedDanmakusCount: number;
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
  signalrConnected: boolean;
  cookieValid: boolean;
  connectedRooms: number[];
  connectionInfo: CoreConnectionInfoDto[];
  serverAssignedRooms: number[];
  messageCount: number;
  lastRoomAssigned?: number | null;
  lastError?: string | null;
  lastHeartbeat: string | number | null;
}
