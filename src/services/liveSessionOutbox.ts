import Database from '@tauri-apps/plugin-sql'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type {
  LiveSessionOutboxStore,
  ResettableSqliteLiveSessionOutboxBackend,
  SqliteLiveSessionOutboxValue,
} from 'danmakus-core'
import {
  createResettableSqliteLiveSessionOutboxBackend,
  createSqliteLiveSessionOutbox,
} from 'danmakus-core'

const DATABASE_PATH = 'sqlite:live-session-outbox.sqlite3'

type SqlQueryRow = Record<string, unknown>

const deleteDatabaseFile = async (database: Database): Promise<void> => {
  try {
    await database.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // ignore checkpoint failures and proceed to hard reset
  }
  await database.close()
  await invoke('reset_live_session_outbox')
}

const createTauriSqlBackend = async (): Promise<ResettableSqliteLiveSessionOutboxBackend> => {
  const database = await Database.load(DATABASE_PATH)
  await database.execute('PRAGMA journal_mode = WAL')
  await database.execute('PRAGMA synchronous = NORMAL')

  return {
    exec: async (sql: string): Promise<void> => {
      await database.execute(sql)
    },

    run: async (
      sql: string,
      params?: SqliteLiveSessionOutboxValue[],
    ): Promise<number> => {
      const result = await database.execute(sql, params)
      return result.rowsAffected
    },

    query: async (
      sql: string,
      params?: SqliteLiveSessionOutboxValue[],
    ): Promise<unknown[][]> => {
      const rows = await database.select<SqlQueryRow[]>(sql, params)
      return rows.map((row) => {
        if ('a_count' in row) {
          return [row.a_count]
        }

        return [
          row.a_id,
          row.b_streamer_uid,
          row.c_event_ts_ms,
          row.d_payload,
          row.e_retry_count,
          row.f_next_retry_at_ms,
        ]
      })
    },

    reset: async (): Promise<void> => {
      await deleteDatabaseFile(database)
    },
  }
}

const createLiveSessionOutboxAdapter = (): LiveSessionOutboxStore | undefined => {
  if (!isTauri()) {
    return undefined
  }

  return createSqliteLiveSessionOutbox(
    createResettableSqliteLiveSessionOutboxBackend(createTauriSqlBackend),
  )
}

export const liveSessionOutbox = {
  getAdapter(): LiveSessionOutboxStore | undefined {
    return createLiveSessionOutboxAdapter()
  },
}
