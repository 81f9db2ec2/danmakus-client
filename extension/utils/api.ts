import {
  DANMAKUS_SITE_ORIGIN,
  type ChannelDetailResponse,
  type ExtensionMessage,
  type LiveDanmakusPageV3,
  type UserBootstrapResponseV3,
  type UserHistoryResponseV3,
} from './types';
import { decodeDanmakuFrameV3, filterInteractiveDanmakus } from './decoder';

async function sendBgApiRequest<T>(
  path: string,
  options?: { method?: string; body?: unknown; useToken?: boolean },
): Promise<T> {
  const message: ExtensionMessage = {
    type: 'API_REQUEST',
    path,
    method: options?.method ?? 'GET',
    body: options?.body,
    useToken: options?.useToken ?? true,
  };
  const response = (await chrome.runtime.sendMessage(message)) as {
    ok: boolean;
    data?: T;
    error?: string;
  };
  if (!response?.ok) {
    throw new Error(response?.error || '请求 Danmakus 接口失败');
  }
  return response.data as T;
}

function decodeHistory(res: UserHistoryResponseV3) {
  return {
    groups: (res.items ?? []).map((item) => ({
      channel: item.channel,
      live: item.live,
      danmakus: decodeDanmakuFrameV3(item.danmakus, item.live.liveId),
    })),
    total: res.total ?? 0,
    page: res.page,
  };
}

export type UserHistoryPage = ReturnType<typeof decodeHistory>;

function historyParams(page: number, pageSize: number, channelUserId?: number, hideOnlyEnter = false) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    hideOnlyEnter: String(hideOnlyEnter),
  });
  if (channelUserId) params.set('channelUserId', String(channelUserId));
  return params;
}

/** 首屏聚合：第一页历史 + 常看主播 + 曾用名（后端会计入一次用户查询） */
export async function fetchUserBootstrap(uid: number, pageSize: number, channelUserId?: number, hideOnlyEnter = false) {
  const res = await sendBgApiRequest<UserBootstrapResponseV3>(
    `/api/v3/users/${uid}/bootstrap?${historyParams(1, pageSize, channelUserId, hideOnlyEnter)}`,
  );
  return {
    history: decodeHistory(res.history),
    watchedChannels: res.watchedChannels ?? [],
    blocks: res.blocks ?? [],
    historyUserNames: res.historyUserNames ?? [],
  };
}

export type UserBootstrap = Awaited<ReturnType<typeof fetchUserBootstrap>>;

export async function fetchUserHistoryPage(
  uid: number,
  page: number,
  pageSize: number,
  channelUserId?: number,
  hideOnlyEnter = false,
) {
  const res = await sendBgApiRequest<UserHistoryResponseV3>(
    `/api/v3/users/${uid}/history?${historyParams(page, pageSize, channelUserId, hideOnlyEnter)}`,
  );
  return decodeHistory(res);
}

const CARD_CACHE_LIMIT = 60;
const cardRequestCache = new Map<string, Promise<unknown>>();

/** 用户卡片反复悬浮同一个人很常见，同参数复用同一个请求；失败的不缓存以便下次重试，超限淘汰最早的 */
function cachedCardRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  let task = cardRequestCache.get(key) as Promise<T> | undefined;
  if (!task) {
    task = load();
    cardRequestCache.set(key, task);
    task.catch(() => cardRequestCache.delete(key));
    if (cardRequestCache.size > CARD_CACHE_LIMIT) {
      cardRequestCache.delete(cardRequestCache.keys().next().value!);
    }
  }
  return task;
}

export const fetchCardBootstrap = (uid: number, pageSize: number, hideOnlyEnter: boolean) =>
  cachedCardRequest(`boot:${uid}:${pageSize}:${hideOnlyEnter}`, () =>
    fetchUserBootstrap(uid, pageSize, undefined, hideOnlyEnter),
  );

export const fetchCardHistoryPage = (
  uid: number,
  page: number,
  pageSize: number,
  channelUserId: number | undefined,
  hideOnlyEnter: boolean,
) =>
  cachedCardRequest(`hist:${uid}:${page}:${pageSize}:${channelUserId ?? 0}:${hideOnlyEnter}`, () =>
    fetchUserHistoryPage(uid, page, pageSize, channelUserId, hideOnlyEnter),
  );

export async function fetchLiveContextDanmakus(
  liveId: string,
  centerTsMs: number,
  windowSec = 45,
) {
  const res = await sendBgApiRequest<LiveDanmakusPageV3>(
    `/api/v3/lives/${encodeURIComponent(liveId)}/danmakus?includeEnter=false&offset=0&limit=2000`,
  );
  const all = filterInteractiveDanmakus(decodeDanmakuFrameV3(res.frame, liveId));
  const normalizedCenter = centerTsMs < 10_000_000_000 ? centerTsMs * 1000 : centerTsMs;
  const minTs = normalizedCenter - windowSec * 1000;
  const maxTs = normalizedCenter + windowSec * 1000;
  return all.filter((item) => {
    const t = item.sendDate < 10_000_000_000 ? item.sendDate * 1000 : item.sendDate;
    return t >= minTs && t <= maxTs;
  });
}

export async function fetchChannelOverview(uid: number): Promise<ChannelDetailResponse | null> {
  try {
    return await sendBgApiRequest<ChannelDetailResponse>(
      `/api/v2/channel?uId=${uid}&includeLive=true&maxLives=5&includeFansHistory=false`,
    );
  } catch {
    return null;
  }
}

export async function addChannelToAccountRecording(uid: number): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'ADD_RECORDING_CHANNEL',
    uid,
  } satisfies ExtensionMessage)) as { ok: boolean; error?: string };
  if (!response?.ok) {
    throw new Error(response?.error || '收录并添加录制失败');
  }
}

export function getChannelPageUrl(uid: number): string {
  return `${DANMAKUS_SITE_ORIGIN}/channel/${uid}`;
}

export function getLivePageUrl(liveId: string): string {
  return `${DANMAKUS_SITE_ORIGIN}/live/${encodeURIComponent(liveId)}`;
}

export function getUserPageUrl(uid: number): string {
  return `${DANMAKUS_SITE_ORIGIN}/user/${uid}`;
}
