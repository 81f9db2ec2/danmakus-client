export interface DanmakuProtobufSchema {
  name: string;
  proto: string;
}

export interface JsonataExtractionRuleV2 {
  pattern: string;
  discardPatterns?: string[];
  /** JSONata 表达式，与服务端 Corvus 引擎共用同一份规则源 */
  expr: string;
}

export interface JsonataExtractionRuleSetV2 {
  version: number;
  protobufs?: DanmakuProtobufSchema[];
  /** 与各规则表达式拼进同一作用域的前置函数定义（$hex32/$timestamp/$first 等） */
  prelude?: string;
  rules: JsonataExtractionRuleV2[];
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
