export type {
  StreamerStatus,
  CoreControlConfigDto,
  UserInfo,
  RecordingChannelDto,
  RecordingLiveInfoDto,
  RecordingSettingDto,
  RecordingInfoDto,
  CoreRuntimeStateDto
} from 'danmakus-core';

export type ThemeMode = 'system' | 'light' | 'dark';

export type ManualProxyProtocol = 'http' | 'socks5';

export interface ManualProxyConfigDto {
  enabled: boolean;
  protocol: ManualProxyProtocol;
  host: string;
  port: number | null;
  username: string;
  password: string;
}

export interface LocalAppConfigDto {
  themeMode: ThemeMode;
  autoStart: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  hideDockIconWhenWindowHidden: boolean;
  autoStartRecording: boolean;
  recordingLiveNotificationUids: number[];
  cookieCloudKey: string;
  cookieCloudPassword: string;
  cookieCloudHost: string;
  cookieRefreshInterval: number;
  capacityOverride: number | null;
  proxy: ManualProxyConfigDto;
}
