import { describe, expect, test } from 'bun:test';
import { CookieManager } from './CookieManager';

const cookieCloudResponse = {
  cookie_data: {
    'bilibili.com': {
      SESSDATA: {
        name: 'SESSDATA',
        value: 'cookie-value',
        expires: Math.floor(Date.now() / 1000) + 3600
      }
    }
  }
};

describe('CookieManager', () => {
  test('startPeriodicUpdate does not refetch immediately when cookie is still fresh', async () => {
    let fetchCount = 0;
    const manager = new CookieManager(
      'key',
      'password',
      'https://cookie.example.com',
      3600,
      async () => {
        fetchCount++;
        return new Response(JSON.stringify(cookieCloudResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    );

    await manager.updateCookies();
    manager.startPeriodicUpdate();
    await Promise.resolve();
    manager.stopPeriodicUpdate();

    expect(fetchCount).toBe(1);
  });

  test('updateCookies deduplicates concurrent refresh requests', async () => {
    let fetchCount = 0;
    let resolveResponse!: (value: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });

    const manager = new CookieManager(
      'key',
      'password',
      'https://cookie.example.com',
      3600,
      async () => {
        fetchCount++;
        return pendingResponse;
      }
    );

    const first = manager.updateCookies();
    const second = manager.updateCookies();

    expect(fetchCount).toBe(1);

    resolveResponse(new Response(JSON.stringify(cookieCloudResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(fetchCount).toBe(1);
    expect(manager.getCookies()).toContain('SESSDATA=cookie-value');
  });
});
