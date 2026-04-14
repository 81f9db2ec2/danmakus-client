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

export interface ArchiveUploadRequest {
  batchId: string;
  clientId?: string | null;
  items: ClientDanmakuArchiveItem[];
}

export interface ArchiveUploadRejectedItem {
  localId: number;
  code: string;
  message: string;
}

export interface ArchiveUploadResponse {
  ackedLocalIds: number[];
  rejected: ArchiveUploadRejectedItem[];
}
