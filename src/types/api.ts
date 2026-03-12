export type {
  StreamerPriority,
  CoreStreamerConfigDto,
  CoreControlConfigDto,
  UserInfo,
  RecordingChannelDto,
  RecordingSettingDto,
  RecordingInfoDto,
  CoreConnectionPriority,
  CoreConnectionInfoDto,
  CoreRuntimeStateDto
} from 'danmakus-core';

export interface LocalAppConfigDto {
  autoStart: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  autoStartRecording: boolean;
  cookieCloudKey: string;
  cookieCloudPassword: string;
  cookieCloudHost: string;
  cookieRefreshInterval: number;
  capacityOverride: number | null;
}
