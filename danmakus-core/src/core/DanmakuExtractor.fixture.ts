import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DanmakuExtractionRuleSet } from './DanmakuExtractionTypes.js';

// 直接读取服务端内嵌的规则源文件，保证单测覆盖的就是线上下发的规则
const rulesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../DanmakusBackendShared/Ingress/Extraction/Rules',
);

const readRuleFile = (name: string) => readFileSync(path.join(rulesDir, name), 'utf8');

const source = JSON.parse(readRuleFile('extraction-rules.json')) as Omit<DanmakuExtractionRuleSet, 'protobufs'> & {
  protobufs: Array<{ name: string; file: string }>;
};

export const SERVER_EXTRACTION_RULE_SET: DanmakuExtractionRuleSet = {
  ...source,
  protobufs: source.protobufs.map(({ name, file }) => ({ name, proto: readRuleFile(file) })),
};

export const INTERACT_WORD_V2_PROTO = readRuleFile('InteractWordV2.proto');
export const SEND_GIFT_V2_PROTO = readRuleFile('SendGiftMsg.proto');
