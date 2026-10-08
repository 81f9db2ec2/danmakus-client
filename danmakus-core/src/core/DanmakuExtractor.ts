import protobuf from 'protobufjs';
import type {
  DanmakuExtractionRule,
  DanmakuExtractionRuleSet,
  DanmakuExtractionTarget,
  DanmakuFieldSpec,
  DanmakuFieldValueType,
  ExtractedPayload,
  ExtractedUploadEvent,
} from './DanmakuExtractionTypes.js';
import { computeDanmakuFingerprint } from './Fingerprint.js';

type PathKey = string | number;
type Scalar = string | number | boolean;

interface CompiledField {
  key: string;
  paths: PathKey[][];
  as: DanmakuFieldValueType;
  mul?: string;
  div?: number;
}

interface CompiledRule {
  pattern: RegExp;
  discards: RegExp[];
  target: DanmakuExtractionTarget;
  protoType?: protobuf.Type;
  protoSource: PathKey[];
  fields: CompiledField[];
  consts: Record<string, Scalar>;
}

interface CompiledRuleSet {
  version: number;
  rules: CompiledRule[];
}

const protobufToObjectOptions: protobuf.IConversionOptions = {
  longs: Number,
  enums: Number,
  bytes: String,
  defaults: false,
  arrays: true,
};

function parsePath(path: string): PathKey[] {
  return path.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function resolvePath(target: unknown, path: PathKey[]): unknown {
  let current: any = target;
  for (const key of path) {
    if (current == null) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function resolveFirst(targets: unknown[], paths: PathKey[][]): unknown {
  for (const path of paths) {
    for (const target of targets) {
      const value = resolvePath(target, path);
      if (isPresent(value)) {
        return value;
      }
    }
  }
  return undefined;
}

function toNumber(raw: unknown): number | undefined {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(num) ? num : undefined;
}

function coerce(raw: unknown, as: DanmakuFieldValueType): Scalar | undefined {
  switch (as) {
    case 'string':
      return typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    case 'int': {
      const num = toNumber(raw);
      return num === undefined ? undefined : Math.trunc(num);
    }
    case 'float':
      return toNumber(raw);
    case 'bool':
      if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true;
      if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false;
      return undefined;
    case 'hex32':
      return typeof raw === 'string' && /^[0-9a-fA-F]{8}$/.test(raw) ? parseInt(raw, 16) : undefined;
    case 'timestamp': {
      const num = toNumber(raw);
      if (num !== undefined) {
        return num > 0 ? (num < 10_000_000_000 ? num * 1000 : num) : undefined;
      }
      const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
      return Number.isNaN(parsed) ? undefined : parsed;
    }
  }
}

function compileField(key: string, spec: DanmakuFieldSpec): CompiledField {
  const paths = spec.path.split('|').map((s) => s.trim()).filter(Boolean).map(parsePath);
  if (paths.length === 0) {
    throw new Error(`字段 ${key} 未定义取值路径`);
  }
  return { key, paths, as: spec.as ?? 'string', mul: spec.mul, div: spec.div };
}

function decodeBase64(base64: string): Uint8Array {
  const bytes = new Uint8Array(protobuf.util.base64.length(base64));
  protobuf.util.base64.decode(base64, bytes, 0);
  return bytes;
}

export class DanmakuExtractor {
  private ruleSet: CompiledRuleSet = { version: 0, rules: [] };

  constructor(ruleSet?: DanmakuExtractionRuleSet) {
    if (ruleSet) {
      this.setRules(ruleSet);
    }
  }

  public getVersion(): number {
    return this.ruleSet.version;
  }

  /** 全部编译成功后整体替换；任何一处非法都会抛错并保留旧规则 */
  public setRules(ruleSet: DanmakuExtractionRuleSet): void {
    const protoTypes = new Map<string, protobuf.Type>();
    for (const schema of ruleSet.protobufs ?? []) {
      protoTypes.set(schema.name, protobuf.parse(schema.proto, { keepCase: true }).root.lookupType(schema.name));
    }
    this.ruleSet = {
      version: ruleSet.version,
      rules: ruleSet.rules.map((rule) => this.compileRule(rule, protoTypes)),
    };
  }

  private compileRule(rule: DanmakuExtractionRule, protoTypes: Map<string, protobuf.Type>): CompiledRule {
    const protoType = rule.proto ? protoTypes.get(rule.proto) : undefined;
    if (rule.proto && !protoType) {
      throw new Error(`规则 ${rule.pattern} 引用了未定义的 protobuf: ${rule.proto}`);
    }
    return {
      pattern: new RegExp(rule.pattern),
      discards: (rule.discardPatterns ?? []).map((p) => new RegExp(p)),
      target: rule.target,
      protoType,
      protoSource: parsePath(rule.protoSource ?? 'data.pb'),
      fields: Object.entries(rule.fields ?? {}).map(([key, spec]) => compileField(key, spec)),
      consts: rule.consts ?? {},
    };
  }

  public extract(
    message: any,
    roomId: number,
    streamerUid: number,
    eventTsMs: number,
    rawPayloadBytes?: Uint8Array,
  ): ExtractedUploadEvent | null {
    const cmd = String(message?.cmd ?? message?.msg?.cmd ?? '');
    const { version, rules } = this.ruleSet;
    const rule = cmd ? rules.find((r) => r.pattern.test(cmd) && !r.discards.some((d) => d.test(cmd))) : undefined;
    if (!rule) {
      return null;
    }

    const targets = this.resolveTargets(rule, message);
    if (!targets) {
      return null;
    }

    const payload: ExtractedPayload = { ...rule.consts, ...this.extractFields(rule.fields, targets) };
    if (rule.target === 'danmaku') {
      const fingerprint = computeDanmakuFingerprint(rawPayloadBytes ?? JSON.stringify(message));
      if (fingerprint > 0n) {
        payload.sourceFingerprint = fingerprint;
      }
    }

    return { streamerUid, eventTsMs, roomId, rulesVersion: version, [rule.target]: payload };
  }

  /** proto 规则只从解码结果取值；解码失败返回 null 丢弃事件，避免按 pb 路径读 JSON 产出空壳数据 */
  private resolveTargets(rule: CompiledRule, message: any): unknown[] | null {
    if (!rule.protoType) {
      return [message, message.data];
    }
    const raw = resolvePath(message, rule.protoSource);
    try {
      const bytes = raw instanceof Uint8Array ? raw : typeof raw === 'string' && raw ? decodeBase64(raw) : null;
      if (!bytes?.byteLength) {
        return null;
      }
      return [rule.protoType.toObject(rule.protoType.decode(bytes), protobufToObjectOptions)];
    } catch {
      return null;
    }
  }

  private extractFields(fields: CompiledField[], targets: unknown[]): Record<string, Scalar> {
    const values: Record<string, Scalar> = {};
    for (const field of fields) {
      const raw = resolveFirst(targets, field.paths);
      const value = isPresent(raw) ? coerce(raw, field.as) : undefined;
      if (value !== undefined) {
        values[field.key] = value;
      }
    }
    // mul 引用的是其他字段变换前的值，先快照再变换，结果与字段顺序无关
    const converted = { ...values };
    for (const field of fields) {
      let value = converted[field.key];
      if (typeof value !== 'number') {
        continue;
      }
      const multiplier = field.mul ? converted[field.mul] : undefined;
      if (typeof multiplier === 'number') {
        value *= multiplier;
      }
      if (field.div) {
        value /= field.div;
      }
      values[field.key] = value;
    }
    return values;
  }
}
