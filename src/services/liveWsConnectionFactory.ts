import { LiveWS } from '@laplace.live/ws/client'
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

const tauriReadyState = {
  connecting: 0,
  open: 1,
  closing: 2,
  closed: 3,
} as const

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

function toUint8Array(data: string | ArrayBufferLike | Blob | ArrayBufferView): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  throw new Error('当前运行时不支持发送 Blob 类型的 WS 数据')
}

class TauriBrowserWebSocket extends EventTarget {
  binaryType: BinaryType = 'arraybuffer'
  readyState: number = tauriReadyState.connecting
  private socket: TauriWsConnection | null = null
  private removeListener: (() => void) | null = null
  private closed = false

  constructor(
    private readonly address: string,
    private readonly headers: Record<string, string>
  ) {
    super()
    void this.connect()
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== tauriReadyState.open || !this.socket || this.closed) {
      return
    }

    const payload = Array.from(toUint8Array(data))
    void this.socket.send(payload).catch((error) => {
      dispatchErrorEvent(this, error)
    })
  }

  close(): void {
    if (this.closed || this.readyState === tauriReadyState.closed) {
      return
    }

    this.closed = true
    if (!this.socket) {
      this.readyState = tauriReadyState.closed
      this.cleanup()
      return
    }

    this.readyState = tauriReadyState.closing
    const current = this.socket
    this.socket = null
    this.cleanup()
    void current.disconnect().catch((error) => {
      dispatchErrorEvent(this, error)
    })
  }

  private async connect(): Promise<void> {
    try {
      const socket = await connectTauriWs(this.address, this.headers)
      if (this.closed) {
        void socket.disconnect().catch(() => undefined)
        return
      }

      this.socket = socket
      this.readyState = tauriReadyState.open
      this.removeListener = socket.addListener((message) => {
        this.handleMessage(message)
      })
      this.dispatchEvent(new Event('open'))
    } catch (error) {
      this.readyState = tauriReadyState.closed
      this.cleanup()
      dispatchErrorEvent(this, error)
    }
  }

  private handleMessage(message: TauriWsMessage): void {
    if (message.type === 'Binary') {
      const payload = new Uint8Array(message.data)
      const data = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
      this.dispatchEvent(new MessageEvent('message', { data }))
      return
    }

    if (message.type === 'Ping') {
      void this.socket?.send({ type: 'Pong', data: message.data }).catch(() => undefined)
      return
    }

    if (message.type === 'Close') {
      if (this.readyState === tauriReadyState.closed) {
        return
      }

      this.closed = true
      this.readyState = tauriReadyState.closed
      const closeData = message.data
      const code = typeof closeData?.code === 'number' ? closeData.code : 1000
      const reason = typeof closeData?.reason === 'string' ? closeData.reason : ''
      this.socket = null
      this.cleanup()
      dispatchCloseEvent(this, code, reason)
    }
  }

  private cleanup(): void {
    this.removeListener?.()
    this.removeListener = null
  }
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

  return new LiveWS(roomId, {
    address: options.address,
    key: options.key,
    uid: options.uid,
    buvid: options.buvid,
    protover: options.protover ?? 3,
    createWebSocket: (address) => {
      return new TauriBrowserWebSocket(address, buildLiveWsHeaders()) as unknown as WebSocket
    }
  })
}
