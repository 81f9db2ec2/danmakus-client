import { describe, expect, test } from 'bun:test';
import { RuntimeConnection } from './RuntimeConnection.js';

describe('RuntimeConnection 上传地址', () => {
  test('使用构造时传入的 runtimeUrl 作为上传目标', async () => {
    const connection = new RuntimeConnection(
      'https://client.danmakus.com/api/v2/core-runtime',
      true,
      5000,
      { Token: 'token', ClientId: 'client-1' },
    );

    expect(connection.runtimeBaseUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
    expect((connection as any).wsConnection?.options.runtimeUrl).toBe('https://client.danmakus.com/api/v2/core-runtime');
  });

  test('不同 runtimeUrl 切换到不同上传服务器', async () => {
    const connection = new RuntimeConnection(
      'https://upload-2.danmakus.com/api/v2/core-runtime',
      true,
      5000,
      { Token: 'token', ClientId: 'client-1' },
    );

    expect(connection.runtimeBaseUrl).toBe('https://upload-2.danmakus.com/api/v2/core-runtime');
    expect((connection as any).wsConnection?.options.runtimeUrl).toBe('https://upload-2.danmakus.com/api/v2/core-runtime');
  });
});
