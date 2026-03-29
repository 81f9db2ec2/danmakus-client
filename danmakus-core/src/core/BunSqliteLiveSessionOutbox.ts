import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LiveSessionOutboxStore } from './LocalArchiveTypes.js';
import {
  createSqliteLiveSessionOutbox,
  type SqliteLiveSessionOutboxBackend,
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

const createBunSqliteBackend = async (databasePath: string): Promise<SqliteLiveSessionOutboxBackend> => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const { Database } = await loadBunSqlite();
  const db = new Database(databasePath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

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
  };
};

export const createBunSqliteLiveSessionOutbox = (options?: {
  databasePath?: string;
}): LiveSessionOutboxStore => {
  const databasePath = resolve(options?.databasePath ?? DEFAULT_BUN_LIVE_SESSION_OUTBOX_PATH);
  return createSqliteLiveSessionOutbox(
    async () => await createBunSqliteBackend(databasePath),
  );
};
