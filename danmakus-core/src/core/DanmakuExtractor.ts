import protobuf from 'protobufjs';
import type {
  DanmakuExtractionFields,
  DanmakuExtractionRule,
  DanmakuExtractionRuleSet,
  ExtractedDanmakuInfo,
  ExtractedUploadEvent,
  LiveLifecycleSignalInfo,
  RuntimeDeltaInfo,
} from './DanmakuExtractionTypes.js';
import { DEFAULT_EXTRACTION_RULE_SET } from './DanmakuExtractionTypes.js';
import { computeDanmakuFingerprint } from './Fingerprint.js';

function decodeBase64ToUint8Array(base64Str: string): Uint8Array | null {
  try {
    if (typeof (Uint8Array as any).fromBase64 === 'function') {
      return (Uint8Array as any).fromBase64(base64Str);
    }
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(base64Str, 'base64');
      return buf.byteLength > 0 ? buf : null;
    }
    const len = protobuf.util.base64.length(base64Str);
    if (len <= 0) {
      return null;
    }
    const bytes = new Uint8Array(len);
    protobuf.util.base64.decode(base64Str, bytes, 0);
    return bytes;
  } catch {
    return null;
  }
}

type PathKey = string | number;

function parseSinglePath(pathStr: string): PathKey[] {
  return pathStr.split('.').map((part) => {
    const num = Number(part);
    return Number.isInteger(num) && String(num) === part ? num : part;
  });
}

function parsePathList(pathStr?: string): PathKey[][] | undefined {
  if (!pathStr || typeof pathStr !== 'string') {
    return undefined;
  }
  const parts = pathStr.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.map(parseSinglePath);
}

function resolvePath(target: any, pathKeys: PathKey[]): any {
  if (!pathKeys || pathKeys.length === 0 || target == null) {
    return undefined;
  }
  let current = target;
  for (let i = 0; i < pathKeys.length; i++) {
    if (current == null) {
      return undefined;
    }
    current = current[pathKeys[i]];
  }
  return current;
}

function resolveFrom(targets: any[], pathList?: PathKey[][]): any {
  if (!pathList || pathList.length === 0) {
    return undefined;
  }
  for (let p = 0; p < pathList.length; p++) {
    const path = pathList[p];
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t];
      if (target == null) {
        continue;
      }
      const val = resolvePath(target, path);
      if (val !== undefined && val !== null && val !== '') {
        return val;
      }
    }
  }
  return undefined;
}

interface CompiledFields {
  userId?: PathKey[][];
  userName?: PathKey[][];
  message?: PathKey[][];
  sendDate?: PathKey[][];
  price?: PathKey[][];
  priceDivisor?: number;
  priceTimesCount?: boolean;
  count?: PathKey[][];
  ct?: PathKey[][];
  isEmoji?: PathKey[][];
  roomEmojiName?: PathKey[][];
  roomEmojiUrl?: PathKey[][];
  userCrc32?: PathKey[][];
  liveId?: PathKey[][];
  stopLive?: boolean;
}

interface CompiledRule {
  patternRegex: RegExp;
  discardRegexes: RegExp[];
  category: 'danmaku' | 'delta' | 'lifecycle';
  type: number;
  proto?: string;
  protoSource?: PathKey[];
  fields?: CompiledFields;
}

const protobufToObjectOptions: protobuf.IConversionOptions = {
  longs: Number,
  enums: Number,
  bytes: String,
  defaults: false,
  arrays: true,
  objects: false,
  oneofs: false,
};

export class DanmakuExtractor {
  private version: number = 0;
  private rules: CompiledRule[] = [];
  private protobufTypes: Map<string, protobuf.Type> = new Map();

  constructor(ruleSet: DanmakuExtractionRuleSet = DEFAULT_EXTRACTION_RULE_SET) {
    this.setRules(ruleSet);
  }

  public getVersion(): number {
    return this.version;
  }

  public setRules(ruleSet: DanmakuExtractionRuleSet): void {
    this.version = ruleSet.version ?? 1;
    this.compileProtobufSchemas(ruleSet.protobufs ?? []);
    this.rules = (ruleSet.rules ?? []).map((r) => this.compileRule(r));
  }

  private compileProtobufSchemas(schemas: Array<{ name: string; proto: string }>): void {
    this.protobufTypes.clear();
    for (let i = 0; i < schemas.length; i++) {
      const schema = schemas[i];
      if (!schema?.proto) {
        continue;
      }
      try {
        const root = protobuf.parse(schema.proto, { keepCase: true }).root;
        const type = root.lookupType(schema.name);
        this.protobufTypes.set(schema.name, type);
      } catch {
        // proto 解析失败静默跳过
      }
    }
  }

