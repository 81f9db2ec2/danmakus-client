import {
  type BiliAuthProfile,
  type BiliFollowingUser,
  type BilibiliQrLoginPollResult,
  type BilibiliQrLoginSessionInfo,
  type LocalAuthCredentials,
} from '../types/index.js';
import { mergeCookieJar, readCookieValue } from './BilibiliCookie.js';
import { wrapBilibiliFetch } from './BilibiliUserAgent.js';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const DEFAULT_BILIBILI_REQUEST_TIMEOUT_MS = 15000;
const BILIBILI_COOKIE_REFRESH_SPKI_BASE64 =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg'
  + 'Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71'
  + 'nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40'
  + 'JNrRuoEUXpabUzGB8QIDAQAB';

let refreshPublicKeyPromise: Promise<CryptoKey> | null = null;

function decodeBase64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getBilibiliRefreshPublicKey(): Promise<CryptoKey> {
  if (!refreshPublicKeyPromise) {
    refreshPublicKeyPromise = crypto.subtle.importKey(
      'spki',
      decodeBase64Bytes(BILIBILI_COOKIE_REFRESH_SPKI_BASE64),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    ).catch((error) => {
      refreshPublicKeyPromise = null;
      throw error;
    });
  }
  return refreshPublicKeyPromise;
}

