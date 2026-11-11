import {
  DanmakuClient,
  createInMemoryLiveSessionOutbox,
  type StreamerStatus,
} from 'danmakus-core';
import {
  DANMAKUS_API_ORIGIN,
  MAX_EXTENSION_ROOMS,
  type ExtensionMessage,
  type ExtensionRecorderConfig,
  type ExtensionRecorderState,
  type RecorderRoomItem,
} from '../../utils/types';
import { clampMaxRooms, createEmptyRecorderState } from '../../utils/storage';
import { version } from '../../package.json';

// offscreen 文档的 chrome.runtime 只暴露消息 API，没有 getManifest；manifest 版本同样取自 package.json
const EXTENSION_VERSION = `extension@${version}`;
const COOKIE_REFRESH_INTERVAL_SECONDS = 300;
/** 向后台刷新 Cookie 的间隔；后台仅在 Cookie 变化时更新 DNR 规则 */
const COOKIE_POLL_INTERVAL_MS = 60_000;
/** 状态推送节流间隔，合并 queueChanged 等高频事件 */
const STATE_PUSH_THROTTLE_MS = 2_000;
/** 无事件时的兜底推送间隔 */
const STATE_PUSH_FALLBACK_INTERVAL_MS = 15_000;

let client: DanmakuClient | null = null;
let currentConfig: ExtensionRecorderConfig | null = null;
let latestBiliCookie = '';
let cookiePollTimer: ReturnType<typeof setInterval> | null = null;
let fallbackPushTimer: ReturnType<typeof setInterval> | null = null;
let pushThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let lastPushAt = 0;
let operationChain: Promise<unknown> = Promise.resolve();

/** 串行执行启动、更新、停止，避免并发调用交错导致重复创建 client 或泄漏定时器。 */
const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
  const run = operationChain.then(task, task);
  operationChain = run.catch(() => undefined);
  return run;
};

const buildStateSnapshot = (): ExtensionRecorderState => {
  if (!client || !currentConfig) {
    return createEmptyRecorderState();
  }

  const rawStatus = client.getStatus();
  const control = client.getControlState();
  const auth = rawStatus.authState;
  const profile = auth?.local?.profile ?? auth?.cookieCloud?.profile ?? null;
  const streamerMap = new Map<number, StreamerStatus>();
  for (const s of rawStatus.streamerStatuses ?? []) {
    streamerMap.set(s.roomId, s);
  }

  const connMap = new Map<number, { priority: string; connectedAt: number }>();
  for (const c of rawStatus.connectionInfo ?? []) {
    connMap.set(c.roomId, { priority: String(c.priority), connectedAt: c.connectedAt });
  }

  const allRoomIds = Array.from(
    new Set([...(rawStatus.holdingRooms ?? []), ...(rawStatus.connectedRooms ?? [])]),
  );

  const rooms: RecorderRoomItem[] = allRoomIds.map((roomId) => {
    const info = streamerMap.get(roomId);
    const conn = connMap.get(roomId);
    return {
      roomId,
      uId: info?.uId,
      uname: info?.username || `房间 ${roomId}`,
      title: info?.title || '',
      face: info?.faceUrl || '',
      areaName: '',
      isLive: info?.isLive ?? true,
      connected: rawStatus.connectedRooms.includes(roomId),
      messageCount: rawStatus.roomMessageCountMap?.[String(roomId)] ?? 0,
      priority: conn?.priority ?? 'server',
    };
  });

  const totalProvided = (control.recordings ?? []).reduce(
    (sum, item) => sum + Number(item.providedDanmakuDataCount ?? 0),
    0,
  );
  const todayProvided = (control.recordings ?? []).reduce(
    (sum, item) => sum + Number(item.todayDanmakusCount ?? 0),
    0,
  );

  return {
    isRunning: Boolean(rawStatus.isRunning),
    runtimeConnected: Boolean(rawStatus.runtimeConnected),
    cookieValid: Boolean(rawStatus.cookieValid),
    biliUid: profile?.uid && profile.uid > 0 ? profile.uid : null,
    biliUname: profile?.uname || null,
    accountId: control.userInfo?.id ?? null,
    accountName: control.userInfo?.name ?? null,
    accountAvatar: null,
    todayProvidedCount: todayProvided,
    totalProvidedCount: totalProvided || Number(control.userInfo?.recievedDanmakusCount ?? 0),
    connectedRooms: [...(rawStatus.connectedRooms ?? [])],
    holdingRooms: [...(rawStatus.holdingRooms ?? [])],
    rooms,
    messageCount: Number(rawStatus.messageCount ?? 0),
    pendingMessageCount: Number(rawStatus.pendingMessageCount ?? 0),
    lastError: rawStatus.lastError ?? null,
    updatedAt: Date.now(),
  };
};

const pushStateNow = () => {
  if (pushThrottleTimer) {
    clearTimeout(pushThrottleTimer);
    pushThrottleTimer = null;
  }
  lastPushAt = Date.now();
  void chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_STATE_PUSH',
      state: buildStateSnapshot(),
    } satisfies ExtensionMessage)
    .catch(() => {
      // ignore if background service worker is temporarily waking
    });
};

