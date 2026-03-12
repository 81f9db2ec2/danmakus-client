import { getStartupBilibiliUserAgent } from './bilibiliUserAgent'

const biliCookieKey = 'bili_cookie'
const biliRefreshTokenKey = 'bili_refresh_token'
const biliSessionWarmAtKey = 'bili_session_warmed_at'
const biliBuvidKey = 'bili_buvid'

const biliCookieJarChangeListeners = new Set<(nextCookie: string, previousCookie: string) => void>()

export function onBiliCookieJarChanged(
  listener: (nextCookie: string, previousCookie: string) => void
): () => void {
  biliCookieJarChangeListeners.add(listener)
  return () => {
    biliCookieJarChangeListeners.delete(listener)
  }
}

function notifyBiliCookieJarChanged(nextCookie: string, previousCookie: string): void {
  for (const listener of biliCookieJarChangeListeners) {
    listener(nextCookie, previousCookie)
  }
}

export function getStoredCookieJar(): string {
  return localStorage.getItem(biliCookieKey) || ''
}

export function getStoredRefreshToken(): string {
  return localStorage.getItem(biliRefreshTokenKey) || ''
}

export function clearStoredRefreshToken(): void {
  localStorage.removeItem(biliRefreshTokenKey)
}

export function getStoredSessionWarmAt(): number {
  return Number(localStorage.getItem(biliSessionWarmAtKey) || '0')
}

export function setStoredSessionWarmAt(value: number): void {
  localStorage.setItem(biliSessionWarmAtKey, String(value))
}

export function clearStoredSessionWarmAt(): void {
  localStorage.removeItem(biliSessionWarmAtKey)
}

export function getStoredBuvid(): string {
  return localStorage.getItem(biliBuvidKey)?.trim() || ''
}

export function setStoredBuvid(buvid: string): void {
  const normalized = buvid.trim()
  if (normalized) {
    localStorage.setItem(biliBuvidKey, normalized)
  } else {
    localStorage.removeItem(biliBuvidKey)
  }
}

export function setStoredCookieJar(cookie: string): void {
  const previous = getStoredCookieJar()
  const normalized = cookie.trim()
  if (normalized === previous) {
    return
  }

  if (normalized) {
    localStorage.setItem(biliCookieKey, normalized)
  } else {
    localStorage.removeItem(biliCookieKey)
  }

  notifyBiliCookieJarChanged(normalized, previous)
}

export function parseCookieHeader(cookieHeader: string): Map<string, string> {
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

export function mergeCookieJar(existingCookie: string, setCookieHeader: string): string {
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
  return Array.from(merged.entries()).map(([key, value]) => `${key}=${value}`).join('; ')
}

export function tryPersistCookiesFromResponse(response: Response): void {
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) return
  const current = getStoredCookieJar()
  const next = mergeCookieJar(current, setCookie)
  if (next && next !== current) {
    setStoredCookieJar(next)
  }
}

export function buildBiliHeaders(): Headers {
  const headers = new Headers()
  headers.set('User-Agent', getStartupBilibiliUserAgent())
  headers.set('Accept', 'application/json, text/plain, */*')
  headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
  headers.set('Origin', 'https://www.bilibili.com')
  headers.set('Referer', 'https://www.bilibili.com/')

  const cookie = getStoredCookieJar()
  if (cookie) headers.set('Cookie', cookie)

  return headers
}

export function readCookieValue(cookie: string, key: string): string | undefined {
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

export const biliCookie = {
  getBiliCookie() {
    return getStoredCookieJar()
  },
  getRefreshToken() {
    return getStoredRefreshToken()
  },
  setBiliCookie(cookie: string, refreshToken: string) {
    setStoredCookieJar(cookie)
    localStorage.setItem(biliRefreshTokenKey, refreshToken)
  },
  clear() {
    setStoredCookieJar('')
    clearStoredRefreshToken()
    clearStoredSessionWarmAt()
    setStoredBuvid('')
  }
}
