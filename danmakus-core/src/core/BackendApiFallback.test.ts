import { afterEach, describe, expect, test } from 'bun:test';
import {
  BACKEND_API_ORIGINS,
  BACKEND_PRIMARY_ORIGIN,
  buildBackendApiCandidateUrls,
  fetchBackendApiWithFallback,
  setBackendApiFallbackOrigins,
} from './BackendApiFallback.js';

afterEach(() => {
  setBackendApiFallbackOrigins(null);
});

describe('buildBackendApiCandidateUrls', () => {
  test('primary origin is followed by the remaining fallback chain', () => {
    expect(buildBackendApiCandidateUrls(`${BACKEND_PRIMARY_ORIGIN}/api/v2/account/core-config`)).toEqual([
      'https://ukamnads.icu/api/v2/account/core-config',
      'https://api.ukamnads.icu/api/v2/account/core-config',
      'https://api.danmakus.com/api/v2/account/core-config',
    ]);
    expect(BACKEND_API_ORIGINS).toEqual([
      'https://ukamnads.icu',
      'https://api.ukamnads.icu',
      'https://api.danmakus.com',
    ]);
  });

  test('custom origin is tried first, then the full backend chain', () => {
    expect(buildBackendApiCandidateUrls('https://example.com/api/v2/core-runtime/request-room?x=1#y')).toEqual([
      'https://example.com/api/v2/core-runtime/request-room?x=1#y',
      'https://ukamnads.icu/api/v2/core-runtime/request-room?x=1#y',
      'https://api.ukamnads.icu/api/v2/core-runtime/request-room?x=1#y',
      'https://api.danmakus.com/api/v2/core-runtime/request-room?x=1#y',
    ]);
  });

  test('already-on-fallback origin still tries the rest of the chain without duplicating itself', () => {
    expect(buildBackendApiCandidateUrls('https://api.ukamnads.icu/api/v2/account/info')).toEqual([
      'https://api.ukamnads.icu/api/v2/account/info',
      'https://ukamnads.icu/api/v2/account/info',
      'https://api.danmakus.com/api/v2/account/info',
    ]);
  });

  test('non-api paths are not rewritten', () => {
    expect(buildBackendApiCandidateUrls('https://ukamnads.icu/health')).toEqual([
      'https://ukamnads.icu/health',
    ]);
  });

  test('configured preferred origin rewrites official API hosts to that chain first', () => {
    setBackendApiFallbackOrigins([
      'https://proxy.example.com',
      ...BACKEND_API_ORIGINS,
    ]);
    expect(buildBackendApiCandidateUrls('https://ukamnads.icu/api/v2/account/core-config')).toEqual([
      'https://proxy.example.com/api/v2/account/core-config',
      'https://ukamnads.icu/api/v2/account/core-config',
      'https://api.ukamnads.icu/api/v2/account/core-config',
      'https://api.danmakus.com/api/v2/account/core-config',
    ]);
  });

  test('configured origins do not rewrite unrelated runtime hosts', () => {
    setBackendApiFallbackOrigins([
      'https://proxy.example.com',
      ...BACKEND_API_ORIGINS,
    ]);
    expect(buildBackendApiCandidateUrls('https://relay.example.net/api/v2/core-runtime/sync')).toEqual([
      'https://relay.example.net/api/v2/core-runtime/sync',
      'https://proxy.example.com/api/v2/core-runtime/sync',
      'https://ukamnads.icu/api/v2/core-runtime/sync',
      'https://api.ukamnads.icu/api/v2/core-runtime/sync',
      'https://api.danmakus.com/api/v2/core-runtime/sync',
    ]);
  });
});

describe('fetchBackendApiWithFallback', () => {
  test('walks ukamnads.icu → api.ukamnads.icu → api.danmakus.com until one succeeds', async () => {
    const requests: string[] = [];
    const response = await fetchBackendApiWithFallback(
      async (input) => {
        const url = String(input);
        requests.push(url);
        if (url === 'https://api.danmakus.com/api/v2/account/core-config') {
          return new Response('ok', { status: 200 });
        }
        return new Response('bad gateway', { status: 502 });
      },
      'https://ukamnads.icu/api/v2/account/core-config',
    );

    expect(response.ok).toBe(true);
    expect(requests).toEqual([
      'https://ukamnads.icu/api/v2/account/core-config',
      'https://api.ukamnads.icu/api/v2/account/core-config',
      'https://api.danmakus.com/api/v2/account/core-config',
    ]);
  });

  test('walks configured preferred origin before the official chain', async () => {
    setBackendApiFallbackOrigins([
      'https://proxy.example.com',
      ...BACKEND_API_ORIGINS,
    ]);
    const requests: string[] = [];
    const response = await fetchBackendApiWithFallback(
      async (input) => {
        const url = String(input);
        requests.push(url);
        if (url === 'https://proxy.example.com/api/v2/account/core-config') {
          return new Response('ok', { status: 200 });
        }
        return new Response('bad gateway', { status: 502 });
      },
      'https://ukamnads.icu/api/v2/account/core-config',
    );

    expect(response.ok).toBe(true);
    expect(requests).toEqual([
      'https://proxy.example.com/api/v2/account/core-config',
    ]);
  });
});
