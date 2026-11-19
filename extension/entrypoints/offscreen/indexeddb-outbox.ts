import { createInMemoryLiveSessionOutbox } from 'danmakus-core';

type LiveSessionOutboxStore = ReturnType<typeof createInMemoryLiveSessionOutbox>;

const DB_NAME = 'danmakus_ext_outbox_v1';
const STORE_NAME = 'outbox';
const NEXT_RETRY_INDEX = 'by_next_retry';

function openOutboxDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex(NEXT_RETRY_INDEX, 'nextRetryAtMs');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打开 IndexedDB 失败'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 创建持久化 Outbox；IndexedDB 不可用时自动退回内存实现 */
export async function createPersistentLiveSessionOutbox(): Promise<LiveSessionOutboxStore> {
  if (typeof indexedDB === 'undefined') {
    return createInMemoryLiveSessionOutbox();
  }

  let db: IDBDatabase;
  try {
    db = await openOutboxDb();
  } catch {
    return createInMemoryLiveSessionOutbox();
  }

  return {
    async append(items) {
      if (items.length === 0) return 0;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const item of items) {
        store.add({
          streamerUid: item.streamerUid,
          eventTsMs: item.eventTsMs,
          payload: item.payload,
          retryCount: 0,
          nextRetryAtMs: item.eventTsMs,
        });
      }
      await txDone(tx);
      return items.length;
    },

    async listDue({ nowMs, limit }) {
      const maxItems = Math.max(1, Math.floor(limit && limit > 0 ? limit : 100));
      const tx = db.transaction(STORE_NAME, 'readonly');
      const index = tx.objectStore(STORE_NAME).index(NEXT_RETRY_INDEX);
      const range = IDBKeyRange.upperBound(nowMs);
      const results: Awaited<ReturnType<LiveSessionOutboxStore['listDue']>> = [];

      await new Promise<void>((resolve, reject) => {
        const cursorReq = index.openCursor(range);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || results.length >= maxItems) {
            resolve();
            return;
          }
          results.push(cursor.value);
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('读取待传队列失败'));
      });
      return results;
    },

    async ack(ids) {
      if (ids.length === 0) return 0;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const id of ids) {
        store.delete(Math.floor(id));
      }
      await txDone(tx);
      return ids.length;
    },

    async reschedule(updates) {
      if (updates.length === 0) return 0;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let updated = 0;
      for (const update of updates) {
        const id = Math.floor(update.id);
        const existing = await reqResult(store.get(id));
        if (!existing) continue;
        existing.retryCount = Math.floor(update.retryCount);
        existing.nextRetryAtMs = Math.floor(update.nextRetryAtMs);
        store.put(existing);
        updated += 1;
      }
      await txDone(tx);
      return updated;
    },

    async countPending() {
      const tx = db.transaction(STORE_NAME, 'readonly');
      return reqResult(tx.objectStore(STORE_NAME).count());
    },
  };
}
