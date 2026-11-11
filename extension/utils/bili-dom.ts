export interface BiliPageTarget {
  mode: 'live' | 'space' | 'other';
  roomId: number | null;
  streamerUid: number | null;
  spaceUid: number | null;
}

export interface BiliMainWorldPageContext {
  href: string;
  roomId: number | null;
  streamerUid: number | null;
  streamerUname: string | null;
  loginUid: number | null;
  loginUname: string | null;
}

let latestMainWorldContext: BiliMainWorldPageContext | null = null;
let mainWorldListenerAttached = false;

export interface BiliUserClickDetail {
  uid: number;
  uname?: string;
  clientX: number;
  clientY: number;
  altKey?: boolean;
}

export function attachBiliMainWorldBridge(options: {
  onPageContext?: (ctx: BiliMainWorldPageContext) => void;
  onUserClick?: (user: BiliUserClickDetail) => void;
}): () => void {
  const handlePageContext = (e: Event) => {
    const detail = (e as CustomEvent<BiliMainWorldPageContext>).detail;
    if (!detail) return;
    latestMainWorldContext = detail;
    if (detail.roomId && detail.streamerUid) {
      roomInitCache.set(detail.roomId, {
        uid: detail.streamerUid,
        realRoomId: detail.roomId,
      });
    }
    options.onPageContext?.(detail);
  };

  const handleUserClick = (e: Event) => {
    const detail = (e as CustomEvent<BiliUserClickDetail>).detail;
    if (detail && detail.uid > 0) {
      options.onUserClick?.(detail);
    }
  };

  window.addEventListener('danmakus:bili-page-context', handlePageContext);
  window.addEventListener('danmakus:bili-user-click', handleUserClick);
  mainWorldListenerAttached = true;

  // 主动请求一次 MAIN world 当前上下文
  window.dispatchEvent(new CustomEvent('danmakus:request-bili-context'));

  return () => {
    window.removeEventListener('danmakus:bili-page-context', handlePageContext);
    window.removeEventListener('danmakus:bili-user-click', handleUserClick);
  };
}

const roomInitCache = new Map<number, { uid: number; realRoomId: number }>();

export async function resolveBiliRoomOwner(
  shortOrRealRoomId: number,
): Promise<{ uid: number; realRoomId: number } | null> {
  if (!Number.isFinite(shortOrRealRoomId) || shortOrRealRoomId <= 0) {
    return null;
  }
  const cached = roomInitCache.get(shortOrRealRoomId);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${shortOrRealRoomId}`,
      { credentials: 'include' },
    );
    const json = (await res.json()) as {
      code: number;
      data?: { uid?: number; room_id?: number };
    };
    if (json.code === 0 && json.data?.uid && json.data.uid > 0) {
      const info = {
        uid: Number(json.data.uid),
        realRoomId: Number(json.data.room_id || shortOrRealRoomId),
      };
      roomInitCache.set(shortOrRealRoomId, info);
      roomInitCache.set(info.realRoomId, info);
      return info;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function detectCurrentBiliPage(): Promise<BiliPageTarget> {
  const host = window.location.hostname;
  const path = window.location.pathname;

  if (host === 'space.bilibili.com') {
    const match = path.match(/^\/(\d+)/);
    const spaceUid = match ? Number(match[1]) : null;
    return {
      mode: 'space',
      roomId: null,
      streamerUid: spaceUid,
      spaceUid,
    };
  }

  if (host === 'live.bilibili.com') {
    const match = path.match(/^\/(?:blanc\/)?(\d+)/);
    const rawRoomId = match ? Number(match[1]) : null;
    if (rawRoomId && rawRoomId > 0) {
      if (!mainWorldListenerAttached) {
        window.dispatchEvent(new CustomEvent('danmakus:request-bili-context'));
      }
      if (
        latestMainWorldContext &&
        latestMainWorldContext.href === window.location.href &&
        latestMainWorldContext.roomId &&
        latestMainWorldContext.streamerUid
      ) {
        return {
          mode: 'live',
          roomId: latestMainWorldContext.roomId,
          streamerUid: latestMainWorldContext.streamerUid,
          spaceUid: null,
        };
      }
      const resolved = await resolveBiliRoomOwner(rawRoomId);
      return {
        mode: 'live',
        roomId: resolved?.realRoomId ?? rawRoomId,
        streamerUid: resolved?.uid ?? null,
        spaceUid: null,
      };
    }
  }

  return {
    mode: 'other',
    roomId: null,
    streamerUid: null,
    spaceUid: null,
  };
}

