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
const OUTBOX_PAYLOAD_PREFIX = 'b64:';
const SQLITE_CORRUPTION_PATTERNS = [
  'database disk image is malformed',
  'file is not a database',
  'not a database',
  'sqlite_corrupt',
  'sqlite_notadb',
];

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS live_session_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_uid INTEGER NOT NULL,
    event_ts_ms INTEGER NOT NULL,
    payload TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_live_session_outbox_due
    ON live_session_outbox(next_retry_at_ms, id);
`;

export type SqliteLiveSessionOutboxValue = number | string | null;

export interface SqliteLiveSessionOutboxBackend {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqliteLiveSessionOutboxValue[]): Promise<number>;
  query(sql: string, params?: SqliteLiveSessionOutboxValue[]): Promise<unknown[][]>;
}

export interface ResettableSqliteLiveSessionOutboxBackend extends SqliteLiveSessionOutboxBackend {
  reset(reason: unknown): Promise<void>;
}

const resettableBackendTag = Symbol('resettableSqliteLiveSessionOutboxBackend');

type ResettableBackendFactory = () => Promise<ResettableSqliteLiveSessionOutboxBackend>;
type BackendFactory = () => Promise<SqliteLiveSessionOutboxBackend>;

type Base64Codec = {
  encode(bytes: Uint8Array): string;
  decode(value: string): Uint8Array;
};

let base64Codec: Base64Codec | null = null;

const createNodeBase64Codec = (): Base64Codec | null => {
  const bufferCtor = (globalThis as { Buffer?: {
    from(value: Uint8Array | string, encoding?: string): { toString(encoding: string): string };
  } }).Buffer;
  if (!bufferCtor) {
    return null;
  }

  return {
    encode: (bytes: Uint8Array): string => bufferCtor.from(bytes).toString('base64'),
    decode: (value: string): Uint8Array => Uint8Array.from(bufferCtor.from(value, 'base64') as unknown as Uint8Array),
  };
};

const createBrowserBase64Codec = (): Base64Codec | null => {
  if (typeof btoa !== 'function' || typeof atob !== 'function') {
    return null;
  }

  return {
    encode: (bytes: Uint8Array): string => {
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary);
    },
    decode: (value: string): Uint8Array => {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    },
  };
};

const getBase64Codec = (): Base64Codec => {
  if (!base64Codec) {
    base64Codec = createNodeBase64Codec() ?? createBrowserBase64Codec();
  }

  if (!base64Codec) {
    throw new Error('当前运行时缺少 base64 编解码能力');
  }

  return base64Codec;
};

const encodePayload = (payload: Uint8Array): string =>
  `${OUTBOX_PAYLOAD_PREFIX}${getBase64Codec().encode(payload)}`;

const decodePayload = (value: string): Uint8Array => {
  if (!value.startsWith(OUTBOX_PAYLOAD_PREFIX)) {
    throw new Error('outbox payload 编码格式无效');
  }
  return getBase64Codec().decode(value.slice(OUTBOX_PAYLOAD_PREFIX.length));
};

export const isSqliteCorruptionError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return SQLITE_CORRUPTION_PATTERNS.some(pattern => normalized.includes(pattern));
};

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
    return Object.assign(backend, { [resettableBackendTag]: backend });
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
  if (typeof value === 'string') {
    return decodePayload(value);
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
        await backend.exec(SCHEMA_SQL);
        return backend;
      })().catch((error: unknown) => {
        initializedPromise = null;
        if (!isSqliteCorruptionError(error)) {
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

  const resetCorruptedBackend = async (
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

  const withAutoRecovery = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteCorruptionError(error)) {
        throw error;
      }

      const backend = currentBackend;
      if (!backend) {
        resetBackendState();
        return await operation();
      }

      await resetCorruptedBackend(backend, error);
      return await operation();
    }
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
      await serializeOperation(operationChain, async () => await withAutoRecovery(async () => {
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
                encodePayload(item.payload),
                Math.floor(item.eventTsMs),
              ],
            );
          }
          return inserted;
        });
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

        const backend = await ensureInitialized();
        await pruneExpiredIfNeeded(backend, Date.now());

        return await runInTransaction(backend, async () => {
          let deleted = 0;
          for (const id of ids) {
            deleted += await backend.run(
              'DELETE FROM live_session_outbox WHERE id = $1',
              [Math.floor(id)],
            );
          }
          return deleted;
        });
      })),

    reschedule: async (updates: LiveSessionOutboxRescheduleUpdate[]): Promise<number> =>
      await serializeOperation(operationChain, async () => await withAutoRecovery(async () => {
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
                SET retry_count = $2,
                    next_retry_at_ms = $3
                WHERE id = $1
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
