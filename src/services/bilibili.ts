import { fetchImpl } from './fetchImpl'

const biliCookieKey = 'bili_cookie'
const biliRefreshTokenKey = 'bili_refresh_token'
const biliSessionWarmAtKey = 'bili_session_warmed_at'
const biliBuvidKey = 'bili_buvid'

const fallbackUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
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

function getStableUserAgent(): string {
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent?.trim()
    if (ua) return ua
  }
  return fallbackUserAgent
}

function getStoredCookieJar(): string {
  return localStorage.getItem(biliCookieKey) || ''
}

function getStoredBuvid(): string {
  return localStorage.getItem(biliBuvidKey)?.trim() || ''
}

function setStoredBuvid(buvid: string): void {
  const normalized = buvid.trim()
  if (normalized) {
    localStorage.setItem(biliBuvidKey, normalized)
  } else {
    localStorage.removeItem(biliBuvidKey)
  }
}

function setStoredCookieJar(cookie: string): void {
  const normalized = cookie.trim()
  if (normalized) {
    localStorage.setItem(biliCookieKey, normalized)
  } else {
    localStorage.removeItem(biliCookieKey)
  }
}

function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!name) continue
    map.set(name, value)
  }
  return map
}

function splitSetCookieHeader(setCookie: string): string[] {
  const chunks: string[] = []
  let current = ''
  let inExpires = false

  const pushCurrent = () => {
    const value = current.trim()
    if (value) chunks.push(value)
    current = ''
    inExpires = false
  }

  for (let i = 0; i < setCookie.length; i++) {
    const ch = setCookie[i]
    current += ch

    if (ch === ';') {
      inExpires = false
      continue
    }

    if (!inExpires && (ch === 'e' || ch === 'E')) {
      const tail = setCookie.slice(i)
      if (/^expires=/i.test(tail)) {
        inExpires = true
        continue
      }
    }

    if (ch !== ',' || inExpires) continue

    const rest = setCookie.slice(i + 1)
    if (/^\s*[^=\s;,]+=\S+/.test(rest)) {
      current = current.slice(0, -1)
      pushCurrent()
    }
  }

  pushCurrent()
  return chunks
}

function mergeCookieJar(existingCookie: string, setCookieHeader: string): string {
  const merged = parseCookieHeader(existingCookie)
  for (const raw of splitSetCookieHeader(setCookieHeader)) {
    const first = raw.split(';')[0]?.trim()
    if (!first) continue
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!name) continue
    merged.set(name, value)
  }
  return Array.from(merged.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}

function tryPersistCookiesFromResponse(response: Response): void {
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) return
  const current = getStoredCookieJar()
  const next = mergeCookieJar(current, setCookie)
  if (next && next !== current) {
    setStoredCookieJar(next)
  }
}

function buildBiliHeaders(): Headers {
  const headers = new Headers()
  headers.set('User-Agent', getStableUserAgent())
  headers.set('Accept', 'application/json, text/plain, */*')
  headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
  headers.set('Origin', 'https://www.bilibili.com')
  headers.set('Referer', 'https://www.bilibili.com/')

  const cookie = getStoredCookieJar()
  if (cookie) headers.set('Cookie', cookie)

  return headers
}

