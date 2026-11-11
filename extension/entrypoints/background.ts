import { fetchBackendApiWithFallback } from 'danmakus-core';
import {
  DANMAKUS_API_ORIGIN,
  DANMAKUS_SITE_ORIGIN,
  type ExtensionMessage,
  type ExtensionRecorderConfig,
  type ExtensionRecorderState,
} from '../utils/types';
import {
  createEmptyRecorderState,
  loadRecorderConfig,
  loadRecorderState,
  saveRecorderConfig,
  saveRecorderState,
} from '../utils/storage';

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';
const KEEPALIVE_ALARM_NAME = 'danmakus_recorder_keepalive';
const BILI_HEADER_RULE_ID = 1001;
const BILI_PROFILE_CACHE_MS = 60_000;
const ACCOUNT_INFO_RETRY_MS = 60_000;
const ALLOWED_API_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** content script 只允许修改的配置项；token、clientId 等只能由 popup 或 danmakus.com 同步修改 */
const CONTENT_SCRIPT_CONFIG_KEYS = new Set<keyof ExtensionRecorderConfig>(['enabled']);
const POPUP_CONFIG_KEYS = new Set<keyof ExtensionRecorderConfig>(['enabled', 'maxRooms', 'accountToken']);

let creatingOffscreen: Promise<void> | null = null;
let appliedCookieHeader: string | null = null;
let lastSavedStateKey: string | null = null;
let accountInfoFailure: { token: string; at: number } | null = null;
let reconcileChain: Promise<unknown> = Promise.resolve();
let cachedBiliProfile: {
  cookieValid: boolean;
  biliUid: number | null;
  biliUname: string | null;
  checkedAt: number;
} = {
  cookieValid: false,
  biliUid: null,
  biliUname: null,
  checkedAt: 0,
};

/**
 * 改写扩展自己发出的 B 站请求头。不限 initiator 会把空间页 Origin 改成 live.bilibili.com，触发 CORS。
 * Cookie 必须显式写入：Chrome 会把扩展发起的请求视为跨站，第三方 Cookie 受限时不会原生附带登录态（nav 返回 -101）。
 * Cookie 按 api.bilibili.com 的 host/path 作用域读取，避免把子域上残留的过期 SESSDATA 混进来覆盖有效值。
 */
async function syncBilibiliHeaderRule(): Promise<string> {
  const cookieHeader = await readBilibiliCookieHeader();
  if (cookieHeader === appliedCookieHeader) return cookieHeader;

  const { HeaderOperation } = chrome.declarativeNetRequest;
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [
    { header: 'Origin', operation: HeaderOperation.SET, value: 'https://live.bilibili.com' },
    { header: 'Referer', operation: HeaderOperation.SET, value: 'https://live.bilibili.com/' },
  ];
  if (cookieHeader) {
    requestHeaders.push({ header: 'Cookie', operation: HeaderOperation.SET, value: cookieHeader });
  }

  // session rules：Cookie 不落盘
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [BILI_HEADER_RULE_ID],
    addRules: [
      {
        id: BILI_HEADER_RULE_ID,
        priority: 1,
        action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders },
        condition: {
          urlFilter: '||bilibili.com/',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
            chrome.declarativeNetRequest.ResourceType.WEBSOCKET,
          ],
        },
      },
    ],
  });
  appliedCookieHeader = cookieHeader;
  return cookieHeader;
}

