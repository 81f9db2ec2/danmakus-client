import { afterEach, describe, expect, test } from 'bun:test';
import { AccountApiClient } from './AccountApiClient.js';
import { resolveCoreRuntimeBaseUrl } from './CoreRuntimeUrl.js';

describe('resolveCoreRuntimeBaseUrl 统一解析', () => {
  test('完整 v2 runtime 地址保持不变', () => {
    expect(resolveCoreRuntimeBaseUrl('https://client.danmakus.com/api/v2/core-runtime'))
      .toBe('https://client.danmakus.com/api/v2/core-runtime');
  });

  test('带尾斜杠/query 被归一化', () => {
    expect(resolveCoreRuntimeBaseUrl('https://client.danmakus.com/api/v2/core-runtime/?token=x'))
      .toBe('https://client.danmakus.com/api/v2/core-runtime');
  });

  test('account 中心地址转换为 core-runtime', () => {
    expect(resolveCoreRuntimeBaseUrl('https://backend.danmakus.com/api/v2/account'))
      .toBe('https://backend.danmakus.com/api/v2/core-runtime');
  });

  test('裸 origin 补全为 v2 路径', () => {
    expect(resolveCoreRuntimeBaseUrl('https://client.danmakus.com'))
      .toBe('https://client.danmakus.com/api/core-runtime');
  });
});

describe('AccountApiClient 运行态地址跟随 runtimeUrl', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('默认指向 backend，setCoreRuntimeBaseUrl 后 sync 打到新地址', async () => {
    const captured: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ code: 200, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new AccountApiClient('token');
    // 默认从 account 中心派生，仍在 backend
    expect(client.getCoreRuntimeBaseUrl()).toBe('https://backend.danmakus.com/api/v2/core-runtime');

    // 服务端下发新 runtimeUrl
    client.setCoreRuntimeBaseUrl('https://client.danmakus.com/api/v2/core-runtime');
    expect(client.getCoreRuntimeBaseUrl()).toBe('https://client.danmakus.com/api/v2/core-runtime');

    await client.syncRuntimeState({ clientId: 'client-1' });

    const syncCall = captured.find(url => url.includes('/sync'));
    expect(syncCall).toBeDefined();
    expect(syncCall!).toStartWith('https://client.danmakus.com/api/v2/core-runtime/sync');
  });

  test('空值回退到 account 中心派生地址', () => {
    const client = new AccountApiClient('token');
    client.setCoreRuntimeBaseUrl('https://client.danmakus.com/api/v2/core-runtime');
    client.setCoreRuntimeBaseUrl('');
    expect(client.getCoreRuntimeBaseUrl()).toBe('https://backend.danmakus.com/api/v2/core-runtime');
  });
});
