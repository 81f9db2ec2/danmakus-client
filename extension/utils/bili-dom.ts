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

const isPositiveSafeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** 同步 B 站页面亮/暗色主题到扩展 ShadowRoot */
export function watchBiliDarkTheme(container: HTMLElement, host?: HTMLElement): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    const isBiliDark =
      document.documentElement.classList.contains('dark') ||
      document.documentElement.getAttribute('data-dark') === 'true' ||
      document.body?.classList.contains('dark') ||
      media.matches;
    container.classList.toggle('dark', isBiliDark);
    host?.classList.toggle('dark', isBiliDark);
  };
  sync();

  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-dark', 'theme'],
  });
  media.addEventListener('change', sync);

  return () => {
    observer.disconnect();
    media.removeEventListener('change', sync);
  };
}

export function attachBiliMainWorldBridge(options: {
  onPageContext?: (ctx: BiliMainWorldPageContext) => void;
  onUserClick?: (user: BiliUserClickDetail) => void;
}): () => void {
  const handlePageContext = (e: Event) => {
    const raw = (e as CustomEvent<BiliMainWorldPageContext>).detail;
    if (!raw || typeof raw !== 'object') return;
    const roomId = isPositiveSafeInt(raw.roomId) ? raw.roomId : null;
    const streamerUid = isPositiveSafeInt(raw.streamerUid) ? raw.streamerUid : null;
    const loginUid = isPositiveSafeInt(raw.loginUid) ? raw.loginUid : null;
    const detail: BiliMainWorldPageContext = {
      href: typeof raw.href === 'string' ? raw.href : window.location.href,
      roomId,
      streamerUid,
      streamerUname: typeof raw.streamerUname === 'string' ? raw.streamerUname : null,
      loginUid,
      loginUname: typeof raw.loginUname === 'string' ? raw.loginUname : null,
    };
    latestMainWorldContext = detail;
    if (roomId && streamerUid) {
      roomInitCache.set(roomId, {
        uid: streamerUid,
        realRoomId: roomId,
      });
    }
    options.onPageContext?.(detail);
  };

  const handleUserClick = (e: Event) => {
    const detail = (e as CustomEvent<BiliUserClickDetail>).detail;
    if (detail && isPositiveSafeInt(detail.uid)) {
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

