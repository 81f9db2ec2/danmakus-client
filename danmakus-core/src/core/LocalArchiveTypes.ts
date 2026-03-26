export interface LiveSessionOutboxInsert {
  streamerUid: number;
  eventTsMs: number;
  payload: Uint8Array;
}

export interface LiveSessionOutboxItem extends LiveSessionOutboxInsert {
  id: number;
  retryCount: number;
  nextRetryAtMs: number;
}

export interface LiveSessionOutboxRescheduleUpdate {
  id: number;
  retryCount: number;
  nextRetryAtMs: number;
}

export interface LiveSessionOutboxStore {
  append(items: LiveSessionOutboxInsert[]): Promise<number>;
  listDue(options: { nowMs: number; limit?: number }): Promise<LiveSessionOutboxItem[]>;
  ack(ids: number[]): Promise<number>;
  reschedule(updates: LiveSessionOutboxRescheduleUpdate[]): Promise<number>;
  countPending(): Promise<number>;
}

export interface ClientDanmakuArchiveItem {
  localId: number;
  streamerUid: number;
  eventTsMs: number;
  payload: Uint8Array;
}

export interface UploadDanmakusV2Request {
  batchId: string;
  clientId?: string | null;
  items: ClientDanmakuArchiveItem[];
}

export interface UploadDanmakusV2RejectedItem {
  localId: number;
  code: string;
  message: string;
}

export interface UploadDanmakusV2Response {
  ackedLocalIds: number[];
  rejected: UploadDanmakusV2RejectedItem[];
}
