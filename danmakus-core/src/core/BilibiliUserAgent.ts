// 真实发布的主流 Chrome Windows x64 版本池 (Major, Full Version)
// 保证 major、build 与 patch 真实对应，杜绝随意随机生成导致版本号不合逻辑
interface ChromeProfile {
  major: number;
  fullVersion: string;
}

const CHROME_PROFILES: readonly ChromeProfile[] = [
  { major: 133, fullVersion: '133.0.6943.127' },
  { major: 133, fullVersion: '133.0.6943.98' },
  { major: 132, fullVersion: '132.0.6834.196' },
  { major: 132, fullVersion: '132.0.6834.111' },
  { major: 131, fullVersion: '131.0.6778.265' },
  { major: 131, fullVersion: '131.0.6778.205' },
  { major: 130, fullVersion: '130.0.6723.117' },
  { major: 129, fullVersion: '129.0.6668.101' },
];

function selectRandomProfile(): ChromeProfile {
  const index = Math.floor(Math.random() * CHROME_PROFILES.length);
  return CHROME_PROFILES[index]!;
}

const activeProfile = selectRandomProfile();
const startupBilibiliUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${activeProfile.fullVersion} Safari/537.36`;

function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === 'object' && input && 'url' in input) {
    return String((input as Request).url);
  }
  return String(input);
}

function shouldAttachBilibiliUserAgent(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host.endsWith('.bilibili.com') || host === 'bilibili.com';
  } catch {
    return false;
  }
}

export function getStartupBilibiliUserAgent(): string {
  return startupBilibiliUserAgent;
}

export function getStartupBilibiliClientHints(): Record<string, string> {
  return {
    'Sec-Ch-Ua': `"Not A(Brand";v="8", "Chromium";v="${activeProfile.major}", "Google Chrome";v="${activeProfile.major}"`,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
  };
}

export function populateBilibiliBrowserHeaders(headers: Headers): void {
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', startupBilibiliUserAgent);
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json, text/plain, */*');
  }
  if (!headers.has('Accept-Language')) {
    headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7');
  }
  if (!headers.has('Origin')) {
    headers.set('Origin', 'https://www.bilibili.com');
  }
  if (!headers.has('Referer')) {
    headers.set('Referer', 'https://www.bilibili.com/');
  }

  const hints = getStartupBilibiliClientHints();
  for (const [key, value] of Object.entries(hints)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
}

export function wrapBilibiliFetch(
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const resolvedFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const url = toUrlString(input);
    if (!shouldAttachBilibiliUserAgent(url)) {
      return resolvedFetch(input, init);
    }

    const headers = new Headers(init?.headers ?? {});
    populateBilibiliBrowserHeaders(headers);

    return resolvedFetch(input, {
      ...init,
      headers,
    });
  };
}
