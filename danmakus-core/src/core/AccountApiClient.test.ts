import { describe, expect, test } from 'bun:test';
import { AccountApiClient } from './AccountApiClient';

describe('AccountApiClient', () => {
  test('heartbeatRuntimeState should read assignment/config/recording-room tags from headers', async () => {
    const client = new AccountApiClient(
      'token',
      'https://example.com/api/v2/account',
      async () => new Response(null, {
        status: 204,
        headers: {
          'X-Core-Assignment-Tag': 'assignment-tag',
          'X-Core-Config-Tag': '"config-tag"',
          'X-Core-Recording-Rooms-Tag': 'recording-rooms-tag'
        }
      })
    );

    const result = await client.heartbeatRuntimeState({ clientId: 'client-id' });

    expect(result).toEqual({
      assignmentTag: 'assignment-tag',
      configTag: '"config-tag"',
      recordingRoomsTag: 'recording-rooms-tag'
    });
  });

  test('getRecordingRooms should request minimal room list and cache tag', async () => {
    const requests: string[] = [];
    const client = new AccountApiClient(
      'token',
      'https://example.com/api/v2/account',
      async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({
          code: 200,
          data: [1001, 1002, 1002]
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Core-Recording-Rooms-Tag': 'rooms-tag'
          }
        });
      }
    );

    const roomIds = await (client as any).getRecordingRooms();

    expect(requests).toEqual(['https://example.com/api/v2/core-runtime/recording-rooms']);
    expect(roomIds).toEqual([1001, 1002]);
    expect((client as any).getRecordingRoomsTag()).toBe('rooms-tag');
  });
});
