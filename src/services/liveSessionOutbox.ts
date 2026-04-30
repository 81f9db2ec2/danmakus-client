import { invoke, isTauri } from '@tauri-apps/api/core'
import type {
  LiveSessionOutboxInsert,
  LiveSessionOutboxItem,
  LiveSessionOutboxRescheduleUpdate,
  LiveSessionOutboxStore,
} from 'danmakus-core'

type RustLiveSessionOutboxInsert = {
  streamerUid: number
  eventTsMs: number
  payload: number[]
}

type RustLiveSessionOutboxItem = {
  id: number
  streamerUid: number
  eventTsMs: number
  payload: number[]
  retryCount: number
  nextRetryAtMs: number
}

const toRustInsert = (item: LiveSessionOutboxInsert): RustLiveSessionOutboxInsert => ({
  streamerUid: Math.floor(item.streamerUid),
  eventTsMs: Math.floor(item.eventTsMs),
  payload: Array.from(item.payload),
})

const fromRustItem = (item: RustLiveSessionOutboxItem): LiveSessionOutboxItem => ({
  id: Math.floor(item.id),
  streamerUid: Math.floor(item.streamerUid),
  eventTsMs: Math.floor(item.eventTsMs),
  payload: Uint8Array.from(item.payload),
  retryCount: Math.floor(item.retryCount),
  nextRetryAtMs: Math.floor(item.nextRetryAtMs),
})

const createLiveSessionOutboxAdapter = (): LiveSessionOutboxStore => {
  if (!isTauri()) {
    throw new Error('当前环境不支持本地归档 outbox')
  }

  return {
    append: async (items: LiveSessionOutboxInsert[]): Promise<number> => {
      if (items.length === 0) {
        return 0
      }
      return await invoke<number>('live_session_outbox_append', {
        items: items.map(toRustInsert),
      })
    },

    listDue: async ({ nowMs, limit }: { nowMs: number; limit?: number }): Promise<LiveSessionOutboxItem[]> => {
      const items = await invoke<RustLiveSessionOutboxItem[]>('live_session_outbox_list_due', {
        nowMs: Math.floor(nowMs),
        limit: Math.floor(limit ?? 200),
      })
      return items.map(fromRustItem)
    },

    ack: async (ids: number[]): Promise<number> => {
      if (ids.length === 0) {
        return 0
      }
      return await invoke<number>('live_session_outbox_ack', {
        ids: ids.map(id => Math.floor(id)),
      })
    },

    reschedule: async (updates: LiveSessionOutboxRescheduleUpdate[]): Promise<number> => {
      if (updates.length === 0) {
        return 0
      }
      return await invoke<number>('live_session_outbox_reschedule', {
        updates: updates.map(update => ({
          id: Math.floor(update.id),
          retryCount: Math.floor(update.retryCount),
          nextRetryAtMs: Math.floor(update.nextRetryAtMs),
        })),
      })
    },

    countPending: async (): Promise<number> =>
      await invoke<number>('live_session_outbox_count_pending'),
  }
}

export const liveSessionOutbox = {
  async createAdapter(): Promise<LiveSessionOutboxStore> {
    const adapter = createLiveSessionOutboxAdapter()
    await adapter.countPending()
    return adapter
  },
}
