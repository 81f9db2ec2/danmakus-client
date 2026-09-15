import { fetchImpl } from './fetchImpl';
import { getOrderedApiOrigins, notifyNodeFallback } from './apiNodes';

export const buildDynamicBackendCandidates = (url: string): string[] => {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) return [];

  try {
    const parsed = new URL(normalizedUrl);
    if (!parsed.pathname.startsWith('/api/')) {
      return [parsed.toString()];
    }

    const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    const origins = getOrderedApiOrigins();
    const candidates: string[] = [];
    const seen = new Set<string>();

    for (const origin of origins) {
      const next = new URL(suffix, origin).toString();
      if (!seen.has(next)) {
        seen.add(next);
        candidates.push(next);
      }
    }

    // 确保原始请求的目标也是一个后备
    if (!seen.has(normalizedUrl)) {
      candidates.push(normalizedUrl);
    }

    return candidates;
  } catch {
    return [normalizedUrl];
  }
};

export async function fetchBackendApiWithFallback(
  url: string,
  init?: RequestInit,
  options?: { timeoutMs?: number }
): Promise<Response> {
  const candidates = buildDynamicBackendCandidates(url);
  let lastError: unknown = null;
  const initialOrigin = candidates.length > 0 ? new URL(candidates[0]!).origin : '';

  for (let index = 0; index < candidates.length; index += 1) {
    const candidateUrl = candidates[index]!;
    const candidateOrigin = new URL(candidateUrl).origin;

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

      const timeoutMs = options?.timeoutMs ?? 6000;
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(candidateUrl, {
          ...init,
          signal: controller.signal
        });
      } catch (error) {
        if (timedOut) {
          throw new Error(`API 节点连接超时 (${timeoutMs}ms): ${candidateOrigin}`);
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        sourceSignal?.removeEventListener('abort', handleAbort);
      }

      if (response.ok) {
        // 如果不是第一个首选节点成功的，说明前面的节点挂了，触发故障转移通知
        if (index > 0 && initialOrigin && initialOrigin !== candidateOrigin) {
          notifyNodeFallback(initialOrigin, candidateOrigin);
        }
        return response;
      }

      if (index === candidates.length - 1) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status} (${candidateOrigin})`);
    } catch (error) {
      lastError = error;
      if (index === candidates.length - 1) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('所有后端 API 节点均无法连接');
}
