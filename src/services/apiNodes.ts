import { computed, reactive, ref } from 'vue';
import { BACKEND_API_ORIGINS, BACKEND_PRIMARY_ORIGIN } from 'danmakus-core';
import { fetchImpl } from './fetchImpl';

export type NodeHealthStatus = 'idle' | 'testing' | 'ok' | 'slow' | 'error';

export interface ApiNodeInfo {
  origin: string;
  label: string;
  isBuiltin: boolean;
  latencyMs: number | null;
  status: NodeHealthStatus;
  errorMessage?: string;
  lastTestedAt?: number;
}

export interface ApiFallbackAlert {
  failedOrigin: string;
  fallbackOrigin: string;
  timestamp: number;
}

const STORAGE_KEY_PREFERRED = 'danmakus_preferred_api_origin';
const STORAGE_KEY_CUSTOM = 'danmakus_custom_api_nodes';

const BUILTIN_LABELS: Record<string, string> = {
  'https://ukamnads.icu': '官方主节点 (ukamnads.icu)',
  'https://api.ukamnads.icu': '官方镜像节点 1 (api.ukamnads.icu)',
  'https://api.danmakus.com': '官方备用节点 2 (api.danmakus.com)'
};

const normalizeOrigin = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return url.origin;
  } catch {
    return '';
  }
};

const readStorage = (key: string): string | null => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(key);
};

const writeStorage = (key: string, value: string | null) => {
  if (typeof localStorage === 'undefined') return;
  if (value === null) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value);
  }
};

const loadCustomNodesFromStorage = (): string[] => {
  try {
    const raw = readStorage(STORAGE_KEY_CUSTOM);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return Array.from(new Set(parsed.map(normalizeOrigin).filter(Boolean)));
    }
  } catch {
    // ignore
  }
  return [];
};

const loadPreferredFromStorage = (): string | null => {
  const raw = readStorage(STORAGE_KEY_PREFERRED);
  if (!raw || raw === 'auto') return null;
  const normalized = normalizeOrigin(raw);
  return normalized || null;
};

// 响应式状态库
const preferredOriginRef = ref<string | null>(loadPreferredFromStorage());
const customNodesRef = ref<string[]>(loadCustomNodesFromStorage());
const nodeResults = reactive<Map<string, ApiNodeInfo>>(new Map());
const isTestingAll = ref(false);
const activeFallbackAlert = ref<ApiFallbackAlert | null>(null);

// 初始化所有内置和自定义节点
const ensureNodeRegistered = (origin: string, isBuiltin = false) => {
  if (!nodeResults.has(origin)) {
    nodeResults.set(
      origin,
      reactive({
        origin,
        label: BUILTIN_LABELS[origin] || `自定义节点 (${new URL(origin).host})`,
        isBuiltin,
        latencyMs: null,
        status: 'idle'
      })
    );
  }
};

for (const origin of BACKEND_API_ORIGINS) {
  ensureNodeRegistered(origin, true);
}
for (const origin of customNodesRef.value) {
  ensureNodeRegistered(origin, false);
}

// 提取完整节点列表
export const allApiNodes = computed<ApiNodeInfo[]>(() => {
  const list: ApiNodeInfo[] = [];
  for (const origin of BACKEND_API_ORIGINS) {
    const item = nodeResults.get(origin);
    if (item) list.push(item);
  }
  for (const origin of customNodesRef.value) {
    const item = nodeResults.get(origin);
    if (item && !BACKEND_API_ORIGINS.includes(origin as never)) list.push(item);
  }
  return list;
});

// 计算当前最快/推荐的节点
export const fastestHealthyNode = computed<ApiNodeInfo | null>(() => {
  const healthy = allApiNodes.value.filter(
    (n) => (n.status === 'ok' || n.status === 'slow') && typeof n.latencyMs === 'number'
  );
  if (healthy.length === 0) return null;
  return healthy.reduce((fastest, curr) =>
    (curr.latencyMs ?? Infinity) < (fastest.latencyMs ?? Infinity) ? curr : fastest
  );
});

// 计算当前实际生效的 API Origin
export const currentActiveOrigin = computed<string>(() => {
  if (preferredOriginRef.value) {
    return preferredOriginRef.value;
  }
  if (fastestHealthyNode.value) {
    return fastestHealthyNode.value.origin;
  }
  return BACKEND_PRIMARY_ORIGIN;
});

