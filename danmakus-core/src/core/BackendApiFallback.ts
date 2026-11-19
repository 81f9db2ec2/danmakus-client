export const BACKEND_API_ORIGINS = [
  'https://ukamnads.icu',
  'https://api.ukamnads.icu',
  'https://api.danmakus.com',
] as const;

export const BACKEND_PRIMARY_ORIGIN = BACKEND_API_ORIGINS[0];

type FetchBackendApiFallbackOptions = {
  timeoutMs?: number;
  origins?: readonly string[];
};

const isBackendApiPath = (pathname: string): boolean => pathname.startsWith('/api/');

const builtinOriginSet: ReadonlySet<string> = new Set(BACKEND_API_ORIGINS);

let configuredOrigins: readonly string[] | null = null;

const normalizeOriginList = (origins: readonly string[]): string[] => {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const origin of origins) {
    const trimmed = origin.trim().replace(/\/+$/, '');
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
};

export function setBackendApiFallbackOrigins(origins: readonly string[] | null): void {
  if (!origins || origins.length === 0) {
    configuredOrigins = null;
    return;
  }
  const next = normalizeOriginList(origins);
  configuredOrigins = next.length > 0 ? next : null;
}

export function getBackendApiFallbackOrigins(): readonly string[] {
  return configuredOrigins ?? BACKEND_API_ORIGINS;
}

const resolveFallbackChain = (origins?: readonly string[]): readonly string[] => {
  if (origins && origins.length > 0) {
    return normalizeOriginList(origins);
  }
  return configuredOrigins ?? BACKEND_API_ORIGINS;
};

const shouldRewriteToPreferredChain = (origin: string, chain: readonly string[]): boolean =>
  configuredOrigins != null && (builtinOriginSet.has(origin) || chain.includes(origin));

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
};

const toWsRuntimeUrl = (runtimeUrl: string): string => {
  const parsed = new URL(runtimeUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!parsed.pathname.endsWith('/ws')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/ws';
  }
  return parsed.toString();
};

const toHttpUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.protocol === 'wss:') {
    parsed.protocol = 'https:';
  } else if (parsed.protocol === 'ws:') {
    parsed.protocol = 'http:';
  }
  return parsed.toString();
};

export const buildBackendWsCandidateUrls = (runtimeUrl: string, origins?: readonly string[]): string[] => {
  const normalizedUrl = runtimeUrl.trim();
  if (!normalizedUrl) {
    return [];
  }

  try {
    const primaryWsUrl = toWsRuntimeUrl(normalizedUrl);
    const parsedPrimary = new URL(primaryWsUrl);
    if (origins == null && isLoopbackHost(parsedPrimary.hostname)) {
      return [primaryWsUrl];
    }

    const httpCandidates = buildBackendApiCandidateUrls(toHttpUrl(primaryWsUrl), origins);
    const wsCandidates: string[] = [];
    const seen = new Set<string>();
    for (const candidate of httpCandidates) {
      const wsUrl = toWsRuntimeUrl(candidate);
      if (!seen.has(wsUrl)) {
        seen.add(wsUrl);
        wsCandidates.push(wsUrl);
      }
    }
    return wsCandidates.length > 0 ? wsCandidates : [primaryWsUrl];
  } catch {
    return [normalizedUrl];
  }
};

export const buildBackendApiCandidateUrls = (url: string, origins?: readonly string[]): string[] => {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return [];
  }

  try {
    const parsed = new URL(normalizedUrl);
    if (!isBackendApiPath(parsed.pathname)) {
      return [parsed.toString()];
    }

    const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    const candidates: string[] = [];
    const seen = new Set<string>();
    const pushOrigin = (origin: string) => {
      const next = new URL(suffix, origin).toString();
      if (seen.has(next)) {
        return;
      }
      seen.add(next);
      candidates.push(next);
    };

    const chain = resolveFallbackChain(origins);
    if (origins == null && shouldRewriteToPreferredChain(parsed.origin, chain)) {
      for (const origin of chain) {
        pushOrigin(origin);
      }
    } else {
      pushOrigin(parsed.origin);
      for (const origin of chain) {
        pushOrigin(origin);
      }
    }
    return candidates;
  } catch {
    return [normalizedUrl];
  }
};

const isRetryableHttpStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

export async function fetchBackendApiWithFallback(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  init?: RequestInit,
  options?: FetchBackendApiFallbackOptions,
): Promise<Response> {
  const candidates = buildBackendApiCandidateUrls(url, options?.origins);
  let lastError: unknown = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidateUrl = candidates[index]!;
    try {
      const controller = new AbortController();
      const sourceSignal = init?.signal;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;

      const handleAbort = () => {
        controller.abort(sourceSignal?.reason);
      };

      if (sourceSignal) {
        if (sourceSignal.aborted) {
          controller.abort(sourceSignal.reason);
        } else {
          sourceSignal.addEventListener('abort', handleAbort, { once: true });
        }
      }

      if ((options?.timeoutMs ?? 0) > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options!.timeoutMs);
      }

      let response: Response;
      try {
        response = await fetchImpl(candidateUrl, {
          ...init,
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) {
          throw new Error(`后端请求超时(${options!.timeoutMs}ms): ${candidateUrl}`);
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        sourceSignal?.removeEventListener('abort', handleAbort);
      }

      if (response.ok || !isRetryableHttpStatus(response.status) || index === candidates.length - 1) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (index === candidates.length - 1) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('后端请求失败');
}
