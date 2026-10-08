import { describe, expect, test } from 'bun:test';
import { AccountApiClient } from './AccountApiClient.js';

describe('AccountApiClient', () => {
  test('getCoreConfig should fallback through api.ukamnads.icu to api.danmakus.com when earlier backends fail', async () => {
    const requests: string[] = [];
    const client = new AccountApiClient(
      'token',
      async (input) => {
        const url = String(input);
        requests.push(url);
        if (!url.startsWith('https://api.danmakus.com/')) {
          return new Response('bad gateway', { status: 502 });
        }

        return new Response(JSON.stringify({
          code: 200,
          data: {
            runtimeUrl: 'https://api.danmakus.com/api/v2/core-runtime',
            areas: {},
            streamers: [],
            desiredRecorders: 15,
          }
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
    );

    const result = await client.getCoreConfig();

    expect(requests).toEqual([
      'https://ukamnads.icu/api/v2/account/core-config',
      'https://api.ukamnads.icu/api/v2/account/core-config',
      'https://api.danmakus.com/api/v2/account/core-config'
    ]);
    expect(result.runtimeUrl).toBe('https://api.danmakus.com/api/v2/core-runtime');
  });

  test('getCoreClients should read from core runtime clients endpoint', async () => {
    let requestUrl = '';
    const client = new AccountApiClient(
      'token',
      async (input) => {
        requestUrl = String(input);
        return new Response(JSON.stringify({
          code: 200,
          data: [{ clientId: 'client-1', isRunning: true }],
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Core-Config-Tag': 'config-tag',
            'X-Core-Clients-Tag': 'clients-tag',
          },
        });
      },
    );

    const result = await client.getCoreClients();
    expect(result.data).toEqual([{ clientId: 'client-1', isRunning: true } as any]);
    expect(result.tags.configTag).toBe('config-tag');
    expect(result.tags.clientsTag).toBe('clients-tag');
    expect(requestUrl).toContain('/clients');
  });
});
