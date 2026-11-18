import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAuthStore, loadCliAuthCredentials, resolveCliAuthFilePath } from './auth.js';

describe('CLI auth persistence', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('saves, loads, updates, and clears CLI Bilibili cookie and refreshToken', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'danmakus-cli-auth-'));
    tempDirs.push(dataDir);

    const store = createCliAuthStore(dataDir);
    await expect(store.load()).resolves.toEqual({ cookie: '', refreshToken: '' });

    await store.save({
      cookie: 'SESSDATA=s1; bili_jct=j1',
      refreshToken: 'rt1',
    });

    expect(store.getCookie()).toBe('SESSDATA=s1; bili_jct=j1');
    expect(store.getRefreshToken()).toBe('rt1');

    const reloaded = await loadCliAuthCredentials(dataDir);
    expect(reloaded).toEqual({
      cookie: 'SESSDATA=s1; bili_jct=j1',
      refreshToken: 'rt1',
    });
    expect(resolveCliAuthFilePath(dataDir)).toContain('.danmakus');

    await store.save({ cookie: '', refreshToken: '' });
    await expect(loadCliAuthCredentials(dataDir)).resolves.toEqual({ cookie: '', refreshToken: '' });
  });
});
