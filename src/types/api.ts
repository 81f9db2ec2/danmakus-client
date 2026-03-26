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

export interface LocalAppConfigDto {
  autoStart: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  autoStartRecording: boolean;
  recordingLiveNotificationUids: number[];
  cookieCloudKey: string;
  cookieCloudPassword: string;
  cookieCloudHost: string;
  cookieRefreshInterval: number;
  capacityOverride: number | null;
}
