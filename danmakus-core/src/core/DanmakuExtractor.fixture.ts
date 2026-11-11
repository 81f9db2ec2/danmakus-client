import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonataExtractionRuleSetV2 } from './DanmakuExtractionTypes.js';

// 直接读取服务端内嵌的规则源文件，保证单测覆盖的就是线上下发的规则
const rulesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../DanmakusBackendShared/Ingress/Extraction/Rules',
);
const rulesDir = path.join(rulesRoot, 'v2');

const readV2 = (name: string) => readFileSync(path.join(rulesDir, name), 'utf8');
const readProto = (name: string) => readFileSync(path.join(rulesRoot, name), 'utf8');

interface ManifestSource {
  version: number;
  protobufs: Array<{ name: string; file: string }>;
  prelude?: string;
  rules: Array<{ pattern: string; discardPatterns?: string[]; expr: string }>;
}

const manifest = JSON.parse(readV2('manifest.json')) as ManifestSource;

export const SERVER_EXTRACTION_RULE_SET: JsonataExtractionRuleSetV2 = {
  version: manifest.version,
  protobufs: manifest.protobufs.map(({ name, file }) => ({ name, proto: readProto(file) })),
  prelude: manifest.prelude ? readV2(manifest.prelude) : undefined,
  rules: manifest.rules.map(({ pattern, discardPatterns, expr }) => ({
    pattern,
    discardPatterns,
    expr: readV2(expr),
  })),
};

export const INTERACT_WORD_V2_PROTO = readProto('InteractWordV2.proto');
export const SEND_GIFT_V2_PROTO = readProto('SendGiftMsg.proto');
