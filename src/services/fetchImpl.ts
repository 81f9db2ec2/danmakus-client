import { getStartupBilibiliUserAgent } from './bilibiliUserAgent';

const isTauri = () => {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__);
};

const shouldUseHttpPlugin = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 相对路径 / 非 URL 交给 webview fetch
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  return host.endsWith('.bilibili.com') || host === 'bilibili.com' || host.endsWith('.hdslb.com') || host === 'hdslb.com';
};

const toUrlString = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === 'object' && input && 'url' in input) {
    return String((input as Request).url);
  }
  return String(input);
};

const toHeaderRecord = (headers: HeadersInit | undefined): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const normalized = new Headers(headers);
  const record: Record<string, string> = {};
  normalized.forEach((value, key) => {
    record[key] = value;
  });
  return Object.keys(record).length ? record : undefined;
};

const normalizeTauriInit = (init?: RequestInit) => {
  if (!init) return undefined;
  const { headers, ...rest } = init;
  return {
    ...rest,
    headers: toHeaderRecord(headers)
  };
};

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const fetchImpl: FetchImpl = async (input, init) => {
  const url = toUrlString(input);
  const nextInit = (() => {
    if (!shouldUseHttpPlugin(url)) {
      return init;
    }

    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', getStartupBilibiliUserAgent());
    }

    return {
      ...init,
      headers
    } satisfies RequestInit;
  })();

  if (isTauri() && shouldUseHttpPlugin(url)) {
    const { fetch } = await import('@tauri-apps/plugin-http');
    return await fetch(url, normalizeTauriInit(nextInit));
  }
  return fetch(input, nextInit);
};
