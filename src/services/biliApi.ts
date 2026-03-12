import { fetchImpl } from './fetchImpl'
import {
  buildBiliHeaders,
  getStoredSessionWarmAt,
  setStoredBuvid,
  setStoredSessionWarmAt,
  tryPersistCookiesFromResponse
} from './biliCookieStore'

const wbiKeyRefreshIntervalMs = 60 * 60 * 1000
const wbiMixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

let wbiImgKey = ''
let wbiSubKey = ''
let wbiKeyExpireAt = 0

export async function warmupBiliSession(): Promise<void> {
  const now = Date.now()
  const lastWarm = getStoredSessionWarmAt()
  if (Number.isFinite(lastWarm) && now - lastWarm < 10 * 60 * 1000) return

  const url = 'https://api.bilibili.com/x/web-frontend/getbuvid'
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: buildBiliHeaders(),
  })
  tryPersistCookiesFromResponse(response)
  if (response.ok) {
    const payload = await response.json() as {
      code?: unknown
      data?: { buvid?: unknown }
    }
    if (payload.code === 0 && typeof payload.data?.buvid === 'string' && payload.data.buvid.trim()) {
      setStoredBuvid(payload.data.buvid.trim())
    }
  }
  setStoredSessionWarmAt(now)
}

function getMixinKey(origin: string): string {
  let mixed = ''
  for (const idx of wbiMixinKeyEncTab) {
    if (idx < origin.length) mixed += origin[idx]
  }
  return mixed.slice(0, 32)
}

function sanitizeWbiValue(value: string): string {
  return value.replace(/[!'()*]/g, '')
}

function leftRotate(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function md5Hex(input: string): string {
  const msg = new TextEncoder().encode(input)
  const origBitLen = msg.length * 8
  const withPaddingLen = (((msg.length + 8) >> 6) + 1) * 64
  const buffer = new Uint8Array(withPaddingLen)
  buffer.set(msg)
  buffer[msg.length] = 0x80
  const view = new DataView(buffer.buffer)
  view.setUint32(withPaddingLen - 8, origBitLen >>> 0, true)
  view.setUint32(withPaddingLen - 4, Math.floor(origBitLen / 0x100000000), true)

  const k = new Uint32Array(64)
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ]

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let offset = 0; offset < withPaddingLen; offset += 64) {
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    const m = new Uint32Array(16)
    for (let i = 0; i < 16; i++) {
      m[i] = view.getUint32(offset + i * 4, true)
    }

    for (let i = 0; i < 64; i++) {
      let f = 0
      let g = 0
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }

      const next = d
      d = c
      c = b
      const sum = (a + f + k[i] + m[g]) >>> 0
      b = (b + leftRotate(sum, s[i])) >>> 0
      a = next
    }

    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true)
  outView.setUint32(4, b0, true)
  outView.setUint32(8, c0, true)
  outView.setUint32(12, d0, true)
  return Array.from(out).map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function getWbiKeysAsync(): Promise<{ imgKey: string; subKey: string }> {
  const now = Date.now()
  if (wbiImgKey && wbiSubKey && now < wbiKeyExpireAt) {
    return { imgKey: wbiImgKey, subKey: wbiSubKey }
  }

  const response = await QueryBiliAPI('https://api.bilibili.com/x/web-interface/nav')
  if (!response.ok) {
    throw new Error(`获取 WBI Key 失败: HTTP ${response.status}`)
  }
  const payload = await response.json() as {
    code?: unknown
    data?: {
      wbi_img?: {
        img_url?: unknown
        sub_url?: unknown
      }
    }
    message?: unknown
  }
  if (payload.code !== 0) {
    throw new Error(`获取 WBI Key 失败: ${String(payload.message ?? payload.code)}`)
  }

  const imgUrl = typeof payload.data?.wbi_img?.img_url === 'string' ? payload.data.wbi_img.img_url : ''
  const subUrl = typeof payload.data?.wbi_img?.sub_url === 'string' ? payload.data.wbi_img.sub_url : ''
  const imgName = imgUrl.split('/').pop()?.split('.')[0] ?? ''
  const subName = subUrl.split('/').pop()?.split('.')[0] ?? ''
  if (!imgName || !subName) {
    throw new Error('获取 WBI Key 失败: img/sub key 为空')
  }

  wbiImgKey = imgName
  wbiSubKey = subName
  wbiKeyExpireAt = now + wbiKeyRefreshIntervalMs
  return { imgKey: imgName, subKey: subName }
}

async function buildWbiQueryString(params: Record<string, string>): Promise<string> {
  const { imgKey, subKey } = await getWbiKeysAsync()
  const mixinKey = getMixinKey(imgKey + subKey)
  const withWts: Record<string, string> = {
    ...params,
    wts: String(Math.floor(Date.now() / 1000))
  }

  const sortedKeys = Object.keys(withWts).sort()
  const search = new URLSearchParams()
  for (const key of sortedKeys) {
    search.set(key, sanitizeWbiValue(withWts[key] ?? ''))
  }
  const query = search.toString()
  const wRid = md5Hex(query + mixinKey)
  search.set('w_rid', wRid)
  return search.toString()
}

export async function buildDanmuInfoUrl(roomId: number): Promise<string> {
  const query = await buildWbiQueryString({
    id: String(roomId),
    isGaiaAvoided: 'true',
    type: '0'
  })
  return `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`
}

export async function QueryBiliAPI(url: string, method: string = 'GET', body?: any): Promise<Response> {
  const headers = buildBiliHeaders()
  const options: RequestInit = {
    method,
    headers,
  }

  if (body) {
    if (typeof body === 'object') {
      headers.set('Content-Type', 'application/json')
      options.body = JSON.stringify(body)
    } else {
      options.body = body
    }
  }

  const response = await fetchImpl(url, options)
  tryPersistCookiesFromResponse(response)
  return response
}
