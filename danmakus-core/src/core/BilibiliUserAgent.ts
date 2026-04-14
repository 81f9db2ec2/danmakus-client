import { faker } from '@faker-js/faker'

const startupBilibiliUserAgent = faker.internet.userAgent()

function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.toString()
  }
  if (typeof input === 'object' && input && 'url' in input) {
    return String((input as Request).url)
  }
  return String(input)
}

function shouldAttachBilibiliUserAgent(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return host.endsWith('.bilibili.com') || host === 'bilibili.com'
  } catch {
    return false
  }
}

export function getStartupBilibiliUserAgent(): string {
  return startupBilibiliUserAgent
}

export function wrapBilibiliFetch(
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const resolvedFetch = fetchImpl ?? globalThis.fetch.bind(globalThis)
  return async (input, init) => {
    const url = toUrlString(input)
    if (!shouldAttachBilibiliUserAgent(url)) {
      return resolvedFetch(input, init)
    }

    const headers = new Headers(init?.headers ?? {})
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', startupBilibiliUserAgent)
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json, text/plain, */*')
    }
    if (!headers.has('Accept-Language')) {
      headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
    }
    if (!headers.has('Origin')) {
      headers.set('Origin', 'https://www.bilibili.com')
    }
    if (!headers.has('Referer')) {
      headers.set('Referer', 'https://www.bilibili.com/')
    }

    return resolvedFetch(input, {
      ...init,
      headers,
    })
  }
}
