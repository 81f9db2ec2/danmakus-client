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
const SCHEMA_VERSION = 4;
const INSERT_BATCH_SIZE = 200;
const DELETE_BATCH_SIZE = 900;
const RESCHEDULE_BATCH_SIZE = 180;
const SQLITE_CORRUPTION_PATTERNS = [
  'database disk image is malformed',
  'file is not a database',
  'not a database',
  'sqlite_corrupt',
  'sqlite_notadb',
];
const SQLITE_LOCKED_PATTERNS = [
  'database is locked',
  'database table is locked',
  'sqlite_busy',
  'sqlite_locked',
  'code: 5',
];

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

export interface ResettableSqliteLiveSessionOutboxBackend extends SqliteLiveSessionOutboxBackend {
  reconnect?(reason: unknown): Promise<void>;
  reset(reason: unknown): Promise<void>;
}

const resettableBackendTag = Symbol('resettableSqliteLiveSessionOutboxBackend');

type ResettableBackendFactory = () => Promise<ResettableSqliteLiveSessionOutboxBackend>;
type BackendFactory = () => Promise<SqliteLiveSessionOutboxBackend>;

export const isSqliteCorruptionError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return SQLITE_CORRUPTION_PATTERNS.some(pattern => normalized.includes(pattern));
};

export const isSqliteLockedError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return SQLITE_LOCKED_PATTERNS.some(pattern => normalized.includes(pattern));
};

export const isSqliteResettableError = (error: unknown): boolean =>
  isSqliteCorruptionError(error) || isSqliteLockedError(error);

export const createResettableSqliteLiveSessionOutboxBackend = (
  getBackend: ResettableBackendFactory,
): BackendFactory => {
  let backendPromise: Promise<ResettableSqliteLiveSessionOutboxBackend> | null = null;

  const ensureBackend = async (): Promise<ResettableSqliteLiveSessionOutboxBackend> => {
    if (!backendPromise) {
      backendPromise = getBackend().catch((error: unknown) => {
        backendPromise = null;
        throw error;
      });
    }

    return await backendPromise;
  };

  return async (): Promise<SqliteLiveSessionOutboxBackend> => {
    const backend = await ensureBackend();
    const taggedBackend = backend as ResettableSqliteLiveSessionOutboxBackend & {
      [resettableBackendTag]?: ResettableSqliteLiveSessionOutboxBackend;
    };

    if (!taggedBackend[resettableBackendTag]) {
      const resetBackend = taggedBackend.reset.bind(taggedBackend);
      taggedBackend.reset = async (reason: unknown): Promise<void> => {
        try {
          await resetBackend(reason);
        } finally {
          backendPromise = null;
        }
      };
      taggedBackend[resettableBackendTag] = taggedBackend;
    }

    return taggedBackend;
  };
};

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

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const placeholders = (count: number): string =>
  Array.from({ length: count }, () => '?').join(', ');

const normalizeIds = (ids: number[]): number[] =>
  Array.from(new Set(ids.map(id => Math.floor(id))));

const normalizeRescheduleUpdates = (
  updates: LiveSessionOutboxRescheduleUpdate[],
): LiveSessionOutboxRescheduleUpdate[] => {
  const normalized = new Map<number, LiveSessionOutboxRescheduleUpdate>();
  for (const update of updates) {
    const id = Math.floor(update.id);
    normalized.set(id, {
      id,
      retryCount: Math.floor(update.retryCount),
      nextRetryAtMs: Math.floor(update.nextRetryAtMs),
    });
  }
  return Array.from(normalized.values());
};

const readSchemaVersion = async (backend: SqliteLiveSessionOutboxBackend): Promise<number> => {
  const rows = await backend.query('PRAGMA user_version');
  return Math.max(0, toSafeInteger(rows[0]?.[0] ?? 0, 'user_version'));
};