  private compileRule(rule: DanmakuExtractionRule): CompiledRule {
    return {
      patternRegex: new RegExp(rule.pattern),
      discardRegexes: (rule.discardPatterns ?? []).map((p) => new RegExp(p)),
      category: rule.category ?? 'danmaku',
      type: rule.type ?? 0,
      proto: rule.proto,
      protoSource: rule.protoSource ? parseSinglePath(rule.protoSource) : parseSinglePath('data.pb'),
      fields: rule.fields ? this.compileFields(rule.fields) : undefined,
    };
  }

  private compileFields(fields: DanmakuExtractionFields): CompiledFields {
    return {
      userId: parsePathList(fields.userId),
      userName: parsePathList(fields.userName),
      message: parsePathList(fields.message),
      sendDate: parsePathList(fields.sendDate),
      price: parsePathList(fields.price),
      priceDivisor: fields.priceDivisor,
      priceTimesCount: fields.priceTimesCount,
      count: parsePathList(fields.count),
      ct: parsePathList(fields.ct),
      isEmoji: parsePathList(fields.isEmoji),
      roomEmojiName: parsePathList(fields.roomEmojiName),
      roomEmojiUrl: parsePathList(fields.roomEmojiUrl),
      userCrc32: parsePathList(fields.userCrc32),
      liveId: parsePathList(fields.liveId),
      stopLive: fields.stopLive,
    };
  }

  public extract(
    message: any,
    roomId: number,
    streamerUid: number,
    eventTsMs: number,
    rawPayloadBytes?: Uint8Array,
  ): ExtractedUploadEvent | null {
    if (!message) {
      return null;
    }

    const cmd = String(message.cmd || message.msg?.cmd || '');
    if (!cmd) {
      return null;
    }

    const matchedRule = this.findMatchingRule(cmd);
    if (!matchedRule) {
      return null;
    }

    const rawData = message.data !== undefined ? message.data : message;

    if (matchedRule.category === 'delta') {
      return this.extractDeltaEvent(cmd, rawData, roomId, streamerUid, eventTsMs);
    }

    if (matchedRule.category === 'lifecycle') {
      return this.extractLifecycleEvent(cmd, message, rawData, matchedRule, roomId, streamerUid, eventTsMs);
    }

    return this.extractDanmakuEvent(cmd, message, rawData, matchedRule, roomId, streamerUid, eventTsMs, rawPayloadBytes);
  }

