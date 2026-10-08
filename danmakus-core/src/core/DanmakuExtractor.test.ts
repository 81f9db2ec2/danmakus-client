import { describe, expect, it } from 'bun:test';
import protobuf from 'protobufjs';
import { DanmakuExtractor } from './DanmakuExtractor.js';
import {
  DEFAULT_EXTRACTION_RULE_SET,
  INTERACT_WORD_V2_PROTO,
  SEND_GIFT_V2_PROTO,
} from './DanmakuExtractionTypes.js';
import { decodeMsgPackPayload, encodeMsgPackPayload } from './CoreWebSocketCodec.js';

const interactWordV2Type = protobuf.parse(INTERACT_WORD_V2_PROTO, { keepCase: true }).root.lookupType('bilibili.live.InteractWordV2');
const sendGiftV2Type = protobuf.parse(SEND_GIFT_V2_PROTO, { keepCase: true }).root.lookupType('bilibili.live.SendGiftMsg');

function encodePb(type: protobuf.Type, obj: any): string {
  const errMsg = type.verify(obj);
  if (errMsg) {
    throw new Error(errMsg);
  }
  return Buffer.from(type.encode(type.create(obj)).finish()).toString('base64');
}

describe('DanmakuExtractor', () => {
  const extractor = new DanmakuExtractor();

  it('extracts standard DANMU_MSG correctly', () => {
    const rawMsg = {
      cmd: 'DANMU_MSG',
      info: [
        [0, 1, 25, 16777215, 1710000000, 123456, 0, 'a1b2c3d4', 0, 0, 0, '', 0, '{}', '{}', { user: { base: { name_color: '' } } }],
        '你好世界',
        [12345678, '测试用户***', 0, 0, 0, 10000, 1, ''],
        [],
        [1, 0, 9868950, '>50000'],
        [],
        0,
        0,
        null,
        { ct: 'web' },
        0,
        0,
        null,
        null,
        0,
        2,
      ],
    };

    const event = extractor.extract(rawMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.roomId).toBe(1001);
    expect(event!.streamerUid).toBe(8888);
    expect(event!.danmaku).toBeDefined();
    expect(event!.danmaku!.type).toBe(0);
    expect(event!.danmaku!.message).toBe('你好世界');
    expect(event!.danmaku!.userId).toBe(12345678);
    expect(event!.danmaku!.userName).toBe('测试用户***');
    expect(event!.danmaku!.ct).toBe('web');
    expect(event!.danmaku!.sendDate).toBe(1710000000000);
    expect(event!.danmaku!.userCrc32).toBe(0xa1b2c3d4);
    expect(event!.danmaku!.sourceFingerprint).toBeGreaterThan(0n);
  });

  it('extracts DANMU_MSG with protocol version suffix like DANMU_MSG:4:0:2:2:2:0', () => {
    const rawMsg = {
      cmd: 'DANMU_MSG:4:0:2:2:2:0',
      info: [
        [0, 1, 25, 16777215, 1710000000, 123456, 0, '', 0, 0, 0, '', 0, '{}', '{}', {}],
        '弹幕内容',
        [99999, '普通用户', 0, 0, 0, 10000, 1, ''],
      ],
    };

    const event = extractor.extract(rawMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(0);
    expect(event!.danmaku!.message).toBe('弹幕内容');
    expect(event!.danmaku!.userId).toBe(99999);
  });

  it('discards DANMU_MSG_MIRROR (cross-room relay)', () => {
    const mirrorMsg = {
      cmd: 'DANMU_MSG_MIRROR',
      info: [
        [0, 1, 25, 16777215, 1710000000],
        '跨房弹幕',
        [11111, '跨房用户'],
      ],
    };

    const event = extractor.extract(mirrorMsg, 1001, 8888, 1710000000000);
    expect(event).toBeNull();
  });

  it('extracts SEND_GIFT correctly', () => {
    const giftMsg = {
      cmd: 'SEND_GIFT',
      data: {
        uid: 12345,
        uname: '送礼人',
        giftName: '小心心',
        num: 10,
        total_coin: 5000,
        timestamp: 1710000000,
      },
    };

    const event = extractor.extract(giftMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(1);
    expect(event!.danmaku!.message).toBe('小心心');
    expect(event!.danmaku!.count).toBe(10);
    expect(event!.danmaku!.price).toBe(5);
    expect(event!.danmaku!.userId).toBe(12345);
    expect(event!.danmaku!.userName).toBe('送礼人');
  });

  it('extracts SEND_GIFT_V2 purely from decoded protobuf object', () => {
    const pbBase64 = encodePb(sendGiftV2Type, {
      uid: 998877,
      u_name: 'V2送礼者',
      face: 'https://example.com/avatar.jpg',
      gift_info: [
        {
          gift_id: 10001,
          gift_name: '摩天大楼',
          num: 2,
          price: 50000,
          timestamp: 1710000000,
        },
      ],
    });

    const giftV2Msg = {
      cmd: 'SEND_GIFT_V2',
      data: {
        pb: pbBase64,
      },
    };

    const event = extractor.extract(giftV2Msg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(1);
    expect(event!.danmaku!.userId).toBe(998877);
    expect(event!.danmaku!.userName).toBe('V2送礼者');
    expect(event!.danmaku!.message).toBe('摩天大楼');
    expect(event!.danmaku!.count).toBe(2);
    expect(event!.danmaku!.price).toBe(100); // (50000 * 2) / 1000
    expect(event!.danmaku!.sendDate).toBe(1710000000000);
  });

  it('extracts INTERACT_WORD_V2 purely from decoded protobuf object', () => {
    const pbBase64 = encodePb(interactWordV2Type, {
      uid: 666888,
      username: '入场大佬',
      timestamp: 1710000000,
      timestamp_ms: 1710000000123,
    });

    const enterMsg = {
      cmd: 'INTERACT_WORD_V2',
      data: {
        pb: pbBase64,
      },
    };

    const event = extractor.extract(enterMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(4);
    expect(event!.danmaku!.userId).toBe(666888);
    expect(event!.danmaku!.userName).toBe('入场大佬');
    expect(event!.danmaku!.sendDate).toBe(1710000000123);
  });

  it('extracts INTERACT_WORD_V2 with username from nested uinfo.base when top username is empty', () => {
    const pbBase64 = encodePb(interactWordV2Type, {
      uid: 555333,
      username: '',
      timestamp_ms: 1710000000456,
      uinfo: {
        uid: 555333,
        base: {
          username: '嵌套用户名',
          avatar: 'https://example.com/face.jpg',
        },
      },
    });

    const enterMsg = {
      cmd: 'INTERACT_WORD_V2',
      data: {
        pb: pbBase64,
      },
    };

    const event = extractor.extract(enterMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.userId).toBe(555333);
    expect(event!.danmaku!.userName).toBe('嵌套用户名');
    expect(event!.danmaku!.sendDate).toBe(1710000000456);
  });

  it('extracts USER_TOAST_MSG_V2 correctly', () => {
    const toastMsg = {
      cmd: 'USER_TOAST_MSG_V2',
      data: {
        sender_uinfo: {
          uid: 10001,
          base: { name: '舰长用户' },
        },
        guard_info: {
          guard_level: 3,
          start_time: 1710000000,
          end_time: 1710000000,
        },
        pay_info: {
          num: 1,
          price: 198000,
          unit: '月',
        },
        gift_info: {
          gift_id: 10003,
          gift_name: '舰长',
        },
        role_name: '舰长',
        toast_msg: '<%舰长用户%> 开通了舰长',
      },
    };

    const event = extractor.extract(toastMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(2);
    expect(event!.danmaku!.userId).toBe(10001);
    expect(event!.danmaku!.userName).toBe('舰长用户');
    expect(event!.danmaku!.message).toBe('舰长');
    expect(event!.danmaku!.price).toBe(198);
    expect(event!.danmaku!.count).toBe(1);
    expect(event!.danmaku!.sendDate).toBe(1710000000000);
  });

  it('extracts SUPER_CHAT_MESSAGE correctly', () => {
    const scMsg = {
      cmd: 'SUPER_CHAT_MESSAGE',
      data: {
        uid: 54321,
        user_info: {
          uname: '醒目留言者',
        },
        message: '老板发财',
        price: 30,
        start_time: 1710000000,
      },
    };

    const event = extractor.extract(scMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(3);
    expect(event!.danmaku!.message).toBe('老板发财');
    expect(event!.danmaku!.price).toBe(30);
    expect(event!.danmaku!.userId).toBe(54321);
    expect(event!.danmaku!.userName).toBe('醒目留言者');
  });

  it('extracts WATCHED_CHANGE and LIKE_INFO_V3_UPDATE as RuntimeDelta', () => {
    const watchMsg = {
      cmd: 'WATCHED_CHANGE',
      data: {
        num: 12345,
      },
    };
    const watchEvent = extractor.extract(watchMsg, 1001, 8888, 1710000000000);
    expect(watchEvent).not.toBeNull();
    expect(watchEvent!.runtimeDelta).toBeDefined();
    expect(watchEvent!.runtimeDelta!.watchCount).toBe(12345);

    const likeMsg = {
      cmd: 'LIKE_INFO_V3_UPDATE',
      data: {
        click_count: 9999,
      },
    };
    const likeEvent = extractor.extract(likeMsg, 1001, 8888, 1710000000000);
    expect(likeEvent).not.toBeNull();
    expect(likeEvent!.runtimeDelta).toBeDefined();
    expect(likeEvent!.runtimeDelta!.likeCount).toBe(9999);
  });

  it('extracts PREPARING lifecycle signal', () => {
    const prepMsg = {
      cmd: 'PREPARING',
      data: {
        live_key: 'live_123',
      },
    };
    const event = extractor.extract(prepMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.lifecycleSignal).toBeDefined();
  });

  it('discards unknown spam packets like ONLINE_RANK_COUNT and HOT_ROOM_NOTIFY', () => {
    expect(extractor.extract({ cmd: 'ONLINE_RANK_COUNT', data: {} }, 1001, 8888, 1710000000000)).toBeNull();
    expect(extractor.extract({ cmd: 'HOT_ROOM_NOTIFY', data: {} }, 1001, 8888, 1710000000000)).toBeNull();
    expect(extractor.extract({ cmd: 'WIDGET_BANNER', data: {} }, 1001, 8888, 1710000000000)).toBeNull();
  });

  it('supports dynamically adding a custom type (e.g. type 13) via rules with zero client code change', () => {
    const customExtractor = new DanmakuExtractor();
    customExtractor.setRules({
      version: 999,
      rules: [
        {
          pattern: '^CUSTOM_CRIT_EVENT$',
          category: 'danmaku',
          type: 13,
          fields: {
            userId: 'data.player_id',
            userName: 'data.player_name',
            message: 'data.crit_text',
            price: 'data.cost',
          },
        },
      ],
    });

    const event = customExtractor.extract(
      {
        cmd: 'CUSTOM_CRIT_EVENT',
        data: {
          player_id: 777,
          player_name: '玩家A',
          crit_text: '触发暴击',
          cost: 5,
        },
      },
      1001,
      8888,
      1710000000000,
    );

    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(13);
    expect(event!.danmaku!.userId).toBe(777);
    expect(event!.danmaku!.userName).toBe('玩家A');
    expect(event!.danmaku!.message).toBe('触发暴击');
    expect(event!.danmaku!.price).toBe(5);
  });

  it('supports dynamically injecting a brand-new protobuf schema from server with zero client code change', () => {
    const dynamicExtractor = new DanmakuExtractor();
    const testProto = `
syntax = "proto3";
package custom.game;
message BossRaidEvent {
  uint64 player_uid = 1;
  string player_uname = 2;
  string skill_name = 3;
  uint32 damage = 4;
}
`;
    const testType = protobuf.parse(testProto, { keepCase: true }).root.lookupType('custom.game.BossRaidEvent');
    const pbBase64 = encodePb(testType, {
      player_uid: 888999,
      player_uname: '讨伐勇者',
      skill_name: '终极大招',
      damage: 99999,
    });

    dynamicExtractor.setRules({
      version: 1000,
      protobufs: [
        {
          name: 'custom.game.BossRaidEvent',
          proto: testProto,
        },
      ],
      rules: [
        {
          pattern: '^BOSS_RAID_V2$',
          category: 'danmaku',
          type: 20,
          proto: 'custom.game.BossRaidEvent',
          protoSource: 'data.pb',
          fields: {
            userId: 'player_uid',
            userName: 'player_uname',
            message: 'skill_name',
            price: 'damage',
          },
        },
      ],
    });

    const event = dynamicExtractor.extract(
      {
        cmd: 'BOSS_RAID_V2',
        data: {
          pb: pbBase64,
        },
      },
      1001,
      8888,
      1710000000000,
    );

    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(20);
    expect(event!.danmaku!.userId).toBe(888999);
    expect(event!.danmaku!.userName).toBe('讨伐勇者');
    expect(event!.danmaku!.message).toBe('终极大招');
    expect(event!.danmaku!.price).toBe(99999);
  });

  it('extracts INTERACT_WORD_V2 cleanly when Buffer is undefined (browser/Tauri webview environment)', () => {
    // 提前在有环境时生成 base64 pb 字符串
    const pbBase64 = encodePb(interactWordV2Type, {
      uid: 777666,
      username: '无Buffer环境用户',
      timestamp_ms: 1710000000999,
    });

    const originalBuffer = globalThis.Buffer;
    try {
      // 模拟浏览器/WebView环境：删除全局 Buffer
      (globalThis as any).Buffer = undefined;

      const enterMsg = {
        cmd: 'INTERACT_WORD_V2',
        data: {
          pb: pbBase64,
        },
      };

      const event = extractor.extract(enterMsg, 1001, 8888, 1710000000000);
      expect(event).not.toBeNull();
      expect(event!.danmaku!.userId).toBe(777666);
      expect(event!.danmaku!.userName).toBe('无Buffer环境用户');
      expect(event!.danmaku!.sendDate).toBe(1710000000999);
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });

  it('serializes and deserializes ExtractedUploadEvent with BigInt sourceFingerprint via MessagePack seamlessly', () => {
    const rawMsg = {
      cmd: 'DANMU_MSG',
      info: [
        [0, 1, 25, 16777215, 1710000000, 123456, 0, 'a1b2c3d4', 0, 0, 0, '', 0, '{}', '{}', {}],
        '测试BigInt序列化',
        [12345678, '测试用户', 0, 0, 0, 10000, 1, ''],
      ],
    };

    const event = extractor.extract(rawMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(typeof event!.danmaku!.sourceFingerprint).toBe('bigint');

    const encoded = encodeMsgPackPayload(event);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeMsgPackPayload<typeof event>(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.danmaku!.sourceFingerprint).toBe(event!.danmaku!.sourceFingerprint);
    expect(decoded!.danmaku!.message).toBe('测试BigInt序列化');
  });
});
