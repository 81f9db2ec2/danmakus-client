/**
 * 统一解析 core-runtime 基础地址。
 *
 * 弹幕上传（RuntimeConnection）、运行态同步/心跳（AccountApiClient）、主播状态（StreamerStatusManager）
 * 三处都必须指向同一个 core-runtime 地址。集中到此处避免多处各自解析、漏改导致流量打到不同服务器。
 *
 * 入参可以是完整 runtime 地址、含 /api/v2/ 的地址、或裸 origin；统一归一化为 `<origin>/api/v2/core-runtime`
 * （历史 v1 路径回退为 `/api/core-runtime`）。query/hash 一律剔除。
 */
export const resolveCoreRuntimeBaseUrl = (url: string): string => {
  const normalized = (url ?? '').trim();
  if (!normalized) {
    return normalized;
  }

  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.replace(/\/+$/, '');
    const alreadyNormalized = /\/api\/v2\/core-runtime$/i.test(path)
      || /\/api\/core-runtime$/i.test(path);
    if (!alreadyNormalized) {
      if (/\/account$/i.test(path)) {
        parsed.pathname = path.replace(/\/account$/i, '/core-runtime');
      } else if (/\/api\/v2(\/|$)/i.test(path)) {
        parsed.pathname = '/api/v2/core-runtime';
      } else if (path.length > 0) {
        parsed.pathname = `${path}/core-runtime`;
      } else {
        parsed.pathname = '/api/core-runtime';
      }
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    if (/\/api\/v2\/core-runtime\b/i.test(normalized) || /\/api\/core-runtime\b/i.test(normalized)) {
      return normalized.replace(/\/+$/, '');
    }
    if (/\/account$/i.test(normalized)) {
      return normalized.replace(/\/account$/i, '/core-runtime');
    }
    if (/\/api\/v2(\/|$)/i.test(normalized)) {
      return normalized.replace(/\/api\/v2(?:\/.*)?$/i, '/api/v2/core-runtime');
    }
    return `${normalized.replace(/\/+$/, '')}/api/core-runtime`;
  }
};