async function warmupBiliSession(): Promise<void> {
  const now = Date.now()
  const lastWarm = Number(localStorage.getItem(biliSessionWarmAtKey) || '0')
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
  localStorage.setItem(biliSessionWarmAtKey, String(now))
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
  return Array.from(out).map((v) => v.toString(16).padStart(2, '0')).join('')
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

export async function QueryBiliAPI(url: string, method: string = 'GET', body?: any): Promise<Response> {
  const headers = buildBiliHeaders()

  const options: RequestInit = {
    method,
    headers,
  };

  if (body) {
    if (typeof body === 'object') {
        headers.set('Content-Type', 'application/json');
        options.body = JSON.stringify(body);
    } else {
        options.body = body;
    }
  }

  const response = await fetchImpl(url, options)
  tryPersistCookiesFromResponse(response)
  return response
}

export interface BiliNavProfile {
  uid: number
  uname: string
  face: string
  level: number
  money: number
  vipStatus: number
  vipLabel: string
}

type BiliNavResponse = {
  code?: unknown
  message?: unknown
  data?: {
    isLogin?: unknown
    mid?: unknown
    uname?: unknown
    face?: unknown
    money?: unknown
    vipStatus?: unknown
    vip_label?: { text?: unknown }
    level_info?: { current_level?: unknown }
  }
}

export async function getNavProfileAsync(): Promise<BiliNavProfile | null> {
  const url = 'https://api.bilibili.com/x/web-interface/nav'
  const response = await QueryBiliAPI(url)
  if (!response.ok) {
    throw new Error(`检查 Bilibili 登录状态失败: HTTP ${response.status}`)
  }

  const payload = await response.json() as BiliNavResponse
  const code = typeof payload.code === 'number' ? payload.code : Number(payload.code)
  if (!Number.isFinite(code)) {
    throw new Error('检查 Bilibili 登录状态失败: nav 返回无效 code')
  }

  if (code !== 0) {
    if (code === -101) {
      return null
    }
    throw new Error(`检查 Bilibili 登录状态失败: ${String(payload.message ?? code)}`)
  }

  const data = payload.data
  const isLogin = data?.isLogin === true || data?.isLogin === 1 || data?.isLogin === '1'
  if (!isLogin) {
    return null
  }

  const uidValue = typeof data?.mid === 'number' ? data.mid : Number(data?.mid)
  if (!Number.isFinite(uidValue) || uidValue <= 0) {
    throw new Error('检查 Bilibili 登录状态失败: nav 返回无效 mid')
  }
  const uid = Math.floor(uidValue)

  const levelValue = typeof data?.level_info?.current_level === 'number'
    ? data.level_info.current_level
    : Number(data?.level_info?.current_level)
  const moneyValue = typeof data?.money === 'number' ? data.money : Number(data?.money)
  const vipValue = typeof data?.vipStatus === 'number' ? data.vipStatus : Number(data?.vipStatus)

  return {
    uid,
    uname: typeof data?.uname === 'string' && data.uname.trim() ? data.uname.trim() : `UID ${uid}`,
    face: typeof data?.face === 'string' ? data.face : '',
    level: Number.isFinite(levelValue) ? Math.floor(levelValue) : 0,
    money: Number.isFinite(moneyValue) ? moneyValue : 0,
    vipStatus: Number.isFinite(vipValue) ? Math.floor(vipValue) : 0,
    vipLabel: typeof data?.vip_label?.text === 'string' ? data.vip_label.text : ''
  }
}

export async function checkLoginStatusAsync(): Promise<boolean> {
  try {
    return (await getNavProfileAsync()) !== null
  } catch {
    return false;
  }
}

export async function getUidAsync(): Promise<number> {
  try {
    const profile = await getNavProfileAsync()
    return profile?.uid ?? 0
  } catch (e) {
    console.error(e);
  }
  return 0
}

// 二维码地址及扫码密钥
export async function getLoginUrlAsync(): Promise<any> {
  try {
    await warmupBiliSession()
  } catch (err) {
    console.warn('[bili] session warmup failed, continue without warmup', err)
  }
  const url = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
  const response = await QueryBiliAPI(url, 'GET')
  if (!response.ok) {
    const result = await response.text()
    console.error(`无法获取B站登陆二维码: ${result}`)
    throw new Error('获取二维码地址失败')
  }
  return response.json()
}

export async function getLoginUrlDataAsync(): Promise<{
  url: string
  qrcode_key: string
}> {
  const message = await getLoginUrlAsync()
  if (message.code !== 0) {
    throw new Error(message.message || '获取二维码地址失败')
  }
  if (!message.data?.url || !message.data?.qrcode_key) {
    throw new Error('获取二维码数据失败')
  }
  return message.data as {
    url: string
    qrcode_key: string
  }
}

export type QRCodeLoginInfo
  = | { status: 'expired' }
    | { status: 'unknown' }
    | { status: 'scanned' }
    | { status: 'waiting' }
    | { status: 'confirmed', cookie: string, refresh_token: string }

export async function getLoginInfoAsync(qrcodeKey: string): Promise<QRCodeLoginInfo> {
  const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${qrcodeKey}&source=main-fe-header` 
  const response = await QueryBiliAPI(url)
  const message = await response.json()

  if (!message.data) {
    throw new Error('获取登录信息失败')
  }

  if (message.data.code !== 0) {
    switch (message.data.code) {
      case 86038:
        return { status: 'expired' }
      case 86090:
        return { status: 'scanned' }
      case 86101:
        return { status: 'waiting' }
      default:
        return { status: 'unknown' }
    }
  }

  const cookies = response.headers.get('set-cookie')
  if (!cookies) {
    throw new Error('无法获取 Cookie (Set-Cookie Header missing)')
  }

  const cookie = extractCookie(cookies)
  setStoredCookieJar(cookie)
  return { status: 'confirmed', cookie, refresh_token: message.data.refresh_token }
}

function extractCookie(cookies: string): string {
  return mergeCookieJar(getStoredCookieJar(), cookies)
}

function readCookieValue(cookie: string, key: string): string | undefined {
  for (const part of cookie.split(';')) {
    const segment = part.trim()
    if (!segment) continue
    const eq = segment.indexOf('=')
    if (eq <= 0) continue
    const name = segment.slice(0, eq).trim()
    if (name !== key) continue
    const value = segment.slice(eq + 1).trim()
    if (value) return value
  }
  return undefined
}

function buildWssAddress(host: string, wssPort: number): string {
  const trimmed = host.trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('host 为空')
  }

  let base = trimmed
  if (/^wss?:\/\//i.test(base)) {
    base = base.replace(/^ws:\/\//i, 'wss://')
  } else {
    const portSuffix = Number.isFinite(wssPort) && wssPort > 0 && wssPort !== 443
      ? `:${wssPort}`
      : ''
    base = `wss://${base}${portSuffix}`
  }

  return base.endsWith('/sub') ? base : `${base}/sub`
}