export const isAutoNodeMode = computed<boolean>(() => preferredOriginRef.value === null);

// 测速单个节点
export async function pingApiNode(origin: string, timeoutMs = 4000): Promise<ApiNodeInfo> {
  ensureNodeRegistered(origin, BACKEND_API_ORIGINS.includes(origin as never));
  const node = nodeResults.get(origin)!;
  node.status = 'testing';
  node.errorMessage = undefined;

  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const testUrl = new URL('/api/v2/area', origin).toString();
    const response = await fetchImpl(testUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    clearTimeout(timer);

    const elapsed = Math.round(performance.now() - start);
    node.latencyMs = elapsed;
    node.lastTestedAt = Date.now();

    if (response.ok) {
      node.status = elapsed > 800 ? 'slow' : 'ok';
    } else {
      node.status = 'error';
      node.errorMessage = `HTTP ${response.status}`;
    }
  } catch (error) {
    clearTimeout(timer);
    node.latencyMs = null;
    node.lastTestedAt = Date.now();
    node.status = 'error';
    node.errorMessage = error instanceof Error ? (error.name === 'AbortError' ? '请求超时 (4s)' : error.message) : '连接失败';
  }

  return node;
}

// 并发测速所有节点
export async function pingAllApiNodes(): Promise<void> {
  if (isTestingAll.value) return;
  isTestingAll.value = true;
  try {
    const nodes = allApiNodes.value;
    await Promise.allSettled(nodes.map((node) => pingApiNode(node.origin)));
  } finally {
    isTestingAll.value = false;
  }
}

// 设置偏好节点（null 为自动模式）
export function setPreferredApiOrigin(origin: string | null): void {
  if (origin === null) {
    preferredOriginRef.value = null;
    writeStorage(STORAGE_KEY_PREFERRED, null);
    return;
  }
  const normalized = normalizeOrigin(origin);
  if (!normalized) return;
  preferredOriginRef.value = normalized;
  writeStorage(STORAGE_KEY_PREFERRED, normalized);
}

// 添加自定义节点
export async function addCustomApiNode(rawOrigin: string): Promise<boolean> {
  const normalized = normalizeOrigin(rawOrigin);
  if (!normalized) return false;
  if (customNodesRef.value.includes(normalized) || BACKEND_API_ORIGINS.includes(normalized as never)) {
    return false;
  }

  customNodesRef.value.push(normalized);
  writeStorage(STORAGE_KEY_CUSTOM, JSON.stringify(customNodesRef.value));
  ensureNodeRegistered(normalized, false);
  await pingApiNode(normalized);
  return true;
}

// 删除自定义节点
export function removeCustomApiNode(origin: string): void {
  customNodesRef.value = customNodesRef.value.filter((item) => item !== origin);
  writeStorage(STORAGE_KEY_CUSTOM, JSON.stringify(customNodesRef.value));
  nodeResults.delete(origin);
  if (preferredOriginRef.value === origin) {
    setPreferredApiOrigin(null);
  }
}

// 获取动态构建的候选 Origin 链（优先使用当前生效/首选节点）
export function getOrderedApiOrigins(): string[] {
  const active = currentActiveOrigin.value;
  const candidates: string[] = [active];
  const seen = new Set<string>([active]);

  for (const node of allApiNodes.value) {
    if (!seen.has(node.origin) && node.status !== 'error') {
      seen.add(node.origin);
      candidates.push(node.origin);
    }
  }

  for (const origin of BACKEND_API_ORIGINS) {
    if (!seen.has(origin)) {
      seen.add(origin);
      candidates.push(origin);
    }
  }

  for (const origin of customNodesRef.value) {
    if (!seen.has(origin)) {
      seen.add(origin);
      candidates.push(origin);
    }
  }

  return candidates;
}

// 记录业务调用时节点失败并触发降级提示
export function notifyNodeFallback(failedOrigin: string, nextOrigin: string): void {
  const node = nodeResults.get(failedOrigin);
  if (node) {
    node.status = 'error';
    node.errorMessage = '业务请求失败/超时';
  }

  activeFallbackAlert.value = {
    failedOrigin,
    fallbackOrigin: nextOrigin,
    timestamp: Date.now()
  };
}

export function dismissFallbackAlert(): void {
  activeFallbackAlert.value = null;
}

export {
  preferredOriginRef,
  isTestingAll,
  activeFallbackAlert
};
