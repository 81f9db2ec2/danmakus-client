import { describe, expect, test } from 'bun:test';
import { AccountApiClient } from './AccountApiClient';

describe('AccountApiClient', () => {
  test('heartbeatRuntimeState should read config and assignment tags from headers', async () => {
    const client = new AccountApiClient(
      'token',
      'https://example.com/api/v2/account',
      async () => new Response(null, {
        status: 204,
        headers: {
          'X-Core-Config-Tag': '"config-tag"',
          'X-Core-Assignment-Tag': 'assignment-tag'
        }
      })
    );

    const result = await client.heartbeatRuntimeState({ clientId: 'client-id' });

    expect(result).toEqual({
      configTag: '"config-tag"',
      assignmentTag: 'assignment-tag'
    });
  });

  test('getCoreConfig should fallback to api.danmakus.com when primary account api fails', async () => {
    const requests: string[] = [];
    const client = new AccountApiClient(
      'token',
      'https://example.com/api/v2/account',
      async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.startsWith('https://example.com/')) {
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
      'https://example.com/api/v2/account/core-config',
      'https://api.danmakus.com/api/v2/account/core-config'
    ]);
    expect(result.runtimeUrl).toBe('https://api.danmakus.com/api/v2/core-runtime');
  });
});
