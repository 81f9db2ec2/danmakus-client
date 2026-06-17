import { BilibiliAuthApi, type BiliFollowingUser } from 'danmakus-core';
import type { RecordingChannelDto } from '../types/api';
import { apiFetch } from './http';
import { danmakuService } from './DanmakuService';
import { fetchImpl } from './fetchImpl';

export interface ImportableChannel {
  uid: number;
  uName: string;
  faceUrl: string;
  roomId: number;
  isLiving: boolean;
}

const authApi = new BilibiliAuthApi(fetchImpl);

const chunk = <T>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

/** 当前生效账号的 UID（CookieCloud 或本地扫码，与核心连接一致）；未鉴权时返回 null */
export const getActiveBiliUid = (): number | null => {
  const authState = danmakuService.state.authState;
  const profile = authState.cookieCloud.profile ?? authState.local.profile ?? null;
  return profile?.uid && profile.uid > 0 ? profile.uid : null;
};

/** 拉取当前生效账号的全部关注主播（使用核心当前生效的 Cookie 来源） */
export const fetchBiliFollowings = (): Promise<BiliFollowingUser[]> => {
  const uid = getActiveBiliUid();
  if (!uid) {
    throw new Error('未获取到有效的 Bilibili 账号，请先在 Bilibili 页登录或配置 CookieCloud');
  }
  const cookie = danmakuService.getActiveBiliCookie();
  if (!cookie) {
    throw new Error('当前没有可用的 Bilibili Cookie，请先在 Bilibili 页登录或配置 CookieCloud');
  }
  return authApi.getFollowings(uid, cookie);
};

/** 查询给定 UID 中本站已收录的主播 */
export const queryExistingChannels = async (uids: number[]): Promise<ImportableChannel[]> => {
  const validUids = Array.from(new Set(uids.filter((uid) => Number.isFinite(uid) && uid > 0)));
  if (validUids.length === 0) {
    return [];
  }

  const batches = chunk(validUids, 200);
  const channels = new Map<number, ImportableChannel>();

  for (const ids of batches) {
    const result = await apiFetch<{ data: RecordingChannelDto[] }>('/api/v2/channel/filter', {
      method: 'POST',
      body: JSON.stringify({ ids, pageNum: 0, pageSize: ids.length })
    });

    for (const channel of result.data ?? []) {
      const channelUid = Number(channel.uId);
      if (Number.isFinite(channelUid) && channelUid > 0) {
        channels.set(channelUid, {
          uid: Math.floor(channelUid),
          uName: channel.uName ?? '',
          faceUrl: channel.faceUrl ?? '',
          roomId: Number(channel.roomId ?? 0),
          isLiving: Boolean(channel.isLiving)
        });
      }
    }
  }

  return Array.from(channels.values());
};
