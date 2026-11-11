import jsonata from 'jsonata';
import protobuf from 'protobufjs';
import type {
  ExtractedUploadEvent,
  JsonataExtractionRuleSetV2,
  JsonataExtractionRuleV2,
} from './DanmakuExtractionTypes.js';

interface CompiledRule {
  pattern: RegExp;
  discards: RegExp[];
  expression: jsonata.Expression;
}

interface CompiledRuleSet {
  version: number;
  /** 按 manifest 顺序首次命中，与服务端 JsonataDanmakuExtractor 的匹配语义一致 */
  rules: CompiledRule[];
}

type ProtobufRoot = protobuf.Root;

/** prelude 与各规则表达式拼进同一块作用域，与 C# 端 Compile 的拼装保持一致 */
function buildExpressionSource(prelude: string | null | undefined, expression: string): string {
  const head = prelude?.trim();
  return head ? `(\n${head};\n${expression}\n)` : expression;
}

/** proto3 JSON 常用 snake_case；动态解码产出 snake_case 字段以对齐服务端 DynamicProtobufDecoder */
function decodeBase64(base64: string): Uint8Array {
  const bytes = new Uint8Array(protobuf.util.base64.length(base64));
  protobuf.util.base64.decode(base64, bytes, 0);
  return bytes;
}

function createProtobufBinding(root: ProtobufRoot): (name?: unknown, base64?: unknown) => unknown {
  return (name?: unknown, base64?: unknown) => {
    if (typeof name !== 'string' || typeof base64 !== 'string' || !name || !base64) {
      return undefined;
    }
    let type: protobuf.Type;
    try {
      type = root.lookupType(name);
    } catch {
      return undefined;
    }
    try {
      return type.toObject(type.decode(decodeBase64(base64)), {
        longs: Number,
        enums: Number,
        bytes: String,
        defaults: false,
        arrays: true,
        objects: true,
      });
    } catch {
      return undefined;
    }
  };
}

export class DanmakuExtractor {
  private ruleSet: CompiledRuleSet = { version: 0, rules: [] };

  constructor(ruleSet?: JsonataExtractionRuleSetV2) {
    if (ruleSet) {
      this.setRules(ruleSet);
    }
  }

  public getVersion(): number {
    return this.ruleSet.version;
  }

  /** 全部编译成功后整体替换；任何一处非法都会抛错并保留旧规则 */
  public setRules(ruleSet: JsonataExtractionRuleSetV2): void {
    const root = new protobuf.Root();
    for (const schema of ruleSet.protobufs ?? []) {
      protobuf.parse(schema.proto, root, { keepCase: true });
    }
    const pb = createProtobufBinding(root);

    const rules: CompiledRule[] = (ruleSet.rules ?? []).map((rule) => this.compileRule(rule, ruleSet.prelude, pb));
    this.ruleSet = { version: ruleSet.version, rules };
  }

  private compileRule(
    rule: JsonataExtractionRuleV2,
    prelude: string | null | undefined,
    pb: (name?: unknown, base64?: unknown) => unknown,
  ): CompiledRule {
    const expression = jsonata(buildExpressionSource(prelude, rule.expr));
    expression.registerFunction('pb', pb as (...args: unknown[]) => unknown, '<ss:o>');
    return {
      pattern: new RegExp(rule.pattern),
      discards: (rule.discardPatterns ?? []).map((p) => new RegExp(p)),
      expression,
    };
  }

  public async extract(
    message: unknown,
    roomId: number,
    streamerUid: number,
    eventTsMs: number,
  ): Promise<ExtractedUploadEvent | null> {
    return (await this.extractAll(message, roomId, streamerUid, eventTsMs))[0] ?? null;
  }

  /** 规则返回数组时每个元素各产出一条事件（如盲盒连送一条消息爆出多档） */
  public async extractAll(
    message: unknown,
    roomId: number,
    streamerUid: number,
    eventTsMs: number,
  ): Promise<ExtractedUploadEvent[]> {
    const cmd = String((message as any)?.cmd ?? (message as any)?.msg?.cmd ?? '');
    const rule = this.matchRule(cmd);
    if (!rule) {
      return [];
    }

    const evaluated = await rule.expression.evaluate(message);
    if (evaluated === undefined || evaluated === null) {
      return [];
    }

    const items = Array.isArray(evaluated) ? evaluated : [evaluated];
    const events: ExtractedUploadEvent[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const event: ExtractedUploadEvent = {
        streamerUid,
        eventTsMs,
        roomId,
        rulesVersion: this.ruleSet.version,
      };
      if (item.danmaku && typeof item.danmaku === 'object') {
        event.danmaku = item.danmaku;
      } else if (item.runtimeDelta && typeof item.runtimeDelta === 'object') {
        event.runtimeDelta = item.runtimeDelta;
      } else if (item.lifecycleSignal && typeof item.lifecycleSignal === 'object') {
        event.lifecycleSignal = item.lifecycleSignal;
      }
      if (event.danmaku || event.runtimeDelta || event.lifecycleSignal) {
        events.push(event);
      }
    }
    return events;
  }

  private matchRule(cmd: string): CompiledRule | undefined {
    if (!cmd) {
      return undefined;
    }
    return this.ruleSet.rules.find(
      (rule) => rule.pattern.test(cmd) && !rule.discards.some((d) => d.test(cmd)),
    );
  }
}