const initializeSchema = async (backend: SqliteLiveSessionOutboxBackend): Promise<void> => {
  await backend.exec(SCHEMA_SQL);
  await backend.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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

const getResettableBackend = (
  backend: SqliteLiveSessionOutboxBackend,
): ResettableSqliteLiveSessionOutboxBackend | null => {
  const tagged = (backend as SqliteLiveSessionOutboxBackend & {
    [resettableBackendTag]?: ResettableSqliteLiveSessionOutboxBackend;
  })[resettableBackendTag];

  return tagged ?? null;
};

export const createSqliteLiveSessionOutbox = (
  getBackend: () => Promise<SqliteLiveSessionOutboxBackend>,
): LiveSessionOutboxStore => {
  let backendPromise: Promise<SqliteLiveSessionOutboxBackend> | null = null;
  let initializedPromise: Promise<SqliteLiveSessionOutboxBackend> | null = null;
  let currentBackend: SqliteLiveSessionOutboxBackend | null = null;
  let lastPruneAtMs = 0;
  const operationChain = { current: Promise.resolve() };

  const ensureBackend = async (): Promise<SqliteLiveSessionOutboxBackend> => {
    if (!backendPromise) {
      backendPromise = getBackend()
        .then((backend) => {
          currentBackend = backend;
          return backend;
        })
        .catch((error: unknown) => {
          backendPromise = null;
          currentBackend = null;
          throw error;
        });
    }
    return await backendPromise;
  };

  const ensureInitialized = async (): Promise<SqliteLiveSessionOutboxBackend> => {
    if (!initializedPromise) {
      initializedPromise = (async () => {
        const backend = await ensureBackend();
        if (await readSchemaVersion(backend) !== SCHEMA_VERSION) {
          return await resetDatabase(
            backend,
            new Error(`live session outbox schema version mismatch: expected=${SCHEMA_VERSION}`),
          );
        }
        await initializeSchema(backend);
        return backend;
      })().catch((error: unknown) => {
        initializedPromise = null;
        if (!isSqliteResettableError(error)) {
          backendPromise = null;
          currentBackend = null;
        }
        throw error;
      });
    }
    return await initializedPromise;
  };

  const resetBackendState = (): void => {
    initializedPromise = null;
    backendPromise = null;
    currentBackend = null;
    lastPruneAtMs = 0;
  };

  const resetDatabase = async (
    backend: SqliteLiveSessionOutboxBackend,
    reason: unknown,
  ): Promise<SqliteLiveSessionOutboxBackend> => {
    const resettableBackend = getResettableBackend(backend);
    resetBackendState();
    if (!resettableBackend) {
      throw reason;
    }

    await resettableBackend.reset(reason);
    const freshBackend = await ensureBackend();
    await initializeSchema(freshBackend);
    return freshBackend;
  };

  const resetFailedBackend = async (
    backend: SqliteLiveSessionOutboxBackend,
    reason: unknown,
  ): Promise<void> => {
    const resettableBackend = getResettableBackend(backend);
    resetBackendState();
    if (!resettableBackend) {
      throw reason;
    }
    await resettableBackend.reset(reason);
  };

  const reconnectFailedBackend = async (
    backend: SqliteLiveSessionOutboxBackend,
    reason: unknown,
  ): Promise<void> => {
    const resettableBackend = getResettableBackend(backend);
    resetBackendState();
    if (!resettableBackend?.reconnect) {
      return;
    }
    await resettableBackend.reconnect(reason);
  };

  const withAutoRecovery = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    let reconnectedAfterLocked = false;
    let rebuilt = false;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const backend = currentBackend;
        if (isSqliteLockedError(error) && !reconnectedAfterLocked) {
          reconnectedAfterLocked = true;
          if (backend) {
            await reconnectFailedBackend(backend, error);
          } else {
            resetBackendState();
          }
          continue;
        }

        if (!isSqliteResettableError(error) || rebuilt) {
          throw error;
        }

        rebuilt = true;
        if (!backend) {
          resetBackendState();
          continue;
        }

        await resetFailedBackend(backend, error);
      }
    }
  };

  const pruneExpiredIfNeeded = async (
    backend: SqliteLiveSessionOutboxBackend,
    nowMs: number,
  ): Promise<void> => {
    if (nowMs - lastPruneAtMs < OUTBOX_PRUNE_INTERVAL_MS) {
      return;
    }

    await backend.run(
      'DELETE FROM live_session_outbox WHERE event_ts_ms < ?',
      [Math.floor(nowMs - OUTBOX_RETENTION_MS)],
    );
    lastPruneAtMs = nowMs;
  };

  return {
    append: async (items: LiveSessionOutboxInsert[]): Promise<number> =>
      await serializeOperation(operationChain, async () => await withAutoRecovery(async () => {
        if (items.length === 0) {
          return 0;
        }

        const backend = await ensureInitialized();
        const nowMs = Date.now();
        await pruneExpiredIfNeeded(backend, nowMs);

        let inserted = 0;
        for (const batch of chunkArray(items, INSERT_BATCH_SIZE)) {
          const params: SqliteLiveSessionOutboxValue[] = [];
          for (const item of batch) {
            params.push(
              Math.floor(item.streamerUid),
              Math.floor(item.eventTsMs),
              item.payload,
              Math.floor(item.eventTsMs),
            );
          }

          inserted += await backend.run(
            `
              INSERT INTO live_session_outbox (
                streamer_uid,
                event_ts_ms,
                payload,
                retry_count,
                next_retry_at_ms
              ) VALUES ${Array.from({ length: batch.length }, () => '(?, ?, ?, 0, ?)').join(', ')}
            `,
            params,
          );
        }
        return inserted;
      })),

    listDue: async ({ nowMs, limit }: { nowMs: number; limit?: number }): Promise<LiveSessionOutboxItem[]> =>
      await serializeOperation(operationChain, async () => await withAutoRecovery(async () => {
        const backend = await ensureInitialized();
        await pruneExpiredIfNeeded(backend, nowMs);

        const normalizedLimit = Math.min(
          LIST_DUE_LIMIT_MAX,
          Math.max(1, Math.floor(limit ?? LIST_DUE_LIMIT_DEFAULT)),
        );
        const rows = await backend.query(
          `
            SELECT
              id AS a_id,
              streamer_uid AS b_streamer_uid,
              event_ts_ms AS c_event_ts_ms,
              payload AS d_payload,
              retry_count AS e_retry_count,
              next_retry_at_ms AS f_next_retry_at_ms
            FROM live_session_outbox
            WHERE next_retry_at_ms <= $1
            ORDER BY next_retry_at_ms ASC, id ASC
            LIMIT $2
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
      })),

    ack: async (ids: number[]): Promise<number> =>
      await serializeOperation(operationChain, async () => await withAutoRecovery(async () => {
        if (ids.length === 0) {
          return 0;
        }

        const normalizedIds = normalizeIds(ids);
        const backend = await ensureInitialized();
        await pruneExpiredIfNeeded(backend, Date.now());

        let deleted = 0;
        for (const batch of chunkArray(normalizedIds, DELETE_BATCH_SIZE)) {
          deleted += await backend.run(
            `DELETE FROM live_session_outbox WHERE id IN (${placeholders(batch.length)})`,
            batch,
          );
        }
        return deleted;
      })),

    reschedule: async (updates: LiveSessionOutboxRescheduleUpdate[]): Promise<number> =>
      await serializeOperation(operationChain, async () => await withAutoRecovery(async () => {
        if (updates.length === 0) {
          return 0;
        }

        const normalizedUpdates = normalizeRescheduleUpdates(updates);
        const backend = await ensureInitialized();
        await pruneExpiredIfNeeded(backend, Date.now());

        let updated = 0;
        for (const batch of chunkArray(normalizedUpdates, RESCHEDULE_BATCH_SIZE)) {
          const retryCountCases = batch.map(() => 'WHEN ? THEN ?').join(' ');
          const nextRetryAtCases = batch.map(() => 'WHEN ? THEN ?').join(' ');
          const ids = batch.map(update => update.id);
          const params: SqliteLiveSessionOutboxValue[] = [];
          for (const update of batch) {
            params.push(update.id, update.retryCount);
          }
          for (const update of batch) {
            params.push(update.id, update.nextRetryAtMs);
          }
          params.push(...ids);

          updated += await backend.run(
            `
              UPDATE live_session_outbox
              SET retry_count = CASE id ${retryCountCases} ELSE retry_count END,
                  next_retry_at_ms = CASE id ${nextRetryAtCases} ELSE next_retry_at_ms END
              WHERE id IN (${placeholders(batch.length)})
            `,
            params,
          );
        }
        return updated;
      })),

    countPending: async (): Promise<number> =>
      await serializeOperation(operationChain, async () => await withAutoRecovery(async () => {
        const backend = await ensureInitialized();
        await pruneExpiredIfNeeded(backend, Date.now());

        const rows = await backend.query('SELECT COUNT(*) AS a_count FROM live_session_outbox');
        return Math.max(0, toSafeInteger(rows[0]?.[0] ?? 0, 'count'));
      })),
  };
};
