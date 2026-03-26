import type {
  LiveSessionOutboxStore,
  SqliteLiveSessionOutboxBackend,
  SqliteLiveSessionOutboxValue,
} from 'danmakus-core'
import {
  createSqliteLiveSessionOutbox,
} from 'danmakus-core'
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs'
import waSqliteAsyncWasmUrl from 'wa-sqlite/dist/wa-sqlite-async.wasm?url'
import * as SQLite from 'wa-sqlite'
import { IDBBatchAtomicVFS } from 'wa-sqlite/src/examples/IDBBatchAtomicVFS.js'

const VFS_NAME = 'danmakus-live-session-outbox-vfs'
const DATABASE_FILE_NAME = 'danmakus-live-session-outbox-streamer.sqlite3'

type SQLiteApi = typeof SQLite & {
  Factory(module: unknown): {
    vfs_register(vfs: unknown, makeDefault?: boolean): number
    open_v2(name: string): Promise<number>
    exec(db: number, sql: string): Promise<number>
    execWithParams(
      db: number,
      sql: string,
      params?: SqliteLiveSessionOutboxValue[],
    ): Promise<{ rows: unknown[][]; columns: string[] }>
    run(
      db: number,
      sql: string,
      params?: SqliteLiveSessionOutboxValue[],
    ): Promise<number>
    changes(db: number): number
  }
}

type DbContext = {
  sqlite3: ReturnType<SQLiteApi['Factory']>
  db: number
}

let dbContextPromise: Promise<DbContext> | null = null

const hasIndexedDb = (): boolean =>
  typeof indexedDB !== 'undefined'

const getWaSqliteAsyncWasmUrl = (): string => {
  if (typeof waSqliteAsyncWasmUrl !== 'string' || waSqliteAsyncWasmUrl.length === 0) {
    throw new Error('wa-sqlite wasm 资源地址无效')
  }

  return waSqliteAsyncWasmUrl
}

const ensureDbContext = async (): Promise<DbContext> => {
  if (!hasIndexedDb()) {
    throw new Error('当前运行时不支持 IndexedDB，无法初始化 live session outbox')
  }

  if (!dbContextPromise) {
    dbContextPromise = (async () => {
      const module = await SQLiteESMFactory({
        locateFile(path: string) {
          if (path === 'wa-sqlite-async.wasm') {
            return getWaSqliteAsyncWasmUrl()
          }
          return path
        },
      })
      const sqlite3 = (SQLite as SQLiteApi).Factory(module)
      const vfs = new IDBBatchAtomicVFS(VFS_NAME)
      ;(sqlite3 as any).vfs_register(vfs, true)
      const db = await sqlite3.open_v2(DATABASE_FILE_NAME)
      return { sqlite3, db }
    })().catch((error: unknown) => {
      dbContextPromise = null
      throw error
    })
  }

  return await dbContextPromise
}

const createWaSqliteBackend = async (): Promise<SqliteLiveSessionOutboxBackend> => {
  const { sqlite3, db } = await ensureDbContext()

  return {
    exec: async (sql: string): Promise<void> => {
      await sqlite3.exec(db, sql)
    },

    run: async (
      sql: string,
      params?: SqliteLiveSessionOutboxValue[],
    ): Promise<number> => {
      await sqlite3.run(db, sql, params)
      return sqlite3.changes(db)
    },

    query: async (
      sql: string,
      params?: SqliteLiveSessionOutboxValue[],
    ): Promise<unknown[][]> => {
      const result = await sqlite3.execWithParams(db, sql, params)
      return result.rows
    },
  }
}

const createLiveSessionOutboxAdapter = (): LiveSessionOutboxStore | undefined => {
  if (!hasIndexedDb()) {
    return undefined
  }

  return createSqliteLiveSessionOutbox(createWaSqliteBackend)
}

export const liveSessionOutbox = {
  getAdapter(): LiveSessionOutboxStore | undefined {
    return createLiveSessionOutboxAdapter()
  },
}
