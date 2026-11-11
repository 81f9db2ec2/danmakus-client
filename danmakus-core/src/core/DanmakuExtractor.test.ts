import { describe, expect, it } from 'bun:test';
import protobuf from 'protobufjs';
import { DanmakuExtractor } from './DanmakuExtractor.js';
import {
  INTERACT_WORD_V2_PROTO,
  SEND_GIFT_V2_PROTO,
  SERVER_EXTRACTION_RULE_SET,
} from './DanmakuExtractor.fixture.js';
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
  const extractor = new DanmakuExtractor(SERVER_EXTRACTION_RULE_SET);

  it('extracts standard DANMU_MSG correctly', async () => {
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

    const event = await extractor.extract(rawMsg, 1001, 8888, 1710000000000);
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
  });

  it('extracts DANMU_MSG with protocol version suffix like DANMU_MSG:4:0:2:2:2:0', async () => {
    const rawMsg = {
      cmd: 'DANMU_MSG:4:0:2:2:2:0',
      info: [
        [0, 1, 25, 16777215, 1710000000, 123456, 0, '', 0, 0, 0, '', 0, '{}', '{}', {}],
        '弹幕内容',
        [99999, '普通用户', 0, 0, 0, 10000, 1, ''],
      ],
    };

    const event = await extractor.extract(rawMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(0);
    expect(event!.danmaku!.message).toBe('弹幕内容');
    expect(event!.danmaku!.userId).toBe(99999);
  });

  it('discards DANMU_MSG_MIRROR (cross-room relay)', async () => {
    const mirrorMsg = {
      cmd: 'DANMU_MSG_MIRROR',
      info: [
        [0, 1, 25, 16777215, 1710000000],
        '跨房弹幕',
        [11111, '跨房用户'],
      ],
    };

    const event = await extractor.extract(mirrorMsg, 1001, 8888, 1710000000000);
    expect(event).toBeNull();
  });

  it('extracts SEND_GIFT correctly', async () => {
    const giftMsg = {
      cmd: 'SEND_GIFT',
      data: {
        uid: 12345,
        uname: '送礼人',
        giftName: '小心心',
        num: 10,
        price: 500,
        timestamp: 1710000000,
      },
    };

    const event = await extractor.extract(giftMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(1);
    expect(event!.danmaku!.message).toBe('小心心');
    expect(event!.danmaku!.count).toBe(10);
    expect(event!.danmaku!.price).toBe(5);
    expect(event!.danmaku!.userId).toBe(12345);
    expect(event!.danmaku!.userName).toBe('送礼人');
  });

  it('extracts SEND_GIFT_V2 purely from decoded protobuf object', async () => {
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

    const event = await extractor.extract(giftV2Msg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(1);
    expect(event!.danmaku!.userId).toBe(998877);
    expect(event!.danmaku!.userName).toBe('V2送礼者');
    expect(event!.danmaku!.message).toBe('摩天大楼');
    expect(event!.danmaku!.count).toBe(2);
    expect(event!.danmaku!.price).toBe(100); // (50000 * 2) / 1000
    expect(event!.danmaku!.sendDate).toBe(1710000000000);
  });

  it('extracts INTERACT_WORD_V2 purely from decoded protobuf object', async () => {
    const pbBase64 = encodePb(interactWordV2Type, {
      uid: 666888,
      username: '入场大佬',
      timestamp: 1710000000,
      timestamp_ms: 1710000000123,
    });

    const event = await extractor.extract(
      {
        cmd: 'INTERACT_WORD_V2',
        data: { pb: pbBase64 },
      },
      1001,
      8888,
      1710000000000,
    );

    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(4);
    expect(event!.danmaku!.userId).toBe(666888);
    expect(event!.danmaku!.userName).toBe('入场大佬');
    expect(event!.danmaku!.sendDate).toBe(1710000000123);
    expect(event!.danmaku!.ct).toBeUndefined();
  });

  it('extracts INTERACT_WORD_V2 with username from nested uinfo.base when top username is empty', async () => {
    const pbBase64 = encodePb(interactWordV2Type, {
      uid: 555333,
      username: '',
      timestamp: 1710000000,
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

    const event = await extractor.extract(enterMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.userId).toBe(555333);
    expect(event!.danmaku!.userName).toBe('嵌套用户名');
    expect(event!.danmaku!.sendDate).toBe(1710000000000);
  });

  it('extracts INTERACT_WORD_V2 follow and share sources', async () => {
    const follow = await extractor.extract(
      {
        cmd: 'INTERACT_WORD_V2',
        data: {
          pb: encodePb(interactWordV2Type, {
            uid: 1,
            username: '关注',
            msg_type: 2,
            timestamp_ms: 1710000000123,
          }),
        },
      },
      1001,
      8888,
      1710000000000,
    );
    const share = await extractor.extract(
      {
        cmd: 'INTERACT_WORD_V2',
        data: {
          pb: encodePb(interactWordV2Type, {
            uid: 2,
            username: '分享',
            msg_type: 3,
            timestamp_ms: 1710000000123,
          }),
        },
      },
      1001,
      8888,
      1710000000000,
    );
    expect(follow!.danmaku!.msgType).toBe(2);
    expect(follow!.danmaku!.ct).toBeUndefined();
    expect(share!.danmaku!.msgType).toBe(3);
    expect(share!.danmaku!.ct).toBeUndefined();
  });

  it('extracts USER_TOAST_MSG_V2 correctly', async () => {
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

    const event = await extractor.extract(toastMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(2);
    expect(event!.danmaku!.userId).toBe(10001);
    expect(event!.danmaku!.userName).toBe('舰长用户');
    expect(event!.danmaku!.message).toBe('舰长');
    expect(event!.danmaku!.price).toBe(198);
    expect(event!.danmaku!.count).toBe(1);
    expect(event!.danmaku!.sendDate).toBe(1710000000000);
  });

  it('ignores GUARD_BUY', async () => {
    const event = await extractor.extract({
      cmd: 'GUARD_BUY',
      data: {
        uid: 10001,
        username: 'user-a',
        guard_level: 2,
        num: 1,
        price: 1998000,
        gift_name: '提督',
        start_time: 1710000000,
      },
    }, 1001, 8888, 1710000000000);
    expect(event).toBeNull();
  });

  it('extracts USER_TOAST_MSG as fallback guard', async () => {
    const event = await extractor.extract({
      cmd: 'USER_TOAST_MSG',
      data: {
        uid: 10001,
        username: 'user-a',
        num: 1,
        guard_level: 2,
        price: 1598000,
        role_name: '提督',
        start_time: 1710000000,
      },
    }, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(2);
    expect(event!.danmaku!.message).toBe('提督');
    expect(event!.danmaku!.price).toBe(1598);
  });

  it('extracts USER_TOAST_MSG_V2 guard level when role name is missing', async () => {
    const event = await extractor.extract({
      cmd: 'USER_TOAST_MSG_V2',
      data: {
        sender_uinfo: { uid: 10001, base: { name: 'user-a' } },
        guard_info: { guard_level: 2, start_time: 1710000000 },
        pay_info: { num: 1, price: 1598000 },
      },
    }, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(2);
    expect(event!.danmaku!.userId).toBe(10001);
    expect(event!.danmaku!.message).toBe('2');
    expect(event!.danmaku!.price).toBe(1598);
  });

  it('extracts SUPER_CHAT_MESSAGE correctly', async () => {
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

    const event = await extractor.extract(scMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();
    expect(event!.danmaku!.type).toBe(3);
    expect(event!.danmaku!.message).toBe('老板发财');
    expect(event!.danmaku!.price).toBe(30);
    expect(event!.danmaku!.userId).toBe(54321);
    expect(event!.danmaku!.userName).toBe('醒目留言者');
  });

  it('extracts WATCHED_CHANGE, LIKE_INFO_V3_UPDATE and ONLINE_RANK_COUNT as RuntimeDelta', async () => {
    const watchMsg = {
      cmd: 'WATCHED_CHANGE',
      data: {
        num: 12345,
      },
    };
    const watchEvent = await extractor.extract(watchMsg, 1001, 8888, 1710000000000);
    expect(watchEvent).not.toBeNull();
    expect(watchEvent!.runtimeDelta).toBeDefined();
    expect(watchEvent!.runtimeDelta!.watchCount).toBe(12345);

    const likeMsg = {
      cmd: 'LIKE_INFO_V3_UPDATE',
      data: {
        click_count: 9999,
      },
    };
    const likeEvent = await extractor.extract(likeMsg, 1001, 8888, 1710000000000);
    expect(likeEvent).not.toBeNull();
    expect(likeEvent!.runtimeDelta).toBeDefined();
    expect(likeEvent!.runtimeDelta!.likeCount).toBe(9999);

    const onlineRankMsg = {
      cmd: 'ONLINE_RANK_COUNT',
      data: {
        count: 888,
        online_count: 1234,
      },
    };
    const onlineRankEvent = await extractor.extract(onlineRankMsg, 1001, 8888, 1710000000000);
    expect(onlineRankEvent).not.toBeNull();
    expect(onlineRankEvent!.runtimeDelta).toBeDefined();
    expect(onlineRankEvent!.runtimeDelta!.onlineRank).toBe(1234);
  });

  it.each([
    [{ count: 7 }, undefined],
    [{ count: 7, online_count: 0 }, 0],
    [{ count: 7, online_count: 234 }, 234],
  ])('extracts only the current online count from %j', async (data, expected) => {
    const event = await extractor.extract({ cmd: 'ONLINE_RANK_COUNT', data }, 1001, 8888, 1710000000000);
    expect(event?.runtimeDelta?.onlineRank).toBe(expected);
  });

  it('extracts PREPARING lifecycle signal', async () => {
    const prepMsg = {
      cmd: 'PREPARING',
      data: {
        live_key: 'live_123',
      },
    };
    const event = await extractor.extract(prepMsg, 1001, 8888, 1710000000000);
    expect(event!.lifecycleSignal).toEqual({ stopLive: true, liveId: 'live_123' });
    expect((await extractor.extract({ cmd: 'LIVE', data: { live_key: 'k' } }, 1001, 8888, 1))!.lifecycleSignal).toEqual({ liveId: 'k' });
  });

  it('stamps every event with the rule set version', async () => {
    const event = await extractor.extract({ cmd: 'WATCHED_CHANGE', data: { num: 1 } }, 1001, 8888, 1);
    expect(event!.rulesVersion).toBe(SERVER_EXTRACTION_RULE_SET.version);
  });

  it('forwards room emoji parts for the server to compose', async () => {
    const event = await extractor.extract(
      {
        cmd: 'DANMU_MSG',
        info: [
          [0, 1, 25, 16777215, 1710000000, 0, 0, '', 0, 0, 0, '', 1, { emoticon_unique: 'room_1_e', url: 'https://e.png' }],
          'e',
          [1, 'u'],
        ],
      },
      1001,
      8888,
      1,
    );
    expect(event!.danmaku).toMatchObject({ isEmoji: true, roomEmojiName: 'room_1_e', roomEmojiUrl: 'https://e.png' });
  });

  it('discards unknown spam packets like HOT_ROOM_NOTIFY and WIDGET_BANNER', async () => {
    expect(await extractor.extract({ cmd: 'HOT_ROOM_NOTIFY', data: {} }, 1001, 8888, 1710000000000)).toBeNull();
    expect(await extractor.extract({ cmd: 'WIDGET_BANNER', data: {} }, 1001, 8888, 1710000000000)).toBeNull();
  });

  it('supports dynamically adding a custom type (e.g. type 13) via rules with zero client code change', async () => {
    const customExtractor = new DanmakuExtractor();
    customExtractor.setRules({
      version: 999,
      rules: [
        {
          pattern: '^CUSTOM_CRIT_EVENT$',
          expr: `{
            "danmaku": {
              "type": 13,
              "userId": $number(data.player_id),
              "userName": data.player_name,
              "message": data.crit_text,
              "price": $number(data.cost)
            }
          }`,
        },
      ],
    });

    const event = await customExtractor.extract(
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

  it('evaluates rule output as-is without client-side coercion layers', async () => {
    const evaluator = new DanmakuExtractor({
      version: 7,
      rules: [
        {
          pattern: '^RAW$',
          expr: `{
            "danmaku": {
              "type": 0,
              "userId": $number(data.id),
              "message": $string(data.blob.a[0])
            }
          }`,
        },
      ],
    });
    const event = await evaluator.extract({ cmd: 'RAW', data: { id: '42', blob: { a: [1] } } }, 1, 1, 1);
    expect(event!.danmaku!).toEqual({ type: 0, userId: 42, message: '1' });
    expect(event!.rulesVersion).toBe(7);
  });

  it('drops the event when protobuf decoding fails', async () => {
    expect(await extractor.extract({ cmd: 'SEND_GIFT_V2', data: { pb: '!!not-pb!!' } }, 1, 1, 1)).toBeNull();
  });

  it('rejects invalid rule sets atomically and keeps previous rules', async () => {
    const guarded = new DanmakuExtractor(SERVER_EXTRACTION_RULE_SET);
    expect(() => guarded.setRules({ version: 99, rules: [{ pattern: '(', expr: '{}' }] })).toThrow();
    expect(() => guarded.setRules({ version: 99, rules: [{ pattern: '^X$', expr: '{"danmaku": {' }] })).toThrow();
    expect((await guarded.extract({ cmd: 'WATCHED_CHANGE', data: { num: 1 } }, 1, 1, 1))!.rulesVersion).toBe(SERVER_EXTRACTION_RULE_SET.version);
  });

  it('supports dynamically injecting a brand-new protobuf schema from server with zero client code change', async () => {
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
          expr: `(
            $m := $pb("custom.game.BossRaidEvent", data.pb);
            $m ? {
              "danmaku": {
                "type": 20,
                "userId": $number($m.player_uid),
                "userName": $m.player_uname,
                "message": $m.skill_name,
                "price": $number($m.damage)
              }
            }
          )`,
        },
      ],
    });

    const event = await dynamicExtractor.extract(
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

  it('extracts INTERACT_WORD_V2 cleanly when Buffer is undefined (browser/Tauri webview environment)', async () => {
    // 提前在有环境时生成 base64 pb 字符串
    const pbBase64 = encodePb(interactWordV2Type, {
      uid: 777666,
      username: '无Buffer环境用户',
      timestamp: 1710000000,
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

      const event = await extractor.extract(enterMsg, 1001, 8888, 1710000000000);
      expect(event).not.toBeNull();
      expect(event!.danmaku!.userId).toBe(777666);
      expect(event!.danmaku!.userName).toBe('无Buffer环境用户');
      expect(event!.danmaku!.sendDate).toBe(1710000000000);
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });

  it('serializes and deserializes ExtractedUploadEvent via MessagePack seamlessly', async () => {
    const rawMsg = {
      cmd: 'DANMU_MSG',
      info: [
        [0, 1, 25, 16777215, 1710000000, 123456, 0, 'a1b2c3d4', 0, 0, 0, '', 0, '{}', '{}', {}],
        '测试MessagePack序列化',
        [12345678, '测试用户', 0, 0, 0, 10000, 1, ''],
      ],
    };

    const event = await extractor.extract(rawMsg, 1001, 8888, 1710000000000);
    expect(event).not.toBeNull();

    const encoded = encodeMsgPackPayload(event);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeMsgPackPayload<typeof event>(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.danmaku!.message).toBe('测试MessagePack序列化');
  });

  it('does not extract anything before server rules arrive', async () => {
    const idle = new DanmakuExtractor();
    expect(await idle.extract({ cmd: 'DANMU_MSG', info: [[], 'x', [1, 'a']] }, 1, 1, 1)).toBeNull();
  });

  it('extracts SEND_GIFT mystery box name and price from blind_gift', async () => {
    const event = await extractor.extract(
      {
        cmd: 'SEND_GIFT',
        data: {
          uid: 1,
          uname: '盲盒用户',
          giftName: '小花花',
          num: 1,
          price: 100,
          coin_type: 'gold',
          timestamp: 1710000000,
          blind_gift: {
            original_gift_name: '4000点心盒',
            original_gift_price: 4000000,
            gift_tip_price: 100,
          },
        },
      },
      1001,
      8888,
      1710000000000,
    );
    expect(event?.danmaku?.message).toBe('小花花');
    expect(event?.danmaku?.price).toBe(0.1);
    expect(event?.danmaku?.mysteryBoxName).toBe('4000点心盒');
    expect(event?.danmaku?.mysteryBoxPrice).toBe(4000);
  });

  it('forwards SEND_GIFT coinType=silver for the server to zero price', async () => {
    const event = await extractor.extract(
      {
        cmd: 'SEND_GIFT',
        data: {
          uid: 2,
          uname: '银瓜子',
          giftName: '辣条',
          num: 10,
          price: 100,
          coin_type: 'silver',
          timestamp: 1710000000,
        },
      },
      1001,
      8888,
      1710000000000,
    );
    expect(event?.danmaku?.message).toBe('辣条');
    expect(event?.danmaku?.coinType).toBe('silver');
    expect(event?.danmaku?.price).toBe(1);
  });

  it('extracts SEND_GIFT_V2 mystery box from protobuf', async () => {
    const pbBase64 = encodePb(sendGiftV2Type, {
      uid: 3,
      u_name: 'V2盲盒',
      mystery_box: {
        box_name: '百元盲盒',
        box_price: 100000,
      },
      gift_info: [
        {
          gift_id: 1,
          gift_name: '小花花',
          num: 1,
          price: 100,
          timestamp: 1710000000,
        },
      ],
    });
    const event = await extractor.extract(
      { cmd: 'SEND_GIFT_V2', data: { pb: pbBase64 } },
      1001,
      8888,
      1710000000000,
    );
    expect(event?.danmaku?.message).toBe('小花花');
    expect(event?.danmaku?.price).toBe(0.1);
    expect(event?.danmaku?.mysteryBoxName).toBe('百元盲盒');
    expect(event?.danmaku?.mysteryBoxPrice).toBe(100);
  });

  it('splits a SEND_GIFT_V2 blind-box combo into one event per opened tier', async () => {
    const pbBase64 = encodePb(sendGiftV2Type, {
      uid: 3,
      u_name: 'V2盲盒',
      mystery_box: {
        box_name: '百元盲盒',
        box_price: 100000,
      },
      gift_info: [
        { gift_id: 1, gift_name: '小花花', num: 6, price: 100, tid: 'combo-a', timestamp: 1710000000 },
        { gift_id: 2, gift_name: '摩天大楼', num: 4, price: 50000, tid: 'combo-b', timestamp: 1710000000 },
      ],
    });
    const events = await extractor.extractAll(
      { cmd: 'SEND_GIFT_V2', data: { pb: pbBase64 } },
      1001,
      8888,
      1710000000000,
    );
    expect(events.map((event) => event.danmaku)).toEqual([
      expect.objectContaining({
        message: '小花花',
        count: 6,
        price: 0.6,
        giftTid: 'combo-a',
        mysteryBoxName: '百元盲盒',
        mysteryBoxPrice: 600,
      }),
      expect.objectContaining({
        message: '摩天大楼',
        count: 4,
        price: 200,
        giftTid: 'combo-b',
        mysteryBoxName: '百元盲盒',
        mysteryBoxPrice: 400,
      }),
    ]);
  });

  it.each([0, 1, 2, 3])('extracts ENTRY_EFFECT as enter for privilege type %i', async (privilegeType) => {
    const event = await extractor.extract(
      {
        cmd: 'ENTRY_EFFECT',
        data: {
          uid: 9,
          privilege_type: privilegeType,
          uinfo: { uid: 9, base: { name: 'entry-user' } },
          trigger_time: 1710000000000000000,
        },
      },
      1001,
      8888,
      1710000000000,
    );
    expect(event?.danmaku?.type).toBe(4);
    expect(event?.danmaku?.userId).toBe(9);
    expect(event?.danmaku?.userName).toBe('entry-user');
    expect(event?.danmaku?.sendDate).toBe(1710000000000);
    expect(event?.eventTsMs).toBe(1710000000000);
  });

  it('extracts USER_VIRTUAL_MVP as guard', async () => {
    const event = await extractor.extract(
      {
        cmd: 'USER_VIRTUAL_MVP',
        data: {
          uid: 4,
          uname: '大法师',
          goods_name: '大法师',
          goods_price: 1998000,
          goods_num: 1,
          timestamp: 1710000000,
        },
      },
      1001,
      8888,
      1710000000000,
    );
    expect(event?.danmaku?.type).toBe(2);
    expect(event?.danmaku?.userName).toBe('大法师');
    expect(event?.danmaku?.message).toBe('大法师');
    expect(event?.danmaku?.price).toBe(1998);
  });
});
