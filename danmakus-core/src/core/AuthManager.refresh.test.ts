import { describe, expect, test } from 'bun:test';
import { AuthManager } from './AuthManager.js';
import { generateBilibiliCorrespondPath } from './BilibiliAuthApi.js';
import { DanmakuClient } from './DanmakuClient.js';
import { createInMemoryLiveSessionOutbox } from './InMemoryLiveSessionOutbox.js';

describe('Bilibili cookie auto-refresh', () => {
  test('generateBilibiliCorrespondPath produces 256-char lowercase hex', async () => {
    const correspondPath = await generateBilibiliCorrespondPath(1700000000000);
    expect(correspondPath).toMatch(/^[0-9a-f]{256}$/);
  });

  test('AuthManager refreshes local cookie before confirm and works even with CookieCloud configured', async () => {
    let localCookie = 'SESSDATA=old_sess; bili_jct=old_jct; DedeUserID=1001';
    let localRefreshToken = 'old_refresh_token';
    const callOrder: string[] = [];

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers ?? {});
      const cookie = headers.get('Cookie') ?? '';

      if (url.startsWith('https://passport.bilibili.com/x/passport-login/web/cookie/info')) {
        callOrder.push('cookie/info');
        expect(cookie).toContain('SESSDATA=old_sess');
        return new Response(JSON.stringify({
          code: 0,
          data: { refresh: true, timestamp: 1700000000123 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.startsWith('https://www.bilibili.com/correspond/1/')) {
        callOrder.push('correspond');
        return new Response('<html><body><div id="1-name">csrf_from_html</div></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      if (url === 'https://passport.bilibili.com/x/passport-login/web/cookie/refresh') {
        callOrder.push('cookie/refresh');
        expect(method).toBe('POST');
        expect(String(init?.body ?? '')).toContain('refresh_csrf=csrf_from_html');
        expect(String(init?.body ?? '')).toContain('refresh_token=old_refresh_token');
        return new Response(JSON.stringify({
          code: 0,
          data: { status: 0, message: '', refresh_token: 'new_refresh_token' },
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'SESSDATA=new_sess; Path=/; HttpOnly, bili_jct=new_jct; Path=/',
          },
        });
      }

      if (url === 'https://passport.bilibili.com/x/passport-login/web/confirm/refresh') {
        callOrder.push('confirm/refresh');
        expect(cookie).toContain('SESSDATA=new_sess');
        expect(String(init?.body ?? '')).toContain('csrf=new_jct');
        expect(String(init?.body ?? '')).toContain('refresh_token=old_refresh_token');
        // New credentials must already be persisted before confirm invalidates the old token.
        expect(localCookie).toContain('SESSDATA=new_sess');
        expect(localRefreshToken).toBe('new_refresh_token');
        return new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://api.bilibili.com/x/web-interface/nav') {
        callOrder.push(`nav:${cookie.includes('SESSDATA=new_sess') ? 'new' : 'old'}`);
        return new Response(JSON.stringify({
          code: 0,
          data: {
            isLogin: true,
            mid: 1001,
            uname: '测试账号',
            face: '',
            money: 0,
            vipStatus: 0,
            vip_label: { text: '' },
            level_info: { current_level: 5 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`unexpected request: ${method} ${url}`);
    };

    const manager = new AuthManager({
      localCookieProvider: () => localCookie,
      localRefreshTokenProvider: () => localRefreshToken,
      onLocalCredentialsRefreshed: (next) => {
        callOrder.push('persist');
        localCookie = next.cookie;
        localRefreshToken = next.refreshToken;
      },
      cookieCloudKey: 'cloud-key',
      cookieCloudPassword: 'cloud-password',
      cookieCloudHost: 'https://cookie.example.com',
      fetchImpl,
    });

    const refreshed = await manager.checkAndRefreshLocalCookie({ force: true });
    expect(refreshed).toBe(true);
    expect(callOrder).toEqual([
      'cookie/info',
      'correspond',
      'cookie/refresh',
      'persist',
      'confirm/refresh',
      'nav:new',
    ]);
    expect(localCookie).toContain('SESSDATA=new_sess');
    expect(localCookie).toContain('bili_jct=new_jct');
    expect(localRefreshToken).toBe('new_refresh_token');
    expect(manager.getState().local.valid).toBe(true);

    manager.dispose();
  });

  test('AuthManager clears dead refreshToken on fatal auth error (-101 / 86095) and stops retrying', async () => {
    let localCookie = 'SESSDATA=dead_sess; bili_jct=dead_jct';
    let localRefreshToken = 'dead_refresh_token';
    let infoCalls = 0;

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://passport.bilibili.com/x/passport-login/web/cookie/info')) {
        infoCalls += 1;
        return new Response(JSON.stringify({ code: -101, message: '账号未登录' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://api.bilibili.com/x/web-interface/nav') {
        return new Response(JSON.stringify({ code: -101, message: '账号未登录' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const manager = new AuthManager({
      localCookieProvider: () => localCookie,
      localRefreshTokenProvider: () => localRefreshToken,
      onLocalCredentialsRefreshed: (next) => {
        localCookie = next.cookie;
        localRefreshToken = next.refreshToken;
      },
      fetchImpl,
    });

    await expect(manager.checkAndRefreshLocalCookie({ force: true })).resolves.toBe(false);
    expect(localRefreshToken).toBe('');
    expect(manager.getState().local.valid).toBe(false);
    expect(manager.getState().local.lastError).toContain('请重新扫码登录');

    await expect(manager.checkAndRefreshLocalCookie({ force: true })).resolves.toBe(false);
    expect(infoCalls).toBe(1);

    manager.dispose();
  });

  test('DanmakuClient startup persists interactiveLoginProvider cookie and refreshToken', async () => {
    const saved: Array<{ cookie: string; refreshToken: string }> = [];
    let currentCookie = '';
    let currentRefreshToken = '';

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://passport.bilibili.com/x/passport-login/web/cookie/info')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { refresh: false, timestamp: 1700000000000 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://api.bilibili.com/x/web-interface/nav') {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            isLogin: true,
            mid: 888,
            uname: '扫码用户',
            face: '',
            money: 1,
            vipStatus: 0,
            vip_label: { text: '' },
            level_info: { current_level: 4 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const client: any = new DanmakuClient({
      clientId: 'cli-test',
      accountToken: 'account-token',
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      cookieProvider: () => currentCookie,
      refreshTokenProvider: () => currentRefreshToken,
      onLocalAuthUpdated: (credentials) => {
        saved.push(credentials);
        currentCookie = credentials.cookie;
        currentRefreshToken = credentials.refreshToken;
      },
      interactiveLoginProvider: async () => ({
        cookie: 'SESSDATA=qr_sess; bili_jct=qr_jct; DedeUserID=888',
        refreshToken: 'qr_refresh_token',
      }),
      fetchImpl,
      liveSessionOutbox: createInMemoryLiveSessionOutbox(),
    });

    await client.ensureCookieReadyForStartup();

    expect(saved).toEqual([{
      cookie: 'SESSDATA=qr_sess; bili_jct=qr_jct; DedeUserID=888',
      refreshToken: 'qr_refresh_token',
    }]);
    expect(client.getActiveBiliCookie()).toBe('SESSDATA=qr_sess; bili_jct=qr_jct; DedeUserID=888');
    client.dispose();
  });
});
