import { describe, expect, test } from 'bun:test';
import { AccountApiClient } from './AccountApiClient.js';

describe('AccountApiClient', () => {
  test('heartbeatRuntimeState should read config and assignment tags from headers', async () => {
    let request: RequestInit | undefined;
    const client = new AccountApiClient(
      'token',
      async (_input, init) => {
        request = init;
        return new Response(null, {
        status: 204,
        headers: {
          'X-Core-Config-Tag': '"config-tag"',
          'X-Core-Assignment-Tag': 'assignment-tag',
          'X-Core-Server-Time-Ms': '1710000000000',
        }
        });
      }
    );

    const result = await client.heartbeatRuntimeState({
      clientId: 'client-id',
      clientVersion: '1.0.0',
      isRunning: true,
      runtimeConnected: true,
      cookieValid: true,
      messageCount: 12,
      lastError: null,
    });

    expect(result).toMatchObject({
      configTag: '"config-tag"',
      assignmentTag: 'assignment-tag',
      clientsTag: null,
      recordingTag: null
    });
    expect(result.serverTime.unixMs).toBeGreaterThanOrEqual(1710000000000);
    expect(result.serverTime.monotonicMs).toBeGreaterThanOrEqual(0);
    expect(new Headers(request?.headers).get('X-Core-Heartbeat-Features')).toBe('recording');
  });

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

  test('getCoreHeartbeatTags should include assignment changes', async () => {
    let requestUrl = '';
    const client = new AccountApiClient(
      'token',
      async (input) => {
        requestUrl = String(input);
        return new Response(null, {
        status: 204,
        headers: {
          'X-Core-Config-Tag': 'config-tag',
          'X-Core-Assignment-Tag': 'assignment-tag',
          'X-Core-Recording-Tag': 'recording-tag',
          'X-Core-Server-Time-Ms': '1710000000000',
        },
        });
      },
    );

    const result = await client.getCoreHeartbeatTags('client-id');
    expect(result).toMatchObject({
      configTag: 'config-tag',
      assignmentTag: 'assignment-tag',
      clientsTag: null,
      recordingTag: 'recording-tag',
    });
    expect(result.serverTime.unixMs).toBeGreaterThanOrEqual(1710000000000);
    expect(requestUrl).toContain('/heartbeat?clientId=client-id');
  });
});