  private findMatchingRule(cmd: string): CompiledRule | null {
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (rule.patternRegex.test(cmd)) {
        let isDiscarded = false;
        for (let j = 0; j < rule.discardRegexes.length; j++) {
          if (rule.discardRegexes[j].test(cmd)) {
            isDiscarded = true;
            break;
          }
        }
        if (!isDiscarded) {
          return rule;
        }
      }
    }
    return null;
  }

  private decodeProtobufPayload(rule: CompiledRule, message: any, rawData: any): any | null {
    if (!rule.proto) {
      return null;
    }
    const type = this.protobufTypes.get(rule.proto);
    if (!type) {
      return null;
    }

    const sourcePath = rule.protoSource ?? ['data', 'pb'];
    const rawPb = resolvePath(message, sourcePath) ?? resolvePath(rawData, sourcePath) ?? resolvePath(rawData, ['pb']);
    if (!rawPb) {
      return null;
    }

    let bytes: Uint8Array | null = null;
    if (rawPb instanceof Uint8Array) {
      bytes = rawPb.byteLength > 0 ? rawPb : null;
    } else if (typeof rawPb === 'string' && rawPb.length > 0) {
      bytes = decodeBase64ToUint8Array(rawPb);
    }

    if (!bytes) {
      return null;
    }

    try {
      return type.toObject(type.decode(bytes), protobufToObjectOptions);
    } catch {
      return null;
    }
  }

  private extractDanmakuEvent(
    _cmd: string,
    message: any,
    rawData: any,
    rule: CompiledRule,
    roomId: number,
    streamerUid: number,
    eventTsMs: number,
    rawPayloadBytes?: Uint8Array,
  ): ExtractedUploadEvent {
    const fields = rule.fields;
    const decodedPb = this.decodeProtobufPayload(rule, message, rawData);
    // Pipeline: 若为 proto 规则，只针对解码后的 pb 结构提取；否则针对原始 JSON 提取
    const targets = decodedPb ? [decodedPb, message] : [message, rawData];

    let userId = 0;
    if (fields?.userId) {
      const rawUid = resolveFrom(targets, fields.userId);
      const parsedUid = Number(rawUid);
      if (!Number.isNaN(parsedUid)) {
        userId = parsedUid;
      }
    }

    let userName = '';
    if (fields?.userName) {
      const rawName = resolveFrom(targets, fields.userName);
      userName = typeof rawName === 'string' ? rawName : String(rawName ?? '');
    }

    let messageText = '';
    if (fields?.message) {
      const rawMsg = resolveFrom(targets, fields.message);
      messageText = typeof rawMsg === 'string' ? rawMsg : String(rawMsg ?? '');
    }

    let sendDate = eventTsMs;
    if (fields?.sendDate) {
      const rawDate = resolveFrom(targets, fields.sendDate);
      if (typeof rawDate === 'number' && rawDate > 0) {
        sendDate = rawDate < 10_000_000_000 ? rawDate * 1000 : rawDate;
      } else if (typeof rawDate === 'string' && rawDate.length > 0) {
        const parsed = Date.parse(rawDate);
        if (!Number.isNaN(parsed)) {
          sendDate = parsed;
        }
      }
    }

    let count: number | null = null;
    if (fields?.count) {
      const rawCount = resolveFrom(targets, fields.count);
      const numCount = Number(rawCount);
      if (!Number.isNaN(numCount) && numCount > 0) {
        count = numCount;
      }
    }

    let price: number | null = null;
    if (fields?.price) {
      const rawPrice = resolveFrom(targets, fields.price);
      const numPrice = Number(rawPrice);
      if (!Number.isNaN(numPrice) && numPrice > 0) {
        let total = numPrice;
        if (fields.priceTimesCount && count && count > 0) {
          total = numPrice * count;
        }
        price = fields.priceDivisor ? total / fields.priceDivisor : total;
      }
    }

    let ct: string | null = null;
    if (fields?.ct) {
      const rawCt = resolveFrom(targets, fields.ct);
      if (rawCt != null) {
        ct = String(rawCt);
      }
    }

    let isEmoji: boolean | null = null;
    if (fields?.isEmoji) {
      const rawEmoji = resolveFrom(targets, fields.isEmoji);
      if (rawEmoji != null) {
        isEmoji = Boolean(rawEmoji === 1 || rawEmoji === '1' || rawEmoji === true);
      }
    }

    let roomEmoji: [string, string] | null = null;
    if (fields?.roomEmojiUrl) {
      const rawUrl = resolveFrom(targets, fields.roomEmojiUrl);
      if (typeof rawUrl === 'string' && rawUrl.length > 0) {
        const rawName = fields.roomEmojiName ? resolveFrom(targets, fields.roomEmojiName) : '';
        roomEmoji = [String(rawName ?? ''), rawUrl];
        isEmoji = true;
      }
    }

    let userCrc32: number | null = null;
    if (fields?.userCrc32 && (userId <= 0 || userName.endsWith('***'))) {
      const rawCrc = resolveFrom(targets, fields.userCrc32);
      if (typeof rawCrc === 'string' && rawCrc.length === 8) {
        const parsedCrc = parseInt(rawCrc, 16);
        if (!Number.isNaN(parsedCrc)) {
          userCrc32 = parsedCrc;
        }
      }
    }

    const fingerprint = computeDanmakuFingerprint(rawPayloadBytes ?? JSON.stringify(message));

    const danmaku: ExtractedDanmakuInfo = {
      type: rule.type,
      sendDate,
      userName,
      userId,
      message: messageText,
      price,
      count,
      ct,
      isEmoji,
      roomEmoji,
      userCrc32,
      sourceFingerprint: fingerprint > 0n ? fingerprint : null,
    };

    return {
      streamerUid,
      eventTsMs,
      roomId,
      danmaku,
    };
  }

  private extractDeltaEvent(
    cmd: string,
    rawData: any,
    roomId: number,
    streamerUid: number,
    eventTsMs: number,
  ): ExtractedUploadEvent {
    let watchCount: number | null = null;
    let likeCount: number | null = null;

    if (cmd === 'WATCHED_CHANGE') {
      const num = Number(rawData?.num ?? rawData?.watched_count);
      if (!Number.isNaN(num)) {
        watchCount = num;
      }
    } else if (cmd === 'LIKE_INFO_V3_UPDATE') {
      const click = Number(rawData?.click_count ?? rawData?.count);
      if (!Number.isNaN(click)) {
        likeCount = click;
      }
    }

    const runtimeDelta: RuntimeDeltaInfo = {
      watchCount,
      likeCount,
    };

    return {
      streamerUid,
      eventTsMs,
      roomId,
      runtimeDelta,
    };
  }

  private extractLifecycleEvent(
    cmd: string,
    message: any,
    rawData: any,
    rule: CompiledRule,
    roomId: number,
    streamerUid: number,
    eventTsMs: number,
  ): ExtractedUploadEvent {
    const liveId = rule.fields?.liveId
      ? String(resolveFrom([rawData, message], rule.fields.liveId) ?? '') || null
      : null;
    const stopLive = cmd === 'PREPARING' || rule.fields?.stopLive === true;

    const lifecycleSignal: LiveLifecycleSignalInfo = {
      liveId,
      stopLive,
    };

    return {
      streamerUid,
      eventTsMs,
      roomId,
      lifecycleSignal,
    };
  }
}
