import type {
  LiveSessionOutboxInsert,
  LiveSessionOutboxItem,
  LiveSessionOutboxRescheduleUpdate,
  LiveSessionOutboxStore,
} from './LocalArchiveTypes.js';

const LIST_DUE_LIMIT_DEFAULT = 200;
const LIST_DUE_LIMIT_MAX = 2000;
const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OUTBOX_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS live_session_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_uid INTEGER NOT NULL,
    event_ts_ms INTEGER NOT NULL,
    payload BLOB NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_live_session_outbox_due
    ON live_session_outbox(next_retry_at_ms, id);
`;

export type SqliteLiveSessionOutboxValue = number | string | Uint8Array | null;

export interface SqliteLiveSessionOutboxBackend {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqliteLiveSessionOutboxValue[]): Promise<number>;
  query(sql: string, params?: SqliteLiveSessionOutboxValue[]): Promise<unknown[][]>;
}

const toSafeInteger = (value: unknown, fieldName: string): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`outbox 字段 ${fieldName} 不是有效数字`);
  }
  return Math.floor(numeric);
};

const normalizeBlob = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  throw new Error(`无法识别的 outbox payload 类型: ${Object.prototype.toString.call(value)}`);
};

const serializeOperation = <T>(
  chainRef: { current: Promise<void> },
  operation: () => Promise<T>,
): Promise<T> => {
  const nextOperation = chainRef.current.then(operation, operation);
  chainRef.current = nextOperation.then(
    () => undefined,
    () => undefined,
  );
  return nextOperation;
};

const runInTransaction = async <T>(
  backend: SqliteLiveSessionOutboxBackend,
  action: () => Promise<T>,
): Promise<T> => {
  await backend.exec('BEGIN');
  try {
    const result = await action();
    await backend.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      await backend.exec('ROLLBACK');
    } catch {
      // ignore rollback errors and surface the original failure
    }
    throw error;
  }
};

export const createSqliteLiveSessionOutbox = (
  getBackend: () => Promise<SqliteLiveSessionOutboxBackend>,
): LiveSessionOutboxStore => {
  let backendPromise: Promise<SqliteLiveSessionOutboxBackend> | null = null;
  let initializedPromise: Promise<SqliteLiveSessionOutboxBackend> | null = null;
  let lastPruneAtMs = 0;
  const operationChain = { current: Promise.resolve() };

  const ensureBackend = async (): Promise<SqliteLiveSessionOutboxBackend> => {
    if (!backendPromise) {
      backendPromise = getBackend().catch((error: unknown) => {
        backendPromise = null;
        throw error;
      });
    }
    return await backendPromise;
  };

  const ensureInitialized = async (): Promise<SqliteLiveSessionOutboxBackend> => {
    if (!initializedPromise) {
      initializedPromise = (async () => {
        const backend = await ensureBackend();
        await backend.exec(SCHEMA_SQL);
        return backend;
      })().catch((error: unknown) => {
        initializedPromise = null;
        backendPromise = null;
        throw error;
      });
    }
    return await initializedPromise;
  };

  const pruneExpiredIfNeeded = async (
    backend: SqliteLiveSessionOutboxBackend,
    nowMs: number,
  ): Promise<void> => {
    if (nowMs - lastPruneAtMs < OUTBOX_PRUNE_INTERVAL_MS) {
      return;
    }

    lastPruneAtMs = nowMs;
    await backend.run(
      'DELETE FROM live_session_outbox WHERE event_ts_ms < ?',
      [Math.floor(nowMs - OUTBOX_RETENTION_MS)],
    );
  };

  return {
    append: async (items: LiveSessionOutboxInsert[]): Promise<number> =>
      await serializeOperation(operationChain, async () => {
        if (items.length === 0) {
          return 0;
        }

        const backend = await ensureInitialized();
        const nowMs = Date.now();
        await pruneExpiredIfNeeded(backend, nowMs);

        return await runInTransaction(backend, async () => {
          let inserted = 0;
          for (const item of items) {
            inserted += await backend.run(
              `
                INSERT INTO live_session_outbox (
                  streamer_uid,
                  event_ts_ms,
                  payload,
                  retry_count,
                  next_retry_at_ms
                ) VALUES (?, ?, ?, 0, ?)
              `,
              [
                Math.floor(item.streamerUid),
                Math.floor(item.eventTsMs),
                item.payload,
                Math.floor(item.eventTsMs),
              ],
            );
          }
          return inserted;
        });
      }),

    listDue: async ({ nowMs, limit }: { nowMs: number; limit?: number }): Promise<LiveSessionOutboxItem[]> =>
      await serializeOperation(operationChain, async () => {
        const backend = await ensureInitialized();
        await pruneExpiredIfNeeded(backend, nowMs);

        const normalizedLimit = Math.min(
          LIST_DUE_LIMIT_MAX,
          Math.max(1, Math.floor(limit ?? LIST_DUE_LIMIT_DEFAULT)),
        );
        const rows = await backend.query(
          `
            SELECT
              id,
              streamer_uid,
              event_ts_ms,
              payload,
              retry_count,
              next_retry_at_ms
            FROM live_session_outbox
            WHERE next_retry_at_ms <= ?
            ORDER BY next_retry_at_ms ASC, id ASC
            LIMIT ?
          `,
          [Math.floor(nowMs), normalizedLimit],
        );

        return rows.map(row => ({
          id: toSafeInteger(row[0], 'id'),
          streamerUid: toSafeInteger(row[1], 'streamer_uid'),
          eventTsMs: toSafeInteger(row[2], 'event_ts_ms'),
          payload: normalizeBlob(row[3]),
          retryCount: toSafeInteger(row[4], 'retry_count'),
          nextRetryAtMs: toSafeInteger(row[5], 'next_retry_at_ms'),
        }));
      }),

    ack: async (ids: number[]): Promise<number> =>
      await serializeOperation(operationChain, async () => {
        if (ids.length === 0) {
          return 0;
        }

        const backend = await ensureInitialized();
        await pruneExpiredIfNeeded(backend, Date.now());

        return await runInTransaction(backend, async () => {
          let deleted = 0;
          for (const id of ids) {
            deleted += await backend.run(
              'DELETE FROM live_session_outbox WHERE id = ?',
              [Math.floor(id)],
            );
          }
          return deleted;
        });
      }),

    reschedule: async (updates: LiveSessionOutboxRescheduleUpdate[]): Promise<number> =>
      await serializeOperation(operationChain, async () => {
        if (updates.length === 0) {
          return 0;
        }

        const backend = await ensureInitialized();
        await pruneExpiredIfNeeded(backend, Date.now());

        return await runInTransaction(backend, async () => {
          let updated = 0;
          for (const update of updates) {
            updated += await backend.run(
              `
                UPDATE live_session_outbox
                SET retry_count = ?2,
                    next_retry_at_ms = ?3
                WHERE id = ?1
              `,
              [
                Math.floor(update.id),
                Math.floor(update.retryCount),
                Math.floor(update.nextRetryAtMs),
              ],
            );
          }
          return updated;
        });
      }),

    countPending: async (): Promise<number> =>
      await serializeOperation(operationChain, async () => {
        const backend = await ensureInitialized();
        await pruneExpiredIfNeeded(backend, Date.now());

        const rows = await backend.query('SELECT COUNT(*) FROM live_session_outbox');
        return Math.max(0, toSafeInteger(rows[0]?.[0] ?? 0, 'count'));
      }),
  };
};
