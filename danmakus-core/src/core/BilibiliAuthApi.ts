import {
  BiliAuthProfile,
  BilibiliQrLoginPollResult,
  BilibiliQrLoginSessionInfo,
} from '../types';
import { mergeCookieJar } from './BilibiliCookie';
import { wrapBilibiliFetch } from './BilibiliUserAgent';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

  private async request(url: string, init?: RequestInit, cookie?: string): Promise<Response> {
    const headers = new Headers(init?.headers ?? {});
    headers.set('Accept', 'application/json, text/plain, */*');
    headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    headers.set('Origin', 'https://www.bilibili.com');
    headers.set('Referer', 'https://www.bilibili.com/');

    const normalizedCookie = cookie?.trim();
    if (normalizedCookie) {
      headers.set('Cookie', normalizedCookie);
    }

    return this.fetchImpl(url, {
      ...init,
      headers,
    });
  }

  private readMergedCookie(currentCookie: string, response: Response): string {
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) {
      return currentCookie;
    }
    return mergeCookieJar(currentCookie, setCookie);
  }
}
