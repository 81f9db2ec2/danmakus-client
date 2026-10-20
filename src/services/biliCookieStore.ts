const biliCookieKey = 'bili_cookie'
const biliRefreshTokenKey = 'bili_refresh_token'

export function getStoredCookieJar(): string {
  return localStorage.getItem(biliCookieKey) || ''
}

export function getStoredRefreshToken(): string {
  return localStorage.getItem(biliRefreshTokenKey) || ''
}

export function clearStoredRefreshToken(): void {
  localStorage.removeItem(biliRefreshTokenKey)
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
  }
}
