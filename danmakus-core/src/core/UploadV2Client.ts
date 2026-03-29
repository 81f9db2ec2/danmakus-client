import type {
  ClientDanmakuArchiveItem,
  LiveSessionOutboxItem,
  UploadDanmakusV2Request,
} from '../types/index.js';
import { normalizeBinaryPayload } from './RawPacketCodec.js';

const toArchiveItem = (record: LiveSessionOutboxItem): ClientDanmakuArchiveItem => ({
  localId: record.id,
  streamerUid: record.streamerUid,
  eventTsMs: record.eventTsMs,
  payload: normalizeBinaryPayload(record.payload),
});

export const buildUploadDanmakusV2Request = (
  batchId: string,
  items: LiveSessionOutboxItem[],
  clientId?: string | null,
): UploadDanmakusV2Request => ({
  batchId,
  clientId,
  items: items.map(toArchiveItem),
});