async function readBilibiliCookieHeader(): Promise<string> {
  const cookies = await chrome.cookies.getAll({ url: 'https://api.bilibili.com/' });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function probeBilibiliAuthProfile(force = false): Promise<{
  cookieValid: boolean;
  biliUid: number | null;
  biliUname: string | null;
}> {
  const now = Date.now();
  if (!force && cachedBiliProfile.checkedAt > 0 && now - cachedBiliProfile.checkedAt < BILI_PROFILE_CACHE_MS) {
    return cachedBiliProfile;
  }

  const cookie = await syncBilibiliHeaderRule();
  if (!cookie.includes('SESSDATA=')) {
    cachedBiliProfile = {
      cookieValid: false,
      biliUid: null,
      biliUname: null,
      checkedAt: now,
    };
    return cachedBiliProfile;
  }

  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      method: 'GET',
      credentials: 'include',
    });
    const payload = (await res.json()) as {
      code?: number;
      data?: { isLogin?: boolean | number; mid?: number; uname?: string };
    };
    const isLogin =
      payload?.code === 0 && (payload.data?.isLogin === true || payload.data?.isLogin === 1);
    const uid = Number(payload?.data?.mid ?? 0);
    if (isLogin && uid > 0) {
      cachedBiliProfile = {
        cookieValid: true,
        biliUid: uid,
        biliUname: payload.data?.uname?.trim() || `UID ${uid}`,
        checkedAt: now,
      };
      return cachedBiliProfile;
    }
  } catch {
    // 网络失败按未验证处理，不能凭 DedeUserID 假定登录有效，否则会掩盖 core 的 Cookie 校验失败
  }

  cachedBiliProfile = {
    cookieValid: false,
    biliUid: null,
    biliUname: null,
    checkedAt: now,
  };
  return cachedBiliProfile;
}

async function hasOffscreenDocument(): Promise<boolean> {
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WEB_RTC, chrome.offscreen.Reason.BLOBS],
      justification: 'Maintain Bilibili live WebSocket connections and upload danmaku packets',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function closeOffscreenDocumentIfExists(): Promise<void> {
  if (!(await hasOffscreenDocument())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // ignore
  }
}

async function updateBadge(state: ExtensionRecorderState, config: ExtensionRecorderConfig): Promise<void> {
  try {
    if (!config.enabled || !state.isRunning) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const count = state.connectedRooms.length;
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({
      color: state.runtimeConnected ? '#10b981' : '#f59e0b',
    });
  } catch {
    // ignore
  }
}

async function syncAccountProfileIfNeeded(
  config: ExtensionRecorderConfig,
  state: ExtensionRecorderState,
): Promise<ExtensionRecorderState> {
  const bili = await probeBilibiliAuthProfile(false);
  const withBili: ExtensionRecorderState = {
    ...state,
    // 以实时探测结果为准，避免 B 站换号后仍沿用存储中的旧账号
    cookieValid: bili.cookieValid || state.cookieValid,
    biliUid: bili.biliUid ?? state.biliUid,
    biliUname: bili.biliUname ?? state.biliUname,
  };

  const token = config.accountToken.trim();
  if (!token) {
    return {
      ...withBili,
      accountId: null,
      accountName: null,
      accountAvatar: null,
    };
  }
  if (withBili.accountId && withBili.accountName) {
    return withBili;
  }
  // 账号信息接口失败后退避，避免每次状态推送都请求后端
  if (
    accountInfoFailure &&
    accountInfoFailure.token === token &&
    Date.now() - accountInfoFailure.at < ACCOUNT_INFO_RETRY_MS
  ) {
    return withBili;
  }
  try {
    const info = await performBackendApiRequest<{
      id: number;
      name?: string;
      avatar?: string | null;
      todayProvidedDanmakuDataCount?: number;
      totalProvidedDanmakuDataCount?: number;
    }>('/api/v2/account/info', { useToken: true });
    accountInfoFailure = null;
    return {
      ...withBili,
      accountId: info.id,
      accountName: info.name ?? `UID ${info.id}`,
      accountAvatar: info.avatar ?? null,
      todayProvidedCount: Number(info.todayProvidedDanmakuDataCount ?? withBili.todayProvidedCount),
      totalProvidedCount: Number(info.totalProvidedDanmakuDataCount ?? withBili.totalProvidedCount),
    };
  } catch {
    accountInfoFailure = { token, at: Date.now() };
    return withBili;
  }
}

/** 仅在状态内容（忽略 updatedAt）变化时写入 storage，避免每次推送都唤醒所有监听页面。 */
async function saveRecorderStateIfChanged(state: ExtensionRecorderState): Promise<void> {
  const { updatedAt: _updatedAt, ...rest } = state;
  const key = JSON.stringify(rest);
  if (key === lastSavedStateKey) return;
  lastSavedStateKey = key;
  await saveRecorderState(state);
}

