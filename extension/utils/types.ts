import type { StreamerStatus } from 'danmakus-core';

export const MAX_EXTENSION_ROOMS = 5;
export const DEFAULT_EXTENSION_ROOMS = 3;
export const DANMAKUS_SITE_ORIGIN = 'https://danmakus.com';
export const DANMAKUS_API_ORIGIN = 'https://ukamnads.icu';

export interface ExtensionRecorderConfig {
  /** 用户是否手动开启了后台兼职录制 */
  enabled: boolean;
  /** 最大同时录制房间数 (1 ~ 5) */
  maxRooms: number;
  /** 自动从 danmakus.com 同步或手动填入的 Account Token */
  accountToken: string;
  /** 客户端唯一标识 */
  clientId: string;
}

export interface RecorderRoomItem {
  roomId: number;
  uId?: number;
  uname?: string;
  title?: string;
  face?: string;
  areaName?: string;
  isLive: boolean;
  connected: boolean;
  messageCount: number;
  priority: string;
}

export interface ExtensionRecorderState {
  isRunning: boolean;
  runtimeConnected: boolean;
  cookieValid: boolean;
  biliUid: number | null;
  biliUname: string | null;
  accountId: number | null;
  accountName: string | null;
  accountAvatar: string | null;
  todayProvidedCount: number;
  totalProvidedCount: number;
  connectedRooms: number[];
  holdingRooms: number[];
  rooms: RecorderRoomItem[];
  messageCount: number;
  pendingMessageCount: number;
  lastError: string | null;
  updatedAt: number;
}

export enum DanmakuType {
  Text = 0,
  Gift = 1,
  Guard = 2,
  SuperChat = 3,
  Enter = 4,
  Warning = 5,
  TitleChange = 6,
  AreaChange = 7,
}

export enum DanmakuPayloadKindV3 {
  None = 0,
  TextMessage = 1,
  RoomEmojiMessage = 2,
  Gift = 3,
  Guard = 4,
  SuperChat = 5,
  TitleChange = 6,
  AreaChange = 7,
  Warning = 8,
  RecordStart = 9,
  RecordInterrupt = 10,
  Enter = 11,
}

export interface ActorV3 {
  uid: number;
  name: string;
}

export interface RoomEmojiV3 {
  name: string;
  resource: string;
}

export interface DanmakuPayloadV3 {
  rawText?: string;
  roomEmojiId?: number;
  name?: string;
  count?: number;
  price?: number;
  mysteryBoxName?: string;
  mysteryBoxPrice?: number;
  previousTitle?: string;
  currentTitle?: string;
  previousParentArea?: string;
  previousArea?: string;
  currentParentArea?: string;
  currentArea?: string;
  text?: string;
}

export interface DanmakuRecordV3 {
  ts: number;
  type: DanmakuType;
  actorId?: number;
  uploadAccountId?: number;
  payloadKind: DanmakuPayloadKindV3;
  payload?: DanmakuPayloadV3 | null;
}

export interface DanmakuFrameV3 {
  actors: ActorV3[];
  roomEmojis: RoomEmojiV3[];
  records: DanmakuRecordV3[];
}

export interface LiveDanmakusPageV3 {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  frame: DanmakuFrameV3;
}

export interface ChannelLike {
  uId?: number;
  uName?: string | null;
  roomId?: number;
  faceUrl?: string | null;
  isLiving?: boolean;
  totalLiveCount?: number;
  totalDanmakuCount?: number;
  totalIncome?: number;
  lastLiveDate?: number;
  livingInfo?: LiveLike | null;
  agencyName?: string | null;
}

export interface LiveLike {
  liveId: string;
  title: string;
  coverUrl?: string | null;
  startDate: number;
  stopDate?: number | null;
  isFinish: boolean;
  danmakusCount: number;
  totalIncome: number;
  watchCount: number;
  payCount?: number;
  interactionCount: number;
  area?: string | null;
  parentArea?: string | null;
}

export interface UserHistoryItemV3 {
  channel: ChannelLike;
  live: LiveLike;
  danmakus: DanmakuFrameV3;
}

export interface UserHistoryResponseV3 {
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  items: UserHistoryItemV3[];
}

export interface WatchedChannelSummaryV3 {
  uName: string;
  uId: number;
  faceUrl: string;
  count: number;
}

export interface UserBlockHistoryItemV3 {
  uName: string;
  uId: number;
  faceUrl: string;
  date: number;
  liveId: string;
}

export interface UserBootstrapResponseV3 {
  history: UserHistoryResponseV3;
  watchedChannels: WatchedChannelSummaryV3[];
  blocks: UserBlockHistoryItemV3[];
  historyUserNames: string[];
  todayQueryCount: number;
}

export interface DecodedDanmakuItem {
  id: string;
  uId: number;
  uName: string;
  type: DanmakuType;
  sendDate: number;
  message: string;
  price?: number;
  count?: number;
  mysteryBoxName?: string;
  roomEmojiUrl?: string;
}

export interface DecodedUserLiveGroup {
  channel: ChannelLike;
  live: LiveLike;
  danmakus: DecodedDanmakuItem[];
}

export interface ChannelDetailResponse {
  channel: ChannelLike;
  lives: LiveLike[];
  totalLives: number;
  hasMoreLives: boolean;
}

export type ExtensionMessage =
  | { type: 'GET_RECORDER_STATE' }
  | { type: 'UPDATE_RECORDER_CONFIG'; patch: Partial<ExtensionRecorderConfig> }
  /** token 为空且带 previousToken 表示站点已退出登录，仅当扩展当前 token 与之相同时清除 */
  | { type: 'SYNC_DANMAKUS_TOKEN'; token: string; previousToken?: string }
  | { type: 'API_REQUEST'; path: string; method?: string; body?: unknown; useToken?: boolean }
  | { type: 'ADD_RECORDING_CHANNEL'; uid: number }
  | { type: 'OFFSCREEN_START_OR_UPDATE'; config: ExtensionRecorderConfig; biliCookie: string }
  | { type: 'OFFSCREEN_STOP' }
  | { type: 'OFFSCREEN_GET_SNAPSHOT' }
  | { type: 'OFFSCREEN_STATE_PUSH'; state: ExtensionRecorderState }
  | { type: 'OFFSCREEN_REQUEST_COOKIE' };
