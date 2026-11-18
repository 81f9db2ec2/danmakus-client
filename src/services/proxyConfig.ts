import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Proxy as HttpPluginProxy } from '@tauri-apps/plugin-http';
import type { ManualProxyConfigDto, ManualProxyProtocol } from '../types/api';

const LOCAL_APP_CONFIG_STORAGE_KEY = 'danmakus.local-app-config.v1';

export const DEFAULT_MANUAL_PROXY_CONFIG: ManualProxyConfigDto = {
  enabled: false,
  protocol: 'http',
  host: '',
  port: null,
  username: '',
  password: '',
};

let cachedProxyConfig: ManualProxyConfigDto | null = null;

const normalizeProtocol = (value: unknown): ManualProxyProtocol =>
  value === 'socks5' ? 'socks5' : 'http';

const normalizePort = (value: unknown): number | null => {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const integer = Math.floor(parsed);
  if (integer < 1 || integer > 65535) {
    return null;
  }
  return integer;
};

const normalizeHost = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/^\[|\]$/g, '');
};

export const normalizeManualProxyConfig = (value: unknown): ManualProxyConfigDto => {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_MANUAL_PROXY_CONFIG };
  }

  const raw = value as Partial<ManualProxyConfigDto>;
  return {
    enabled: Boolean(raw.enabled),
    protocol: normalizeProtocol(raw.protocol),
    host: normalizeHost(raw.host),
    port: normalizePort(raw.port),
    username: typeof raw.username === 'string' ? raw.username.trim() : '',
    password: typeof raw.password === 'string' ? raw.password : '',
  };
};

/** 支持直接粘贴 http://127.0.0.1:7890 或 127.0.0.1:7890 到主机输入框时自动拆分 */
export const parseProxyAddressInput = (
  raw: string,
  fallbackProtocol: ManualProxyProtocol,
): { protocol: ManualProxyProtocol; host: string; port: number | null } | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const hasScheme = /^[a-z0-9+.-]+:\/\//i.test(trimmed);
  if (!hasScheme && !trimmed.includes(':')) {
    return null;
  }

  try {
    const parsed = new URL(hasScheme ? trimmed : `${fallbackProtocol}://${trimmed}`);
    const protocol: ManualProxyProtocol = parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:'
      ? 'socks5'
      : 'http';
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const port = parsed.port ? normalizePort(parsed.port) : null;
    if (!host) {
      return null;
    }
    return { protocol, host, port };
  } catch {
    return null;
  }
};

export const buildManualProxyUrl = (proxy: ManualProxyConfigDto): string | null => {
  const normalized = normalizeManualProxyConfig(proxy);
  if (!normalized.enabled || !normalized.host || normalized.port === null) {
    return null;
  }

  const formattedHost = normalized.host.includes(':')
    ? `[${normalized.host}]`
    : normalized.host;
  return `${normalized.protocol}://${formattedHost}:${normalized.port}`;
};

export const buildHttpPluginProxyOption = (proxy: ManualProxyConfigDto): HttpPluginProxy | undefined => {
  const normalized = normalizeManualProxyConfig(proxy);
  const url = buildManualProxyUrl(normalized);
  if (!url) {
    return undefined;
  }

  if (normalized.protocol === 'http' && normalized.username) {
    return {
      all: {
        url,
        basicAuth: {
          username: normalized.username,
          password: normalized.password,
        },
      },
    };
  }

  return { all: url };
};

const readStoredProxyConfig = (): ManualProxyConfigDto => {
  if (typeof localStorage === 'undefined') {
    return { ...DEFAULT_MANUAL_PROXY_CONFIG };
  }
  try {
    const raw = localStorage.getItem(LOCAL_APP_CONFIG_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_MANUAL_PROXY_CONFIG };
    }
    const parsed = JSON.parse(raw) as { proxy?: unknown };
    return normalizeManualProxyConfig(parsed?.proxy);
  } catch {
    return { ...DEFAULT_MANUAL_PROXY_CONFIG };
  }
};

export const getCachedProxyConfig = (): ManualProxyConfigDto => {
  if (!cachedProxyConfig) {
    cachedProxyConfig = readStoredProxyConfig();
  }
  return { ...cachedProxyConfig };
};

export const setCachedProxyConfig = (proxy: ManualProxyConfigDto): ManualProxyConfigDto => {
  cachedProxyConfig = normalizeManualProxyConfig(proxy);
  return { ...cachedProxyConfig };
};

export const getActiveProxyUrl = (): string | null =>
  buildManualProxyUrl(getCachedProxyConfig());

export const getActiveHttpPluginProxyOption = (): HttpPluginProxy | undefined =>
  buildHttpPluginProxyOption(getCachedProxyConfig());

export interface DesktopProxyStatus {
  startupProxyUrl: string | null;
  configuredProxyUrl: string | null;
}

export const getDesktopProxyStatus = async (): Promise<DesktopProxyStatus | null> => {
  if (!isTauri()) {
    return null;
  }
  return invoke<DesktopProxyStatus>('get_proxy_status');
};

export const syncDesktopProxyConfig = async (
  proxy: ManualProxyConfigDto,
): Promise<DesktopProxyStatus | null> => {
  const normalized = setCachedProxyConfig(proxy);
  if (!isTauri()) {
    return null;
  }

  const proxyUrl = buildManualProxyUrl(normalized);
  return invoke<DesktopProxyStatus>('set_proxy_config', {
    proxyUrl,
  });
};

export const testManualProxyConnection = async (
  proxy: ManualProxyConfigDto,
  targetUrl = 'https://api.bilibili.com/x/web-interface/nav',
): Promise<{ latencyMs: number; status: number; targetUrl: string }> => {
  if (!isTauri()) {
    throw new Error('仅 Tauri 桌面端支持测试自定义代理');
  }

  const candidate: ManualProxyConfigDto = {
    ...normalizeManualProxyConfig(proxy),
    enabled: true,
  };
  const proxyOption = buildHttpPluginProxyOption(candidate);
  if (!proxyOption) {
    throw new Error('请填写有效的代理主机和端口 (1-65535)');
  }

  const { fetch } = await import('@tauri-apps/plugin-http');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const start = performance.now();

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      proxy: proxyOption,
      signal: controller.signal,
    });
    return {
      latencyMs: Math.round(performance.now() - start),
      status: response.status,
      targetUrl,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('代理连接超时 (8s)');
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
};