/** 串行执行，避免 alarm、popup、页面消息并发触发时 offscreen 被重复启动。 */
function reconcileRecorderRuntime(): Promise<ExtensionRecorderState> {
  const run = reconcileChain.then(doReconcileRecorderRuntime, doReconcileRecorderRuntime);
  reconcileChain = run.catch(() => undefined);
  return run;
}

async function doReconcileRecorderRuntime(): Promise<ExtensionRecorderState> {
  const config = await loadRecorderConfig();
  if (!config.enabled || !config.accountToken.trim()) {
    try {
      if (await hasOffscreenDocument()) {
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' } satisfies ExtensionMessage);
      }
    } catch {
      // ignore
    }
    await closeOffscreenDocumentIfExists();
    const empty = await syncAccountProfileIfNeeded(config, createEmptyRecorderState());
    await saveRecorderStateIfChanged(empty);
    await updateBadge(empty, config);
    return empty;
  }

  await ensureOffscreenDocument();
  const biliCookie = await syncBilibiliHeaderRule();
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_OR_UPDATE',
      config,
      biliCookie,
    } satisfies ExtensionMessage)) as { ok: boolean; state?: ExtensionRecorderState } | undefined;
    const baseState = res?.state ?? (await loadRecorderState());
    const nextState = await syncAccountProfileIfNeeded(config, baseState);
    await saveRecorderStateIfChanged(nextState);
    await updateBadge(nextState, config);
    return nextState;
  } catch (err) {
    const fallback: ExtensionRecorderState = {
      ...(await loadRecorderState()),
      lastError: err instanceof Error ? err.message : String(err),
    };
    await saveRecorderStateIfChanged(fallback);
    return fallback;
  }
}

/** 只允许访问后端 /api/ 下的相对路径，防止携带 Token 的请求被导向其他主机。 */
function resolveBackendApiUrl(path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new Error('非法的接口路径');
  }
  const base = new URL(DANMAKUS_API_ORIGIN);
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw new Error('非法的接口路径');
  }
  return url.toString();
}

async function performBackendApiRequest<T>(
  path: string,
  options?: { method?: string; body?: unknown; useToken?: boolean },
): Promise<T> {
  const url = resolveBackendApiUrl(path);
  const method = String(options?.method ?? 'GET').toUpperCase();
  if (!ALLOWED_API_METHODS.has(method)) {
    throw new Error(`不支持的请求方法: ${method}`);
  }

  const config = await loadRecorderConfig();
  const headers = new Headers();
  if (options?.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (options?.useToken !== false && config.accountToken.trim()) {
    headers.set('Token', config.accountToken.trim());
  }

  const response = await fetchBackendApiWithFallback(globalThis.fetch.bind(globalThis), url, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const msg = parsed?.message || `请求失败 (${response.status})`;
    throw new Error(msg);
  }

  if (parsed && typeof parsed === 'object' && 'code' in parsed && 'data' in parsed) {
    if (parsed.code !== 200) {
      throw new Error(parsed.message || `业务错误 (${parsed.code})`);
    }
    return parsed.data as T;
  }

  return parsed as T;
}

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const pickConfigPatch = (
  patch: unknown,
  allowed: ReadonlySet<keyof ExtensionRecorderConfig>,
): Partial<ExtensionRecorderConfig> => {
  const result: Partial<ExtensionRecorderConfig> = {};
  if (!patch || typeof patch !== 'object') return result;
  const source = patch as Record<string, unknown>;
  if (allowed.has('enabled') && typeof source.enabled === 'boolean') {
    result.enabled = source.enabled;
  }
  if (allowed.has('maxRooms') && typeof source.maxRooms === 'number') {
    result.maxRooms = source.maxRooms;
  }
  if (allowed.has('accountToken') && typeof source.accountToken === 'string') {
    result.accountToken = source.accountToken;
  }
  return result;
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

type SenderKind = 'offscreen' | 'extensionPage' | 'contentScript' | 'unknown';

function classifySender(sender: chrome.runtime.MessageSender): SenderKind {
  if (sender.id !== chrome.runtime.id) return 'unknown';
  if (sender.tab) return 'contentScript';
  if (sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)) return 'offscreen';
  if (sender.url?.startsWith(chrome.runtime.getURL('/'))) return 'extensionPage';
  return 'unknown';
}

function isDanmakusSiteSender(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.url) return false;
  try {
    return new URL(sender.url).origin === DANMAKUS_SITE_ORIGIN;
  } catch {
    return false;
  }
}

