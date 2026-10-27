import { describe, expect, it } from 'bun:test';
import {
  getStartupBilibiliUserAgent,
  getStartupBilibiliClientHints,
  populateBilibiliBrowserHeaders,
  wrapBilibiliFetch,
} from './BilibiliUserAgent.js';

describe('BilibiliUserAgent', () => {
  it('generates a realistic Chrome UA from known version pool', () => {
    const ua = getStartupBilibiliUserAgent();
    expect(ua).toMatch(/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/1[23][0-9]\.0\.[0-9]+\.[0-9]+ Safari\/537\.36$/);
  });

  it('provides matching Client Hints', () => {
    const hints = getStartupBilibiliClientHints();
    expect(hints['Sec-Ch-Ua-Mobile']).toBe('?0');
    expect(hints['Sec-Ch-Ua-Platform']).toBe('"Windows"');
    expect(hints['Sec-Fetch-Dest']).toBe('empty');
    expect(hints['Sec-Fetch-Mode']).toBe('cors');
    expect(hints['Sec-Fetch-Site']).toBe('same-site');
    expect(hints['Sec-Ch-Ua']).toContain('Chromium');
    expect(hints['Sec-Ch-Ua']).toContain('Google Chrome');
  });

  it('populates full browser headers onto Headers object', () => {
    const headers = new Headers();
    populateBilibiliBrowserHeaders(headers);

    expect(headers.get('User-Agent')).toBe(getStartupBilibiliUserAgent());
    expect(headers.get('Accept')).toBe('application/json, text/plain, */*');
    expect(headers.get('Origin')).toBe('https://www.bilibili.com');
    expect(headers.get('Referer')).toBe('https://www.bilibili.com/');
    expect(headers.get('Sec-Ch-Ua-Mobile')).toBe('?0');
    expect(headers.get('Sec-Ch-Ua-Platform')).toBe('"Windows"');
    expect(headers.get('Sec-Fetch-Site')).toBe('same-site');
  });

  it('wrapBilibiliFetch attaches browser headers to bilibili domains only', async () => {
    let capturedHeaders: Headers | undefined;
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response('{}', { status: 200 });
    };

    const wrapped = wrapBilibiliFetch(mockFetch as any);

    // Call bilibili.com
    await wrapped('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=123');
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.get('User-Agent')).toBe(getStartupBilibiliUserAgent());
    expect(capturedHeaders?.get('Sec-Ch-Ua-Platform')).toBe('"Windows"');
    expect(capturedHeaders?.get('Sec-Fetch-Site')).toBe('same-site');

    // Call non-bilibili domain
    capturedHeaders = undefined;
    await wrapped('https://example.com/api');
    expect(capturedHeaders?.get('User-Agent')).toBeNull();
  });
});
