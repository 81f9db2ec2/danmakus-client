export interface DanmakuExtractionFields {
  userId?: string;
  userName?: string;
  message?: string;
  sendDate?: string;
  price?: string;
  priceDivisor?: number;
  priceTimesCount?: boolean;
  count?: string;
  ct?: string;
  isEmoji?: string;
  roomEmojiName?: string;
  roomEmojiUrl?: string;
  userCrc32?: string;
  liveId?: string;
  stopLive?: boolean;
}

export interface DanmakuExtractionRule {
  pattern: string;
  discardPatterns?: string[];
  category?: 'danmaku' | 'delta' | 'lifecycle';
  type: number;
  proto?: string;
  protoSource?: string;
  fields?: DanmakuExtractionFields;
}

export interface DanmakuProtobufSchema {
  name: string;
  proto: string;
}

export interface DanmakuExtractionRuleSet {
  version: number;
  protobufs?: DanmakuProtobufSchema[];
  rules: DanmakuExtractionRule[];
}

export interface ExtractedDanmakuInfo {
  type: number;
  sendDate: number;
  userName: string;
  userId: number;
  price?: number | null;
  message: string;
  ct?: string | null;
  isEmoji?: boolean | null;
  roomEmoji?: [string, string] | null;
  count?: number | null;
  uploadAccountId?: number | null;
  areaChange?: unknown | null;
  titleChange?: unknown | null;
  mysteryBoxName?: string | null;
  mysteryBoxPrice?: number | null;
  sourceFingerprint?: bigint | null;
  userCrc32?: number | null;
  userFaceHash?: bigint | number;
}

export interface RuntimeDeltaInfo {
  watchCount?: number | null;
  likeCount?: number | null;
}

export interface LiveLifecycleSignalInfo {
  stopLive?: boolean | null;
  liveId?: string | null;
  title?: string | null;
  areaId?: number | null;
  parentAreaId?: number | null;
}

export interface ExtractedUploadEvent {
  localId?: number;
  streamerUid: number;
  eventTsMs: number;
  danmaku?: ExtractedDanmakuInfo | null;
  runtimeDelta?: RuntimeDeltaInfo | null;
  lifecycleSignal?: LiveLifecycleSignalInfo | null;
  roomId: number;
}

export interface ExtractedUploadBatch {
  events: ExtractedUploadEvent[];
  batchId?: string;
}

export const INTERACT_WORD_V2_PROTO = `
syntax = "proto3";
package bilibili.live;
message InteractWordV2 {
  uint64 uid = 1;
  string username = 2;
  uint32 timestamp = 7;
  uint64 timestamp_ms = 8;
  UInfo uinfo = 22;
  message UInfo {
    uint64 uid = 1;
    Base base = 2;
    message Base {
      string username = 1;
      string avatar = 2;
    }
  }
}
`;

export const SEND_GIFT_V2_PROTO = `
syntax = "proto3";
package bilibili.live;
message SendGiftMsg {
  int64 uid = 1;
  string u_name = 2;
  string face = 3;
  MysteryBox mystery_box = 9;
  repeated GiftInfo gift_info = 10;
  message MysteryBox {
    string box_name = 3;
    int32 box_price = 6;
  }
  message GiftInfo {
    int32 gift_id = 1;
    string gift_name = 2;
    int32 num = 3;
    int32 demarcation = 4;
    int32 price = 5;
    int32 timestamp = 10;
  }
}
`;

