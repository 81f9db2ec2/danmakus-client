import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DanmakuExtractor } from './DanmakuExtractor.js';
import { SERVER_EXTRACTION_RULE_SET } from './DanmakuExtractor.fixture.js';
import type { ExtractedPayload, ExtractedUploadEvent } from './DanmakuExtractionTypes.js';

// 与 Tests/Backend/DanmakusBackend.Tests/JsonataExtractionParityTests.cs 共享同一份语料
const corpusPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../Tests/Backend/DanmakusBackend.Tests/testdata/extraction-parity.json',
);

interface CorpusCase {
  name: string;
  raw: string;
  expected: Array<{ danmaku?: ExtractedPayload; runtimeDelta?: ExtractedPayload; lifecycleSignal?: ExtractedPayload }>;
}

interface Corpus {
  streamerUid: number;
  roomId: number;
  eventTsMs: number;
  cases: CorpusCase[];
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as Corpus;

const numberText = (value: number) => String(value);

function normalize(payload: Record<string, unknown>): string {
  const entries = Object.keys(payload)
    .sort()
    .map((key) => {
      const value = payload[key];
      switch (typeof value) {
        case 'string':
          return `${key}=${value}`;
        case 'number':
          return `${key}=${numberText(value)}`;
        case 'boolean':
          return `${key}=${value}`;
        default:
          throw new Error(`载荷字段 ${key} 的类型不受支持: ${typeof value}`);
      }
    });
  return entries.join(', ');
}

function renderEvent(event: ExtractedUploadEvent): string {
  const payload = event.danmaku ?? event.runtimeDelta ?? event.lifecycleSignal;
  if (!payload) {
    throw new Error('事件缺少载荷');
  }
  const kind = event.danmaku ? 'danmaku' : event.runtimeDelta ? 'runtimeDelta' : 'lifecycleSignal';
  const explicit = event.danmaku && event.runtimeDelta ? ' (互相排斥的载荷同时出现)' : '';
  return `${kind}${explicit}::${normalize(payload)}`;
}

function renderExpected(entry: CorpusCase['expected'][number]): string {
  const keys = ['danmaku', 'runtimeDelta', 'lifecycleSignal'] as const;
  const present = keys.filter((key) => entry[key] !== undefined);
  if (present.length !== 1) {
    throw new Error(`语料事件应恰好含一种载荷，实际: ${present.join(',') || '无'}`);
  }
  const kind = present[0];
  return `${kind}::${normalize(entry[kind] as Record<string, unknown>)}`;
}

describe('DanmakuExtractor 与服务端共享语料的一致性', () => {
  const extractor = new DanmakuExtractor(SERVER_EXTRACTION_RULE_SET);

  for (const testCase of corpus.cases) {
    it(testCase.name, async () => {
      const events = await extractor.extractAll(
        JSON.parse(testCase.raw),
        corpus.roomId,
        corpus.streamerUid,
        corpus.eventTsMs,
      );

      expect(events.map(renderEvent)).toEqual(testCase.expected.map(renderExpected));
    });
  }
});
