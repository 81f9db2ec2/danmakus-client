const CORE_RUNTIME_PATH = '/api/v2/core-runtime';
const STREAMER_STATUS_PATH = '/api/v2/streamer-status';

/**
 * 统一解析 core-runtime 基础地址。
 *
 * 弹幕上传（RuntimeConnection）、运行态同步/心跳（AccountApiClient）、主播状态（StreamerStatusManager）
 * 三处都必须指向同一个 core-runtime 地址。集中到此处避免多处各自解析、漏改导致流量打到不同服务器。
 *
 * 入参可以是完整 runtime 地址、account 中心地址、或裸 host/origin；与后端 ResolveClientRuntimeUrl 一致，
 * 统一归一化为 `<origin>/api/v2/core-runtime`，query/hash 一律剔除。
 */
export const resolveCoreRuntimeBaseUrl = (url: string): string => {
  const normalized = (url ?? '').trim();
  if (!normalized) {
    return normalized;
  }

  const parsed = new URL(normalized.includes('://') ? normalized : `https://${normalized}`);
  const path = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = path.endsWith(CORE_RUNTIME_PATH)
    ? path
    : /\/account$/i.test(path)
      ? path.replace(/\/account$/i, '/core-runtime')
      : CORE_RUNTIME_PATH;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
};

/** 主播状态接口地址，与 core-runtime 同源同版本前缀。 */
export const resolveStreamerStatusBaseUrl = (url: string): string =>
  resolveCoreRuntimeBaseUrl(url).replace(/\/api\/v2\/core-runtime$/, STREAMER_STATUS_PATH);
