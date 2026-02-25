import { fetchImpl } from './fetchImpl'

const biliCookieKey = 'bili_cookie'
const biliRefreshTokenKey = 'bili_refresh_token'
const biliSessionWarmAtKey = 'bili_session_warmed_at'

const userAgentPool = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
]

function pickUserAgent(): string {
  return userAgentPool[Math.floor(Math.random() * userAgentPool.length)]
}

function getStoredCookieJar(): string {
  return localStorage.getItem(biliCookieKey) || ''
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

function buildBiliHeaders(url: string): Headers {
  const headers = new Headers()
  headers.set('User-Agent', pickUserAgent())
  headers.set('Accept', 'application/json, text/plain, */*')
  headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
  headers.set('Origin', 'https://www.bilibili.com')

  const host = new URL(url).host
  const referer = host.includes('live.bilibili.com') || host.startsWith('api.live.bilibili.com')
    ? 'https://live.bilibili.com/'
    : 'https://www.bilibili.com/'
  headers.set('Referer', referer)

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
    headers: buildBiliHeaders(url),
  })
  tryPersistCookiesFromResponse(response)
  localStorage.setItem(biliSessionWarmAtKey, String(now))
}

export async function QueryBiliAPI(url: string, method: string = 'GET', body?: any): Promise<Response> {
  const headers = buildBiliHeaders(url)

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

export async function checkLoginStatusAsync(): Promise<boolean> {
  const url = 'https://api.bilibili.com/x/web-interface/nav/stat'
  try {
    const response = await QueryBiliAPI(url)
    const json = await response.json()
    return json.code === 0
  } catch {
    return false;
  }
}

export async function getUidAsync(): Promise<number> {
  const url = 'https://api.live.bilibili.com/xlive/web-ucenter/user/get_user_info'
  try {
    const response = await QueryBiliAPI(url)
    const json = await response.json()
    if (json.data && json.data.uid) {
      return json.data.uid
    }
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
    },
    async check() {
        return await checkLoginStatusAsync();
    }
}