export const DEFAULT_EXTRACTION_RULE_SET: DanmakuExtractionRuleSet = {
  version: 2,
  protobufs: [
    {
      name: 'bilibili.live.InteractWordV2',
      proto: INTERACT_WORD_V2_PROTO,
    },
    {
      name: 'bilibili.live.SendGiftMsg',
      proto: SEND_GIFT_V2_PROTO,
    },
  ],
  rules: [
    {
      pattern: '^DANMU_MSG(:.*)?$',
      discardPatterns: ['^DANMU_MSG_MIRROR$'],
      category: 'danmaku',
      type: 0,
      fields: {
        userId: 'info.2.0',
        userName: 'info.2.1',
        message: 'info.1',
        sendDate: 'info.0.4',
        ct: 'info.9.ct',
        isEmoji: 'info.0.12',
        roomEmojiName: 'info.0.13.emoticon_unique',
        roomEmojiUrl: 'info.0.13.url',
        userCrc32: 'info.0.7',
      },
    },
    {
      pattern: '^SEND_GIFT$',
      category: 'danmaku',
      type: 1,
      fields: {
        userId: 'data.uid',
        userName: 'data.uname',
        message: 'data.giftName',
        price: 'data.total_coin',
        priceDivisor: 1000,
        count: 'data.num',
        sendDate: 'data.timestamp',
      },
    },
    {
      pattern: '^SEND_GIFT_V2$',
      category: 'danmaku',
      type: 1,
      proto: 'bilibili.live.SendGiftMsg',
      protoSource: 'data.pb',
      fields: {
        userId: 'uid',
        userName: 'u_name',
        message: 'gift_info.0.gift_name',
        price: 'gift_info.0.price',
        priceDivisor: 1000,
        priceTimesCount: true,
        count: 'gift_info.0.num',
        sendDate: 'gift_info.0.timestamp',
      },
    },
    {
      pattern: '^(GUARD_BUY|USER_TOAST_MSG)$',
      category: 'danmaku',
      type: 2,
      fields: {
        userId: 'data.uid',
        userName: 'data.username',
        message: 'data.role_name | data.gift_name',
        price: 'data.price',
        priceDivisor: 1000,
        count: 'data.num',
        sendDate: 'data.start_time',
      },
    },
    {
      pattern: '^USER_TOAST_MSG_V2$',
      category: 'danmaku',
      type: 2,
      fields: {
        userId: 'data.sender_uinfo.uid | data.uid',
        userName: 'data.sender_uinfo.base.name | data.username | data.uname',
        message: 'data.role_name | data.gift_info.gift_name',
        price: 'data.pay_info.price | data.price',
        priceDivisor: 1000,
        count: 'data.pay_info.num | data.num',
        sendDate: 'data.guard_info.start_time | data.start_time',
      },
    },
    {
      pattern: '^(SUPER_CHAT_MESSAGE|SUPER_CHAT_MESSAGE_JPN|SUPER_CHAT_MESSAGE_JP)$',
      category: 'danmaku',
      type: 3,
      fields: {
        userId: 'data.uid',
        userName: 'data.user_info.uname',
        message: 'data.message',
        price: 'data.price',
        sendDate: 'data.start_time',
      },
    },
    {
      pattern: '^(INTERACT_WORD|ENTRY_EFFECT)$',
      category: 'danmaku',
      type: 4,
      fields: {
        userId: 'data.uid',
        userName: 'data.uname',
        sendDate: 'data.timestamp',
      },
    },
    {
      pattern: '^INTERACT_WORD_V2$',
      category: 'danmaku',
      type: 4,
      proto: 'bilibili.live.InteractWordV2',
      protoSource: 'data.pb',
      fields: {
        userId: 'uid | uinfo.uid',
        userName: 'username | uinfo.base.username',
        sendDate: 'timestamp_ms | timestamp',
      },
    },
    {
      pattern: '^ROOM_CHANGE$',
      category: 'danmaku',
      type: 5,
      fields: {
        message: 'data.title',
      },
    },
    {
      pattern: '^ROOM_BLOCK_MSG$',
      category: 'danmaku',
      type: 9,
      fields: {
        userId: 'data.uid',
        userName: 'data.uname',
      },
    },
    {
      pattern: '^WARNING$',
      category: 'danmaku',
      type: 10,
      fields: {
        message: 'data.msg',
      },
    },
    {
      pattern: '^(LIVE|PREPARING|ROUND)$',
      category: 'lifecycle',
      type: 255,
      fields: {
        liveId: 'data.live_key',
      },
    },
    {
      pattern: '^(WATCHED_CHANGE|LIKE_INFO_V3_UPDATE)$',
      category: 'delta',
      type: 254,
    },
  ],
};
