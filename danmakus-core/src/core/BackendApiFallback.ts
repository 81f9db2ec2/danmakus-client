export const BACKEND_API_ORIGINS = [
  'https://ukamnads.icu',
  'https://api.ukamnads.icu',
  'https://api.danmakus.com',
] as const;

export const BACKEND_PRIMARY_ORIGIN = BACKEND_API_ORIGINS[0];

type FetchBackendApiFallbackOptions = {
  timeoutMs?: number;
};

const isBackendApiPath = (pathname: string): boolean => pathname.startsWith('/api/');

export const buildBackendApiCandidateUrls = (url: string): string[] => {
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

    pushOrigin(parsed.origin);
    for (const origin of BACKEND_API_ORIGINS) {
      pushOrigin(origin);
    }
    return candidates;
  } catch {
    return [normalizedUrl];
  }
};

export async function fetchBackendApiWithFallback(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  init?: RequestInit,
  options?: FetchBackendApiFallbackOptions,
): Promise<Response> {
  const candidates = buildBackendApiCandidateUrls(url);
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

      if (response.ok || index === candidates.length - 1) {
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
