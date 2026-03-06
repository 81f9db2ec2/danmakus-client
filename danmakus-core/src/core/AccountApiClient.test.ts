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
});