/** 节流推送：窗口内的多次事件合并为一次，并保证窗口结束时推送最新状态。 */
const schedulePushState = () => {
  if (pushThrottleTimer) return;
  const wait = Math.max(0, lastPushAt + STATE_PUSH_THROTTLE_MS - Date.now());
  pushThrottleTimer = setTimeout(pushStateNow, wait);
};

const refreshCookieFromBackground = async (): Promise<string> => {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_REQUEST_COOKIE',
    } satisfies ExtensionMessage)) as { cookie?: string } | undefined;
    if (res?.cookie) {
      latestBiliCookie = res.cookie;
    }
  } catch {
    // ignore
  }
  return latestBiliCookie;
};

const clearTimers = () => {
  if (cookiePollTimer) {
    clearInterval(cookiePollTimer);
    cookiePollTimer = null;
  }
  if (fallbackPushTimer) {
    clearInterval(fallbackPushTimer);
    fallbackPushTimer = null;
  }
};

const stopClient = async () => {
  clearTimers();
  const current = client;
  client = null;
  if (current) {
    current.stopControlSync();
    try {
      await current.stop();
    } catch {
      // ignore
    }
    current.dispose();
    current.removeAllListeners();
  }
  pushStateNow();
};

const startOrUpdateClient = async (config: ExtensionRecorderConfig, biliCookie: string) => {
  latestBiliCookie = biliCookie || latestBiliCookie;

  const maxRooms = Math.min(MAX_EXTENSION_ROOMS, clampMaxRooms(config.maxRooms));
  const normalizedConfig: ExtensionRecorderConfig = { ...config, maxRooms };

  if (!normalizedConfig.enabled || !normalizedConfig.accountToken.trim()) {
    currentConfig = normalizedConfig;
    await stopClient();
    return;
  }

  // 只有身份变化才重建：stop() 会清空待上传队列，内存 outbox 也会随实例丢弃
  const needRecreate =
    !client ||
    currentConfig?.accountToken !== normalizedConfig.accountToken ||
    currentConfig?.clientId !== normalizedConfig.clientId;

  currentConfig = normalizedConfig;

  if (!needRecreate && client) {
    client.updateLocalRuntimeConfig({
      capacityOverride: maxRooms,
      cookieRefreshInterval: COOKIE_REFRESH_INTERVAL_SECONDS,
    });
    await client.refreshAuthState({ force: false });
    if (!client.getStatus().isRunning) {
      await client.start();
    }
    schedulePushState();
    return;
  }

  await stopClient();

  const next = new DanmakuClient({
    clientId: normalizedConfig.clientId,
    accountToken: normalizedConfig.accountToken,
    clientVersion: EXTENSION_VERSION,
    runtimeUrl: DANMAKUS_API_ORIGIN,
    maxConnections: maxRooms,
    capacityOverride: maxRooms,
    cookieRefreshInterval: COOKIE_REFRESH_INTERVAL_SECONDS,
    requestServerRooms: true,
    enableClusterPresenceSync: true,
    liveSessionOutbox: createInMemoryLiveSessionOutbox(),
    cookieProvider: () => latestBiliCookie,
    // 浏览器里 fetch 的 Cookie 是禁止头，core 手动设置的会被静默丢弃；
    // 改由浏览器按 host_permissions 附带 B 站登录态（与后台 nav 探测同一条已验证路径）
    fetchImpl: (input, init) => fetch(input, { ...init, credentials: 'include' }),
  });
  client = next;

  next.on('statusChanged', schedulePushState);
  next.on('controlStateChanged', schedulePushState);
  next.on('authStateChanged', schedulePushState);
  next.on('queueChanged', schedulePushState);
  next.on('error', schedulePushState);

  await next.refreshAuthState({ force: true });
  next.startControlSync();
  await next.start();
  pushStateNow();

  cookiePollTimer = setInterval(() => void refreshCookieFromBackground(), COOKIE_POLL_INTERVAL_MS);
  fallbackPushTimer = setInterval(schedulePushState, STATE_PUSH_FALLBACK_INTERVAL_MS);
};

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  // 只接受来自扩展后台（非页面、非 content script）的控制消息
  if (sender.id !== chrome.runtime.id || sender.tab || !message || typeof message !== 'object') {
    return false;
  }

  if (message.type === 'OFFSCREEN_START_OR_UPDATE') {
    void enqueue(() => startOrUpdateClient(message.config, message.biliCookie))
      .then(() => sendResponse({ ok: true, state: buildStateSnapshot() }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          state: buildStateSnapshot(),
        }),
      );
    return true;
  }

  if (message.type === 'OFFSCREEN_STOP') {
    void enqueue(stopClient).then(() => sendResponse({ ok: true, state: buildStateSnapshot() }));
    return true;
  }

  if (message.type === 'OFFSCREEN_GET_SNAPSHOT') {
    sendResponse({ ok: true, state: buildStateSnapshot() });
    return false;
  }

  return false;
});