export async function generateBilibiliCorrespondPath(timestamp: number): Promise<string> {
  const normalizedTimestamp = Math.floor(timestamp);
  if (!Number.isFinite(normalizedTimestamp) || normalizedTimestamp <= 0) {
    throw new Error(`生成 correspondPath 失败: 无效时间戳 ${String(timestamp)}`);
  }

  const publicKey = await getBilibiliRefreshPublicKey();
  const plaintext = new TextEncoder().encode(`refresh_${normalizedTimestamp}`);
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, plaintext);
  return Array.from(new Uint8Array(encrypted), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class BilibiliCookieRefreshError extends Error {
  readonly code?: number;
  readonly isFatalAuthError: boolean;

  constructor(message: string, options: { code?: number; isFatalAuthError?: boolean } = {}) {
    super(message);
    this.name = 'BilibiliCookieRefreshError';
    this.code = options.code;
    this.isFatalAuthError = options.isFatalAuthError === true;
  }
}

export type BilibiliCookieRefreshInfo = {
  loggedIn: boolean;
  refresh: boolean;
  timestamp: number;
};

type BiliNavResponse = {
  code?: unknown;
  message?: unknown;
  data?: {
    isLogin?: unknown;
    mid?: unknown;
    uname?: unknown;
    face?: unknown;
    money?: unknown;
    vipStatus?: unknown;
    vip_label?: { text?: unknown };
    level_info?: { current_level?: unknown };
  };
};

export class BilibiliQrLoginSession {
  constructor(
    private readonly api: BilibiliAuthApi,
    private readonly url: string,
    private readonly qrcodeKey: string,
    private sessionCookie: string,
  ) {}

  getInfo(): BilibiliQrLoginSessionInfo {
    return {
      url: this.url,
      qrcodeKey: this.qrcodeKey,
    };
  }

  async poll(): Promise<BilibiliQrLoginPollResult> {
    const { result, sessionCookie } = await this.api.pollQrLogin(this.qrcodeKey, this.sessionCookie);
    this.sessionCookie = sessionCookie;
    return result;
  }
}

export class BilibiliAuthApi {
  private readonly fetchImpl: FetchImpl;

  constructor(fetchImpl?: FetchImpl) {
    this.fetchImpl = wrapBilibiliFetch(fetchImpl);
  }

  async getNavProfile(cookie: string): Promise<BiliAuthProfile | null> {
    const normalizedCookie = cookie.trim();
    if (!normalizedCookie) {
      return null;
    }

    const response = await this.request('https://api.bilibili.com/x/web-interface/nav', {
      method: 'GET',
    }, normalizedCookie);
    if (!response.ok) {
      throw new Error(`检查 Bilibili 登录状态失败: HTTP ${response.status}`);
    }

    const payload = await response.json() as BiliNavResponse;
    const code = typeof payload.code === 'number' ? payload.code : Number(payload.code);
    if (!Number.isFinite(code)) {
      throw new Error('检查 Bilibili 登录状态失败: nav 返回无效 code');
    }

    if (code !== 0) {
      if (code === -101) {
        return null;
      }
      throw new Error(`检查 Bilibili 登录状态失败: ${String(payload.message ?? code)}`);
    }

    const data = payload.data;
    const isLogin = data?.isLogin === true || data?.isLogin === 1 || data?.isLogin === '1';
    if (!isLogin) {
      return null;
    }

    const uidValue = typeof data?.mid === 'number' ? data.mid : Number(data?.mid);
    if (!Number.isFinite(uidValue) || uidValue <= 0) {
      throw new Error('检查 Bilibili 登录状态失败: nav 返回无效 mid');
    }

    const levelValue = typeof data?.level_info?.current_level === 'number'
      ? data.level_info.current_level
      : Number(data?.level_info?.current_level);
    const moneyValue = typeof data?.money === 'number' ? data.money : Number(data?.money);
    const vipValue = typeof data?.vipStatus === 'number' ? data.vipStatus : Number(data?.vipStatus);

    return {
      uid: Math.floor(uidValue),
      uname: typeof data?.uname === 'string' && data.uname.trim() ? data.uname.trim() : `UID ${Math.floor(uidValue)}`,
      face: typeof data?.face === 'string' ? data.face : '',
      level: Number.isFinite(levelValue) ? Math.floor(levelValue) : 0,
      money: Number.isFinite(moneyValue) ? moneyValue : 0,
      vipStatus: Number.isFinite(vipValue) ? Math.floor(vipValue) : 0,
      vipLabel: typeof data?.vip_label?.text === 'string' ? data.vip_label.text : '',
    };
  }

  async getFollowings(uid: number, cookie: string): Promise<BiliFollowingUser[]> {
    const normalizedCookie = cookie.trim();
    if (!normalizedCookie) {
      throw new Error('获取关注列表失败: 未登录');
    }
    if (!Number.isFinite(uid) || uid <= 0) {
      throw new Error('获取关注列表失败: 无效的 UID');
    }

    const pageSize = 50;
    const maxPages = 20;
    const followings: BiliFollowingUser[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const url = `https://api.bilibili.com/x/relation/followings?vmid=${uid}&ps=${pageSize}&pn=${page}&order=desc&order_type=attention`;
      const response = await this.request(url, { method: 'GET' }, normalizedCookie);
      if (!response.ok) {
        throw new Error(`获取关注列表失败: HTTP ${response.status}`);
      }

      const payload = await response.json() as {
        code?: unknown;
        message?: unknown;
        data?: { list?: Array<{ mid?: unknown; uname?: unknown; face?: unknown }>; total?: unknown };
      };

      const code = Number(payload.code);
      if (code !== 0) {
        if (code === 22115) {
          throw new Error('获取关注列表失败: 该账号的关注列表已设为隐私');
        }
        throw new Error(`获取关注列表失败: ${String(payload.message ?? code)}`);
      }

      const list = Array.isArray(payload.data?.list) ? payload.data.list : [];
      for (const item of list) {
        const followingUid = Number(item.mid);
        if (!Number.isFinite(followingUid) || followingUid <= 0) {
          continue;
        }
        followings.push({
          uid: Math.floor(followingUid),
          uname: typeof item.uname === 'string' ? item.uname : `UID ${Math.floor(followingUid)}`,
          face: typeof item.face === 'string' ? item.face : '',
        });
      }

      if (list.length < pageSize) {
        break;
      }
    }

    return followings;
  }

  async createQrLoginSession(): Promise<BilibiliQrLoginSession> {
    const response = await this.request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      method: 'GET',
    });
    if (!response.ok) {
      const result = await response.text().catch(() => '');
      throw new Error(`获取二维码地址失败${result ? `: ${result}` : ''}`);
    }

    const payload = await response.json() as {
      code?: unknown;
      message?: unknown;
      data?: { url?: unknown; qrcode_key?: unknown };
    };
    if (payload.code !== 0) {
      throw new Error(typeof payload.message === 'string' && payload.message.trim() ? payload.message : '获取二维码地址失败');
    }

    const url = typeof payload.data?.url === 'string' ? payload.data.url.trim() : '';
    const qrcodeKey = typeof payload.data?.qrcode_key === 'string' ? payload.data.qrcode_key.trim() : '';
    if (!url || !qrcodeKey) {
      throw new Error('获取二维码数据失败');
    }

    return new BilibiliQrLoginSession(this, url, qrcodeKey, this.readMergedCookie('', response));
  }

  async pollQrLogin(
    qrcodeKey: string,
    sessionCookie: string,
  ): Promise<{ result: BilibiliQrLoginPollResult; sessionCookie: string }> {
    const response = await this.request(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main-fe-header`,
      { method: 'GET' },
      sessionCookie,
    );

    const nextCookie = this.readMergedCookie(sessionCookie, response);
    const payload = await response.json() as {
      data?: {
        code?: unknown;
        refresh_token?: unknown;
      };
    };
    if (!payload.data) {
      throw new Error('获取登录信息失败');
    }

    if (payload.data.code !== 0) {
      switch (payload.data.code) {
        case 86038:
          return { result: { status: 'expired' }, sessionCookie: nextCookie };
        case 86090:
          return { result: { status: 'scanned' }, sessionCookie: nextCookie };
        case 86101:
          return { result: { status: 'waiting' }, sessionCookie: nextCookie };
        default:
          return { result: { status: 'unknown' }, sessionCookie: nextCookie };
      }
    }

    if (!nextCookie) {
      throw new Error('无法获取 Cookie (Set-Cookie Header missing)');
    }

    return {
      result: {
        status: 'confirmed',
        cookie: nextCookie,
        refreshToken: typeof payload.data.refresh_token === 'string' ? payload.data.refresh_token : '',
      },
      sessionCookie: nextCookie,
    };
  }

  async getCookieRefreshInfo(cookie: string): Promise<BilibiliCookieRefreshInfo> {
    const normalizedCookie = cookie.trim();
    if (!normalizedCookie) {
      return { loggedIn: false, refresh: false, timestamp: 0 };
    }

    const biliJct = readCookieValue(normalizedCookie, 'bili_jct')?.trim() || '';
    const query = biliJct ? `?csrf=${encodeURIComponent(biliJct)}` : '';
    const response = await this.request(
      `https://passport.bilibili.com/x/passport-login/web/cookie/info${query}`,
      { method: 'GET' },
      normalizedCookie,
    );
    if (!response.ok) {
      throw new Error(`检查 Cookie 续期状态失败: HTTP ${response.status}`);
    }

    const payload = await response.json() as {
      code?: unknown;
      message?: unknown;
      data?: { refresh?: unknown; timestamp?: unknown };
    };
    const code = typeof payload.code === 'number' ? payload.code : Number(payload.code);
    if (!Number.isFinite(code)) {
      throw new Error('检查 Cookie 续期状态失败: 返回无效 code');
    }

    if (code === -101) {
      return { loggedIn: false, refresh: false, timestamp: 0 };
    }
    if (code !== 0) {
      throw new BilibiliCookieRefreshError(
        `检查 Cookie 续期状态失败: ${String(payload.message ?? code)}`,
        { code, isFatalAuthError: false },
      );
    }

    const rawRefresh = payload.data?.refresh;
    const refresh = rawRefresh === true || rawRefresh === 1 || rawRefresh === '1';
    const rawTimestamp = typeof payload.data?.timestamp === 'number'
      ? payload.data.timestamp
      : Number(payload.data?.timestamp);
    const timestamp = Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? Math.floor(rawTimestamp) : 0;

    if (refresh && timestamp <= 0) {
      throw new Error('检查 Cookie 续期状态失败: 返回无效 timestamp');
    }

    return { loggedIn: true, refresh, timestamp };
  }

  async getRefreshCsrf(correspondPath: string, cookie: string): Promise<string> {
    const normalizedCookie = cookie.trim();
    const normalizedPath = correspondPath.trim();
    if (!normalizedCookie || !normalizedPath) {
      throw new Error('获取 refresh_csrf 失败: 参数不完整');
    }

    const response = await this.request(
      `https://www.bilibili.com/correspond/1/${encodeURIComponent(normalizedPath)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      normalizedCookie,
    );
    if (!response.ok) {
      throw new Error(`获取 refresh_csrf 失败: HTTP ${response.status}`);
    }

    const html = await response.text();
    const match = html.match(/<div\b[^>]*\bid=["']1-name["'][^>]*>([^<]+)<\/div>/i);
    const refreshCsrf = match?.[1]?.trim() || '';
    if (!refreshCsrf) {
      throw new Error('获取 refresh_csrf 失败: 页面未返回 1-name');
    }
    return refreshCsrf;
  }

  async refreshCookie(
    cookie: string,
    refreshToken: string,
    options?: {
      timestamp?: number;
      onBeforeConfirm?: (credentials: LocalAuthCredentials) => Promise<void> | void;
    },
  ): Promise<LocalAuthCredentials> {
    const normalizedCookie = cookie.trim();
    const normalizedRefreshToken = refreshToken.trim();
    if (!normalizedCookie) {
      throw new BilibiliCookieRefreshError('刷新 Cookie 失败: Cookie 为空', { isFatalAuthError: true });
    }
    if (!normalizedRefreshToken) {
      throw new BilibiliCookieRefreshError('刷新 Cookie 失败: refresh_token 为空', { isFatalAuthError: true });
    }

    const biliJct = readCookieValue(normalizedCookie, 'bili_jct')?.trim() || '';
    if (!biliJct) {
      throw new BilibiliCookieRefreshError('刷新 Cookie 失败: Cookie 缺少 bili_jct', { isFatalAuthError: true });
    }

    let timestamp = options?.timestamp && options.timestamp > 0 ? Math.floor(options.timestamp) : 0;
    if (timestamp <= 0) {
      const info = await this.getCookieRefreshInfo(normalizedCookie);
      if (!info.loggedIn) {
        throw new BilibiliCookieRefreshError('刷新 Cookie 失败: 登录状态已失效', {
          code: -101,
          isFatalAuthError: true,
        });
      }
      timestamp = info.timestamp > 0 ? info.timestamp : Date.now();
    }
    const correspondPath = await generateBilibiliCorrespondPath(timestamp);
    const refreshCsrf = await this.getRefreshCsrf(correspondPath, normalizedCookie);

    const body = new URLSearchParams({
      csrf: biliJct,
      refresh_csrf: refreshCsrf,
      source: 'main_web',
      refresh_token: normalizedRefreshToken,
    }).toString();

    const response = await this.request(
      'https://passport.bilibili.com/x/passport-login/web/cookie/refresh',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
      normalizedCookie,
    );
    if (!response.ok) {
      throw new Error(`刷新 Cookie 失败: HTTP ${response.status}`);
    }

    const payload = await response.json() as {
      code?: unknown;
      message?: unknown;
      data?: {
        status?: unknown;
        message?: unknown;
        refresh_token?: unknown;
      };
    };
    const code = typeof payload.code === 'number' ? payload.code : Number(payload.code);
    if (!Number.isFinite(code)) {
      throw new Error('刷新 Cookie 失败: 返回无效 code');
    }
    if (code !== 0) {
      const isFatalAuthError = code === -101 || code === 86095;
      throw new BilibiliCookieRefreshError(
        `刷新 Cookie 失败: ${String(payload.message ?? payload.data?.message ?? code)}`,
        { code, isFatalAuthError },
      );
    }

    const nextRefreshToken = typeof payload.data?.refresh_token === 'string'
      ? payload.data.refresh_token.trim()
      : '';
    if (!nextRefreshToken) {
      throw new Error('刷新 Cookie 失败: 响应未返回新的 refresh_token');
    }

    const setCookies = this.readSetCookieHeaders(response);
    if (setCookies.length === 0) {
      throw new Error('刷新 Cookie 失败: 响应未包含 Set-Cookie');
    }

    const nextCookie = this.readMergedCookie(normalizedCookie, response);
    const nextCredentials: LocalAuthCredentials = {
      cookie: nextCookie,
      refreshToken: nextRefreshToken,
    };

    // 先落盘新凭证再确认旧 token 失效，避免 confirm 成功后本地仍残留旧凭据。
    await options?.onBeforeConfirm?.(nextCredentials);

    try {
      await this.confirmCookieRefresh(nextCookie, normalizedRefreshToken);
    } catch {
      // 新 Cookie 与新 refresh_token 已生效，confirm 失败不回滚已更新的本地凭据。
    }

    return nextCredentials;
  }

  async confirmCookieRefresh(cookie: string, oldRefreshToken: string): Promise<void> {
    const normalizedCookie = cookie.trim();
    const normalizedOldToken = oldRefreshToken.trim();
    const csrf = readCookieValue(normalizedCookie, 'bili_jct')?.trim() || '';
    if (!normalizedCookie || !normalizedOldToken || !csrf) {
      throw new Error('确认 Cookie 刷新失败: 参数不完整');
    }

    const body = new URLSearchParams({
      csrf,
      refresh_token: normalizedOldToken,
    }).toString();

    const response = await this.request(
      'https://passport.bilibili.com/x/passport-login/web/confirm/refresh',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
      normalizedCookie,
    );
    if (!response.ok) {
      throw new Error(`确认 Cookie 刷新失败: HTTP ${response.status}`);
    }

    const payload = await response.json() as { code?: unknown; message?: unknown };
    const code = typeof payload.code === 'number' ? payload.code : Number(payload.code);
    if (code !== 0) {
      throw new Error(`确认 Cookie 刷新失败: ${String(payload.message ?? code)}`);
    }
  }

  private async request(url: string, init?: RequestInit, cookie?: string): Promise<Response> {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json, text/plain, */*');
    }
    headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    headers.set('Origin', 'https://www.bilibili.com');
    headers.set('Referer', 'https://www.bilibili.com/');

    const normalizedCookie = cookie?.trim();
    if (normalizedCookie) {
      headers.set('Cookie', normalizedCookie);
    }

    const controller = new AbortController();
    const sourceSignal = init?.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const handleAbort = () => {
      controller.abort(sourceSignal?.reason);
    };

    if (sourceSignal) {
      if (sourceSignal.aborted) {
        controller.abort(sourceSignal.reason);
      } else {
        sourceSignal.addEventListener('abort', handleAbort, { once: true });
      }
    }

    timeoutId = setTimeout(() => {
      controller.abort(new Error(`Bilibili 请求超时(${DEFAULT_BILIBILI_REQUEST_TIMEOUT_MS}ms): ${url}`));
    }, DEFAULT_BILIBILI_REQUEST_TIMEOUT_MS);

    try {
      return await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
      sourceSignal?.removeEventListener('abort', handleAbort);
    }
  }

  private readSetCookieHeaders(response: Response): string[] {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie === 'function') {
      const list = headers.getSetCookie().filter((item) => typeof item === 'string' && item.trim().length > 0);
      if (list.length > 0) {
        return list;
      }
    }

    const single = response.headers.get('set-cookie');
    return single && single.trim() ? [single] : [];
  }

  private readMergedCookie(currentCookie: string, response: Response): string {
    const setCookies = this.readSetCookieHeaders(response);
    if (setCookies.length === 0) {
      return currentCookie;
    }

    let merged = currentCookie;
    for (const setCookie of setCookies) {
      merged = mergeCookieJar(merged, setCookie);
    }
    return merged;
  }
}
