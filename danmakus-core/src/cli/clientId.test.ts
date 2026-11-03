import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolveClientId } from './clientId.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('resolveClientId', () => {
  test('reuses one ID when processes initialize the data directory concurrently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmakus-client-id-'));
    directories.push(directory);

    const clientIds = await Promise.all(Array.from({ length: 8 }, () => resolveClientId(undefined, directory)));

    expect(new Set(clientIds).size).toBe(1);
    expect(await readFile(join(directory, '.danmakus', 'client-id'), 'utf8')).toBe(`${clientIds[0]}\n`);
  });

  test('uses an explicit ID without creating a local ID file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmakus-client-id-'));
    directories.push(directory);

    expect(await resolveClientId(' fixed-node ', directory)).toBe('fixed-node');
    await expect(readFile(join(directory, '.danmakus', 'client-id'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('reuses the saved ID after another startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmakus-client-id-'));
    directories.push(directory);
    const first = await resolveClientId(undefined, directory);
    expect(await resolveClientId(undefined, directory)).toBe(first);
  });

  test('uses the environment ID unless an explicit ID is provided', async () => {
    const previous = process.env.DANMAKUS_CLIENT_ID;
    process.env.DANMAKUS_CLIENT_ID = 'environment-node';
    try {
      expect(await resolveClientId()).toBe('environment-node');
      expect(await resolveClientId('explicit-node')).toBe('explicit-node');
    } finally {
      if (previous === undefined) delete process.env.DANMAKUS_CLIENT_ID;
      else process.env.DANMAKUS_CLIENT_ID = previous;
    }
  });

  test('rejects a damaged identity file instead of silently changing identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmakus-client-id-'));
    directories.push(directory);
    await mkdir(join(directory, '.danmakus'));
    await writeFile(join(directory, '.danmakus', 'client-id'), '');
    await expect(resolveClientId(undefined, directory)).rejects.toThrow('1-128');
  });
});
