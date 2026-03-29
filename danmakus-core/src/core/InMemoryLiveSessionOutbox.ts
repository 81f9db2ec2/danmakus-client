import type {
  LiveSessionOutboxItem,
  LiveSessionOutboxRescheduleUpdate,
  LiveSessionOutboxStore,
  LiveSessionOutboxInsert,
} from './LocalArchiveTypes.js';

export const createInMemoryLiveSessionOutbox = (): LiveSessionOutboxStore => {
  let nextId = 1;
  const items: LiveSessionOutboxItem[] = [];

  return {
    async append(records: LiveSessionOutboxInsert[]): Promise<number> {
      for (const record of records) {
        items.push({
          id: nextId++,
          streamerUid: record.streamerUid,
          eventTsMs: record.eventTsMs,
          payload: record.payload,
          retryCount: 0,
          nextRetryAtMs: record.eventTsMs,
        });
      }
      return records.length;
    },

    async listDue({ nowMs, limit }: { nowMs: number; limit?: number }): Promise<LiveSessionOutboxItem[]> {
      const requestedLimit = limit ?? items.length;
      const normalizedLimit = Math.max(1, Math.floor(requestedLimit > 0 ? requestedLimit : 1));
      return items
        .filter(item => item.nextRetryAtMs <= nowMs)
        .sort((left, right) => left.nextRetryAtMs - right.nextRetryAtMs || left.id - right.id)
        .slice(0, normalizedLimit);
    },

    async ack(ids: number[]): Promise<number> {
      if (ids.length === 0) {
        return 0;
      }

      const idSet = new Set(ids.map(id => Math.floor(id)));
      const previousLength = items.length;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (idSet.has(items[index]!.id)) {
          items.splice(index, 1);
        }
      }
      return previousLength - items.length;
    },

    async reschedule(updates: LiveSessionOutboxRescheduleUpdate[]): Promise<number> {
      let updated = 0;
      for (const update of updates) {
        const item = items.find(candidate => candidate.id === Math.floor(update.id));
        if (!item) {
          continue;
        }
        item.retryCount = Math.floor(update.retryCount);
        item.nextRetryAtMs = Math.floor(update.nextRetryAtMs);
        updated += 1;
      }
      return updated;
    },

    async countPending(): Promise<number> {
      return items.length;
    },
  };
};
