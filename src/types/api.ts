export type {
  StreamerPriority,
  StreamerStatus,
  CoreStreamerConfigDto,
  CoreControlConfigDto,
  UserInfo,
  RecordingChannelDto,
  RecordingLiveInfoDto,
  RecordingSettingDto,
  RecordingInfoDto,
  CoreConnectionPriority,
  CoreConnectionInfoDto,
  CoreRuntimeStateDto
} from 'danmakus-core';

export type ThemeMode = 'system' | 'light' | 'dark';

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
}
