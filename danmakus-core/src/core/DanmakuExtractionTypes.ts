/**
 * 字段取值类型，客户端据此把原始值转换成服务端 DTO 期望的线上类型。
 * - string（默认）：字符串原样；数字/布尔转字符串；对象/数组转 JSON 字符串
 * - timestamp：秒或毫秒时间戳（< 1e10 视为秒）以及可被 Date.parse 的字符串，统一输出 Unix 毫秒
 * - hex32：8 位十六进制字符串解析为 uint32
 * 转换失败的字段直接丢弃，不会污染整批上传。
 */
export type DanmakuFieldValueType = 'string' | 'int' | 'float' | 'bool' | 'hex32' | 'timestamp';

export interface DanmakuFieldSpec {
  /** 取值路径，`a.b.0 | c.d` 表示按顺序取第一个非空值 */
  path: string;
  as?: DanmakuFieldValueType;
  /** 乘以同一条规则中另一个已提取字段的值（先乘后除） */
  mul?: string;
  div?: number;
}

export type DanmakuExtractionTarget = 'danmaku' | 'runtimeDelta' | 'lifecycleSignal';

export interface DanmakuExtractionRule {
  pattern: string;
  discardPatterns?: string[];
  target: DanmakuExtractionTarget;
  proto?: string;
  protoSource?: string;
  fields?: Record<string, DanmakuFieldSpec>;
  consts?: Record<string, string | number | boolean>;
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

export type ExtractedPayload = Record<string, string | number | boolean | bigint>;

export interface ExtractedUploadEvent {
  localId?: number;
  streamerUid: number;
  eventTsMs: number;
  roomId: number;
  rulesVersion: number;
  danmaku?: ExtractedPayload;
  runtimeDelta?: ExtractedPayload;
  lifecycleSignal?: ExtractedPayload;
}

export interface ExtractedUploadBatch {
  events: ExtractedUploadEvent[];
  batchId?: string;
}
