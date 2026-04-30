import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LiveSessionOutboxStore } from './LocalArchiveTypes.js';
import {
  createResettableSqliteLiveSessionOutboxBackend,
  createSqliteLiveSessionOutbox,
  isSqliteCorruptionError,
  type ResettableSqliteLiveSessionOutboxBackend,
  type SqliteLiveSessionOutboxValue,
} from './SqliteLiveSessionOutbox.js';

export const DEFAULT_BUN_LIVE_SESSION_OUTBOX_PATH = resolve(
  process.cwd(),
  '.danmakus',
  'danmakus-live-session-outbox-streamer.sqlite3',
);

type BunSqliteDatabase = {
  exec(sql: string): void;
  run(sql: string, ...params: SqliteLiveSessionOutboxValue[][]): {
    changes: number;
    lastInsertRowid: number | bigint;
  };
  query(sql: string): {
    values(params?: SqliteLiveSessionOutboxValue[]): unknown[][];
  };
  close(force?: boolean): void;
};

let sqliteModulePromise: Promise<any> | null = null;

const loadBunSqlite = async (): Promise<{
  Database: new (filename: string, options?: { create?: boolean }) => BunSqliteDatabase;
}> => {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('bun:sqlite').catch((error: unknown) => {
      sqliteModulePromise = null;
      throw error;
    });
  }

  return await sqliteModulePromise as {
    Database: new (filename: string, options?: { create?: boolean }) => BunSqliteDatabase;
  };
};

const deleteSqliteDatabaseFiles = (databasePath: string): void => {
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-journal`, { force: true });
};

const hasValidSqliteHeader = (databasePath: string): boolean => {
  try {
    const header = readFileSync(databasePath, { encoding: 'utf8', flag: 'r' }).slice(0, 16);
    return header === 'SQLite format 3\u0000';
  } catch {
    return true;
  }
};

const createBunSqliteBackend = async (databasePath: string): Promise<ResettableSqliteLiveSessionOutboxBackend> => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const { Database } = await loadBunSqlite();
  if (!hasValidSqliteHeader(databasePath)) {
    deleteSqliteDatabaseFiles(databasePath);
  }
  const openDatabase = (): BunSqliteDatabase => {
    const db = new Database(databasePath, { create: true });
    db.exec('SELECT 1;');
    db.exec('PRAGMA journal_mode = DELETE;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 30000;');
    return db;
  };

  let db: BunSqliteDatabase;
  try {
    db = openDatabase();
  } catch (error) {
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }
    deleteSqliteDatabaseFiles(databasePath);
    db = openDatabase();
  }

  return {
    exec: async (sql: string): Promise<void> => {
      db.exec(sql);
    },

    run: async (
      sql: string,
      params?: SqliteLiveSessionOutboxValue[],
    ): Promise<number> => db.run(sql, params ?? []).changes,

    query: async (
      sql: string,
      params?: SqliteLiveSessionOutboxValue[],
    ): Promise<unknown[][]> => db.query(sql).values(params),

    reconnect: async (): Promise<void> => {
      db.close(true);
      db = openDatabase();
    },

    reset: async (): Promise<void> => {
      db.close(true);
      deleteSqliteDatabaseFiles(databasePath);
    },
  };
};

export const createBunSqliteLiveSessionOutbox = (options?: {
  databasePath?: string;
}): LiveSessionOutboxStore => {
  const databasePath = resolve(options?.databasePath ?? DEFAULT_BUN_LIVE_SESSION_OUTBOX_PATH);
  return createSqliteLiveSessionOutbox(
    createResettableSqliteLiveSessionOutboxBackend(
      async () => await createBunSqliteBackend(databasePath),
    ),
  );
};