export async function getLiveWsRoomConfigAsync(roomId: number): Promise<{
  roomId?: number
  address: string
  key: string
  uid: number
  buvid?: string
  protover: 3
}> {
  if (!Number.isFinite(roomId) || roomId <= 0) {
    throw new Error(`无效房间号: ${roomId}`)
  }
  await warmupBiliSession()

  const query = await buildWbiQueryString({
    id: String(roomId),
    type: '0'
  })
  const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`

  type DanmuInfoPayload = {
    code?: unknown
    message?: unknown
    msg?: unknown
    data?: {
      token?: unknown
      host_list?: Array<{ host?: unknown; wss_port?: unknown }>
    }
  }

  const queryDanmuInfo = async (): Promise<{ payload: DanmuInfoPayload; vVoucher: string; hasCookie: boolean }> => {
    const response = await QueryBiliAPI(url)
    if (!response.ok) {
      const message = await response.text().catch(() => '')
      throw new Error(`获取房间 ${roomId} 鉴权信息失败: HTTP ${response.status}${message ? ` ${message}` : ''}`)
    }
    const payload = await response.json() as DanmuInfoPayload
    const vVoucher = response.headers.get('x-bili-gaia-vvoucher')
      ?? response.headers.get('X-Bili-Gaia-VVoucher')
      ?? ''
    return {
      payload,
      vVoucher: vVoucher.trim(),
      hasCookie: getStoredCookieJar().trim().length > 0
    }
  }

  let first = await queryDanmuInfo()
  let payload = first.payload
  let vVoucher = first.vVoucher
  let hasCookie = first.hasCookie
  if (payload.code === -352) {
    console.warn(
      `[BiliLiveWS] 房间 ${roomId} 首次 getDanmuInfo 返回 -352，准备重试 (cookie=${hasCookie ? 'present' : 'missing'}, vvoucher=${vVoucher || 'none'})`
    )
    await warmupBiliSession()
    const second = await queryDanmuInfo()
    payload = second.payload
    vVoucher = second.vVoucher
    hasCookie = second.hasCookie
  }

  if (payload.code !== 0) {
    const message = typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : (typeof payload.msg === 'string' && payload.msg.trim()
        ? payload.msg.trim()
        : `code=${String(payload.code)}`)
    if (payload.code === -352) {
      throw new Error(`获取房间 ${roomId} 鉴权信息失败: ${message} (wbi=on,cookie=${hasCookie ? 'present' : 'missing'},vvoucher=${vVoucher || 'none'})`)
    }
    throw new Error(`获取房间 ${roomId} 鉴权信息失败: ${message}`)
  }

  const token = typeof payload.data?.token === 'string' ? payload.data.token.trim() : ''
  if (!token) {
    throw new Error(`获取房间 ${roomId} 鉴权信息失败: token 为空`)
  }

  const validHosts = (payload.data?.host_list ?? []).filter((item): item is { host: string; wss_port?: unknown } => {
    return typeof item?.host === 'string' && item.host.trim().length > 0
  })
  if (validHosts.length === 0) {
    throw new Error(`获取房间 ${roomId} 鉴权信息失败: host_list 为空`)
  }
  const hostInfo = validHosts[Math.floor(Math.random() * validHosts.length)]!

  const address = buildWssAddress(hostInfo.host, Number(hostInfo.wss_port))

  const roomInitResponse = await QueryBiliAPI(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`)
  if (!roomInitResponse.ok) {
    throw new Error(`获取房间 ${roomId} 初始化信息失败: HTTP ${roomInitResponse.status}`)
  }
  const roomInitPayload = await roomInitResponse.json() as {
    code?: unknown
    message?: unknown
    data?: { room_id?: unknown }
  }
  if (roomInitPayload.code !== 0) {
    throw new Error(`获取房间 ${roomId} 初始化信息失败: ${String(roomInitPayload.message ?? roomInitPayload.code)}`)
  }
  const resolvedRoomIdRaw = roomInitPayload.data?.room_id
  const resolvedRoomId = typeof resolvedRoomIdRaw === 'number' ? resolvedRoomIdRaw : Number(resolvedRoomIdRaw)
  if (!Number.isFinite(resolvedRoomId) || resolvedRoomId <= 0) {
    throw new Error(`获取房间 ${roomId} 初始化信息失败: room_id 无效`)
  }

  let apiUid = 0
  try {
    const navProfile = await getNavProfileAsync()
    apiUid = navProfile?.uid ?? 0
  } catch (error) {
    console.warn(`[BiliLiveWS] 房间 ${roomId} 通过 nav 获取 UID 失败，回退 cookie`, error)
  }

  const cookie = getStoredCookieJar().trim()
  const uidText = readCookieValue(cookie, 'DedeUserID')
  const cookieUid = uidText && /^[0-9]+$/.test(uidText) ? Number(uidText) : 0
  const uid = apiUid > 0 ? apiUid : cookieUid
  const uidSource = apiUid > 0 ? 'nav' : (cookieUid > 0 ? 'cookie' : 'none')
  const buvid = getStoredBuvid()
    || (readCookieValue(cookie, 'buvid3')
    ?? readCookieValue(cookie, 'buvid4')
    ?? readCookieValue(cookie, 'buvid_fp'))

  const addressHost = address.replace(/^wss?:\/\//i, '').split('/')[0] || 'unknown'
  console.info(
    `[BiliLiveWS] 房间 ${roomId} 鉴权成功: wsRoom=${resolvedRoomId}, tokenLen=${token.length}, hostCount=${validHosts.length}, selectedHost=${addressHost}, uid=${uid}(${uidSource}), buvid=${buvid ? 'present' : 'missing'}`
  )

  return {
    roomId: resolvedRoomId,
    address,
    key: token,
    uid,
    buvid,
    protover: 3
  }
}

export const biliCookie = {
    getBiliCookie() {
        return localStorage.getItem(biliCookieKey) || '';
    },
    getRefreshToken() {
        return localStorage.getItem(biliRefreshTokenKey) || '';
    },
    setBiliCookie(cookie: string, refreshToken: string) {
        setStoredCookieJar(cookie)
        localStorage.setItem(biliRefreshTokenKey, refreshToken);
    },
    clear() {
        localStorage.removeItem(biliCookieKey);
        localStorage.removeItem(biliRefreshTokenKey);
        localStorage.removeItem(biliSessionWarmAtKey);
        localStorage.removeItem(biliBuvidKey);
    },
    async check() {
        return await checkLoginStatusAsync();
    }
}
