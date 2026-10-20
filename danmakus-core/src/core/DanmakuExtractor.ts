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
  exact: Map<string, CompiledRule>;
  regex: CompiledRule[];
}

function exactCmdFromPattern(pattern: string): string | null {
  if (pattern.length < 3 || pattern[0] !== '^' || pattern[pattern.length - 1] !== '$') {
    return null;
  }
  const inner = pattern.slice(1, -1);
  return /^[A-Za-z0-9_]+$/.test(inner) ? inner : null;
}

function ruleMatchesCmd(rule: CompiledRule, cmd: string): boolean {
  return rule.pattern.test(cmd) && !rule.discards.some((d) => d.test(cmd));
}

function matchRule(cmd: string, exact: Map<string, CompiledRule>, regex: CompiledRule[]): CompiledRule | undefined {
  if (!cmd) {
    return undefined;
  }
  const exactRule = exact.get(cmd);
  if (exactRule && !exactRule.discards.some((d) => d.test(cmd))) {
    return exactRule;
  }
  return regex.find((rule) => ruleMatchesCmd(rule, cmd));
}

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
  if (value === undefined || value === null || value === '') {
    return false;
  }
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    const num = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(num) && num !== 0;
  }
  return true;
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
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (typeof raw === 'string') {
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
  }
  if (raw && typeof raw === 'object' && typeof (raw as { toNumber?: unknown }).toNumber === 'function') {
    const num = (raw as { toNumber: () => number }).toNumber();
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
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
        return num > 0
          ? num < 10_000_000_000
            ? num * 1000
            : num > 10_000_000_000_000_000
              ? Math.floor(num / 1_000_000)
              : num
          : undefined;
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
  private ruleSet: CompiledRuleSet = { version: 0, exact: new Map(), regex: [] };

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
    const exact = new Map<string, CompiledRule>();
    const regex: CompiledRule[] = [];
    for (const rule of ruleSet.rules) {
      const compiled = this.compileRule(rule, protoTypes);
      const cmd = exactCmdFromPattern(rule.pattern);
      if (cmd) {
        exact.set(cmd, compiled);
      } else {
        regex.push(compiled);
      }
    }
    this.ruleSet = { version: ruleSet.version, exact, regex };
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
  ): ExtractedUploadEvent | null {
    const cmd = String(message?.cmd ?? message?.msg?.cmd ?? '');
    const { version, exact, regex } = this.ruleSet;
    const rule = matchRule(cmd, exact, regex);
    if (!rule) {
      return null;
    }

    const targets = this.resolveTargets(rule, message);
    if (!targets) {
      return null;
    }

    const payload: ExtractedPayload = { ...rule.consts, ...this.extractFields(rule.fields, targets) };

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
      return [rule.protoType.decode(bytes)];
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