export default defineBackground(() => {
  // 旧版本曾用持久化的 dynamic rules 写死 Cookie（同 id 1001），实测会盖过 session rules，导致请求一直带作废的 SESSDATA；
  // 本扩展已不使用 dynamic rules，安装/更新时整体清除
  chrome.runtime.onInstalled.addListener(async () => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map((r) => r.id) });
  });

  void reconcileRecorderRuntime();

  chrome.alarms.get(KEEPALIVE_ALARM_NAME).then((existing) => {
    if (!existing) {
      void chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
    }
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) {
      void reconcileRecorderRuntime();
    }
  });

  // B 站会轮换 SESSDATA，DNR 规则里写死的 Cookie 必须随之立即更新，否则请求带的是已作废的旧值（nav -101）
  chrome.cookies.onChanged.addListener(({ cookie }) => {
    if (cookie.domain.endsWith('bilibili.com')) void syncBilibiliHeaderRule();
  });

  chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    const senderKind = classifySender(sender);
    if (senderKind === 'unknown' || !message || typeof message !== 'object') {
      return false;
    }

    if (message.type === 'OFFSCREEN_REQUEST_COOKIE') {
      if (senderKind !== 'offscreen') return false;
      void syncBilibiliHeaderRule().then((cookie) => sendResponse({ cookie }));
      return true;
    }

    if (message.type === 'OFFSCREEN_STATE_PUSH') {
      if (senderKind !== 'offscreen') return false;
      void loadRecorderConfig().then(async (config) => {
        const enrichedState = await syncAccountProfileIfNeeded(config, message.state);
        await saveRecorderStateIfChanged(enrichedState);
        await updateBadge(enrichedState, config);
      });
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'GET_RECORDER_STATE') {
      void Promise.all([loadRecorderConfig(), loadRecorderState()])
        .then(async ([config, state]) => {
          const enriched = await syncAccountProfileIfNeeded(config, state);
          sendResponse({ ok: true, config, state: enriched });
        })
        .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
      return true;
    }

    if (message.type === 'UPDATE_RECORDER_CONFIG') {
      const allowed = senderKind === 'extensionPage' ? POPUP_CONFIG_KEYS : CONTENT_SCRIPT_CONFIG_KEYS;
      const patch = pickConfigPatch(message.patch, allowed);
      void saveRecorderConfig(patch)
        .then(async (config) => {
          const state = await reconcileRecorderRuntime();
          sendResponse({ ok: true, config, state });
        })
        .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
      return true;
    }

    if (message.type === 'SYNC_DANMAKUS_TOKEN') {
      if (senderKind !== 'contentScript' || !isDanmakusSiteSender(sender)) return false;
      const token = typeof message.token === 'string' ? message.token.trim() : '';
      const previousToken =
        typeof message.previousToken === 'string' ? message.previousToken.trim() : '';
      void loadRecorderConfig()
        .then(async (current) => {
          // 站点登录了新账号：同步；站点退出了与扩展相同的账号：清除
          const nextToken =
            token && token !== current.accountToken
              ? token
              : !token && previousToken && previousToken === current.accountToken
                ? ''
                : null;
          if (nextToken === null) {
            sendResponse({ ok: true, synced: false });
            return;
          }
          const config = await saveRecorderConfig({ accountToken: nextToken });
          const state = await reconcileRecorderRuntime();
          sendResponse({ ok: true, synced: true, config, state });
        })
        .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
      return true;
    }

    if (message.type === 'ADD_RECORDING_CHANNEL') {
      if (!isPositiveSafeInteger(message.uid)) {
        sendResponse({ ok: false, error: '非法的 UID' });
        return false;
      }
      void performBackendApiRequest(`/api/v2/account/add-record?uId=${message.uid}`, {
        method: 'GET',
        useToken: true,
      })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;
    }

    if (message.type === 'API_REQUEST') {
      void performBackendApiRequest(message.path, {
        method: message.method,
        body: message.body,
        useToken: message.useToken,
      })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;
    }

    return false;
  });
});
