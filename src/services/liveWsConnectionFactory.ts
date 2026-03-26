import { Live, LiveWS } from 'bilibili-live-danmaku'
import type { LiveWsConnection, LiveWsRoomConfig } from 'danmakus-core'

const fallbackUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'

type TauriWsMessage =
  | { type: 'Text'; data: string }
  | { type: 'Binary'; data: number[] }
  | { type: 'Ping'; data: number[] }
  | { type: 'Pong'; data: number[] }
  | { type: 'Close'; data: { code: number; reason: string } | null }

type TauriWsConnection = {
  addListener(cb: (message: TauriWsMessage) => void): () => void
  send(message: string | number[] | { type: 'Ping' | 'Pong' | 'Close'; data: number[] | { code: number; reason: string } | null }): Promise<void>
  disconnect(): Promise<void>
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as any
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__)
}

function buildLiveWsHeaders(): Record<string, string> {
  const userAgent = typeof navigator !== 'undefined' && navigator.userAgent?.trim()
    ? navigator.userAgent.trim()
    : fallbackUserAgent
  return {
    Origin: 'https://live.bilibili.com',
    Referer: 'https://live.bilibili.com/',
    'User-Agent': userAgent,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Accept: '*/*',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache'
  }
}

function dispatchCloseEvent(target: EventTarget, code: number, reason: string): void {
  if (typeof CloseEvent !== 'undefined') {
    target.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: true }))
    return
  }
  const closeEvent = new Event('close') as Event & { code?: number; reason?: string }
  closeEvent.code = code
  closeEvent.reason = reason
  target.dispatchEvent(closeEvent)
}

function dispatchErrorEvent(target: EventTarget, error: unknown): void {
  if (typeof ErrorEvent !== 'undefined') {
    target.dispatchEvent(new ErrorEvent('error', { error }))
    return
  }
  const event = new Event('error') as Event & { error?: unknown }
  event.error = error
  target.dispatchEvent(event)
}

async function connectTauriWs(address: string, headers: Record<string, string>): Promise<TauriWsConnection> {
  const module = await import('@tauri-apps/plugin-websocket')
  return await module.default.connect(address, { headers }) as TauriWsConnection
}

export async function createLiveWsConnection(
  roomId: number,
  options: LiveWsRoomConfig
): Promise<LiveWsConnection> {
  if (!options.address) {
    throw new Error(`房间 ${roomId} 缺少 WS 地址`)
  }
  if (!options.key) {
    throw new Error(`房间 ${roomId} 缺少 WS 鉴权 key`)
  }

  if (!isTauriRuntime()) {
    return new LiveWS(roomId, {
      address: options.address,
      key: options.key,
      uid: options.uid,
      buvid: options.buvid,
      protover: options.protover ?? 3
    })
  }

  let socket: TauriWsConnection | null = null
  let removeListener: (() => void) | null = null
  let closed = false

  const live = new Live(roomId, {
    key: options.key,
    uid: options.uid ?? 0,
    buvid: options.buvid,
    protover: options.protover ?? 3,
    send: (data: Uint8Array) => {
      if (!socket || closed) {
        return
      }
      void socket.send(Array.from(data)).catch((error) => {
        console.error(`[live-ws] room ${roomId} send failed`, error)
        dispatchErrorEvent(live, error)
      })
    },
    close: () => {
      if (!socket || closed) {
        return
      }
      closed = true
      const current = socket
      socket = null
      removeListener?.()
      removeListener = null
      void current.disconnect().catch(() => undefined)
    }
  })

  try {
    socket = await connectTauriWs(options.address, buildLiveWsHeaders())
  } catch (error) {
    dispatchErrorEvent(live, error)
    throw error
  }

  removeListener = socket.addListener((message) => {
    if (message.type === 'Binary') {
      const payload = new Uint8Array(message.data)
      live.dispatchEvent(new MessageEvent('message', { data: new Blob([payload]) }))
      return
    }

    if (message.type === 'Ping') {
      void socket?.send({ type: 'Pong', data: message.data }).catch(() => undefined)
      return
    }

    if (message.type === 'Close') {
      if (closed) return
      closed = true
      const closeData = message.data
      const code = typeof closeData?.code === 'number' ? closeData.code : 1000
      const reason = typeof closeData?.reason === 'string' ? closeData.reason : ''
      removeListener?.()
      removeListener = null
      socket = null
      dispatchCloseEvent(live, code, reason)
    }
  })

  setTimeout(() => {
    if (!closed) {
      live.dispatchEvent(new Event('open'))
    }
  }, 0)
  return live
}
