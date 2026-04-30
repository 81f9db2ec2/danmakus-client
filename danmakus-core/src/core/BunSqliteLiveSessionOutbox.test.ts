import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunSqliteLiveSessionOutbox } from './BunSqliteLiveSessionOutbox.js';
import {
  createResettableSqliteLiveSessionOutboxBackend,
  createSqliteLiveSessionOutbox,
  isSqliteLockedError,
  isSqliteResettableError,
  type ResettableSqliteLiveSessionOutboxBackend,
  type SqliteLiveSessionOutboxBackend,
} from './SqliteLiveSessionOutbox.js';

const TEST_STREAMER_UID = 84;

describe('BunSqliteLiveSessionOutbox', () => {
  it('persists pending records in a sqlite file', async () => {
    const nowMs = Date.now();
    const databasePath = join(
      tmpdir(),
      `danmakus-live-session-outbox-${randomUUID()}.sqlite3`,
    );
    const outbox = createBunSqliteLiveSessionOutbox({ databasePath });

    await outbox.append([
      {
        streamerUid: TEST_STREAMER_UID,
        eventTsMs: nowMs,
        payload: new Uint8Array([0, 1, 2, 3, 253, 254, 255]),
      },
    ]);

    const dueRecords = await outbox.listDue({ nowMs, limit: 10 });
    expect(dueRecords).toHaveLength(1);
    expect(dueRecords[0]?.payload).toEqual(new Uint8Array([0, 1, 2, 3, 253, 254, 255]));
    expect(await outbox.countPending()).toBe(1);

    const reopenedOutbox = createBunSqliteLiveSessionOutbox({ databasePath });
    expect(await reopenedOutbox.countPending()).toBe(1);

    await reopenedOutbox.ack([dueRecords[0]!.id]);
    expect(await reopenedOutbox.countPending()).toBe(0);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
  });

  it('rebuilds the database automatically when the sqlite file is corrupted', async () => {
    const nowMs = Date.now();
    const databasePath = join(
      tmpdir(),
      `danmakus-live-session-outbox-corrupted-${randomUUID()}.sqlite3`,
    );

    writeFileSync(databasePath, 'not a sqlite database');

    const outbox = createBunSqliteLiveSessionOutbox({ databasePath });

    await outbox.append([
      {
        streamerUid: TEST_STREAMER_UID,
        eventTsMs: nowMs,
        payload: new Uint8Array([9, 8, 7]),
      },
    ]);

    const dueRecords = await outbox.listDue({ nowMs, limit: 10 });
    expect(dueRecords).toHaveLength(1);
    expect(dueRecords[0]?.payload).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('reconnects once before rebuilding a locked sqlite database', async () => {
    let backendId = 0;
    let reconnectCount = 0;
    let resetCount = 0;

    const outbox = createSqliteLiveSessionOutbox(
      createResettableSqliteLiveSessionOutboxBackend(async (): Promise<ResettableSqliteLiveSessionOutboxBackend> => {
        backendId += 1;
        const currentBackendId = backendId;
        return {
          exec: async () => undefined,
          run: async () => 0,
          query: async (sql) => {
            if (currentBackendId === 1) {
              throw new Error('error returned from database: (code: 5) database is locked');
            }
            if (sql === 'PRAGMA user_version') {
              return [[4]];
            }
            return [[0]];
          },
          reconnect: async () => {
            reconnectCount += 1;
          },
          reset: async () => {
            resetCount += 1;
          },
        };
      }),
    );

    expect(await outbox.countPending()).toBe(0);
    expect(reconnectCount).toBe(1);
    expect(resetCount).toBe(1);
    expect(backendId).toBe(2);
  });

  it('does not rebuild the database when reconnect clears a sqlite lock', async () => {
    let locked = true;
    let reconnectCount = 0;
    let resetCount = 0;

    const outbox = createSqliteLiveSessionOutbox(
      createResettableSqliteLiveSessionOutboxBackend(async (): Promise<ResettableSqliteLiveSessionOutboxBackend> => ({
        exec: async () => undefined,
        run: async () => 0,
        query: async (sql) => {
          if (locked) {
            throw new Error('error returned from database: (code: 5) database is locked');
          }
          if (sql === 'PRAGMA user_version') {
            return [[4]];
          }
          return [[0]];
        },
        reconnect: async () => {
          reconnectCount += 1;
          locked = false;
        },
        reset: async () => {
          resetCount += 1;
        },
      })),
    );

    expect(await outbox.countPending()).toBe(0);
    expect(reconnectCount).toBe(1);
    expect(resetCount).toBe(0);
  });

  it('classifies sqlite locked errors as resettable', () => {
    const error = new Error('error returned from database: (code: 5) database is locked');

    expect(isSqliteLockedError(error)).toBe(true);
    expect(isSqliteResettableError(error)).toBe(true);
  });

  it('deletes the sqlite database when the schema version does not match', async () => {
    const nowMs = Date.now();
    const databasePath = join(
      tmpdir(),
      `danmakus-live-session-outbox-schema-${randomUUID()}.sqlite3`,
    );
    const db = new Database(databasePath, { create: true });
    db.exec(`
      CREATE TABLE live_session_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        streamer_uid INTEGER NOT NULL,
        event_ts_ms INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    db.query(`
      INSERT INTO live_session_outbox (streamer_uid, event_ts_ms, payload)
      VALUES (?, ?, ?)
    `).run(TEST_STREAMER_UID, nowMs, '[0,1,2]');
    db.close();

    const outbox = createBunSqliteLiveSessionOutbox({ databasePath });
    expect(await outbox.countPending()).toBe(0);

    await outbox.append([
      {
        streamerUid: TEST_STREAMER_UID,
        eventTsMs: nowMs,
        payload: new Uint8Array([4, 5, 6]),
      },
    ]);

    const dueRecords = await outbox.listDue({ nowMs, limit: 10 });
    expect(dueRecords).toHaveLength(1);
    expect(dueRecords[0]?.payload).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('accepts blob payload values returned by sqlite adapters', async () => {
    const nowMs = Date.now();
    const backend: SqliteLiveSessionOutboxBackend = {
      exec: async () => undefined,
      run: async () => 0,
      query: async (sql) => {
        if (sql === 'PRAGMA user_version') {
          return [[4]];
        }
        if (sql.includes('COUNT')) {
          return [[1]];
        }
        return [[
          7,
          TEST_STREAMER_UID,
          nowMs,
          [1, 2, 3],
          0,
          nowMs,
        ]];
      },
    };

    const outbox = createSqliteLiveSessionOutbox(async () => backend);
    const records = await outbox.listDue({ nowMs, limit: 10 });

    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('groups append, ack, and reschedule statements into batches', async () => {
    const nowMs = Date.now();
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    const backend: SqliteLiveSessionOutboxBackend = {
      exec: async () => undefined,
      run: async (sql, params = []) => {
        runs.push({ sql, params });
        if (sql.includes('INSERT INTO live_session_outbox')) {
          return params.length / 4;
        }
        if (sql.includes('DELETE FROM live_session_outbox WHERE id IN')) {
          return params.length;
        }
        if (sql.includes('UPDATE live_session_outbox')) {
          return params.length / 5;
        }
        return 0;
      },
      query: async (sql) => {
        if (sql === 'PRAGMA user_version') {
          return [[4]];
        }
        return [[0]];
      },
    };

    const outbox = createSqliteLiveSessionOutbox(async () => backend);
    await outbox.append([
      { streamerUid: TEST_STREAMER_UID, eventTsMs: nowMs, payload: new Uint8Array([1]) },
      { streamerUid: TEST_STREAMER_UID, eventTsMs: nowMs + 1, payload: new Uint8Array([2]) },
      { streamerUid: TEST_STREAMER_UID, eventTsMs: nowMs + 2, payload: new Uint8Array([3]) },
    ]);
    await outbox.ack([1, 2, 3]);
    await outbox.reschedule([
      { id: 4, retryCount: 1, nextRetryAtMs: nowMs + 1000 },
      { id: 5, retryCount: 2, nextRetryAtMs: nowMs + 2000 },
    ]);

    expect(runs.filter(item => item.sql.includes('INSERT INTO live_session_outbox'))).toHaveLength(1);
    expect(runs.filter(item => item.sql.includes('DELETE FROM live_session_outbox WHERE id IN'))).toHaveLength(1);
    expect(runs.filter(item => item.sql.includes('UPDATE live_session_outbox'))).toHaveLength(1);
  });
});
