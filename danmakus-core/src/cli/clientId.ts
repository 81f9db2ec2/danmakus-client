import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function validateClientId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 128) throw new Error('Client ID must contain 1-128 characters');
  return id;
}

export async function resolveClientId(
  explicitId?: string,
  dataDirectory = process.env.DANMAKUS_DATA_DIR || process.cwd(),
): Promise<string> {
  const configuredId = explicitId ?? process.env.DANMAKUS_CLIENT_ID;
  if (configuredId !== undefined) return validateClientId(configuredId);
  const directory = join(dataDirectory, '.danmakus');
  const path = join(directory, 'client-id');
  try {
    return validateClientId(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true });
  const clientId = crypto.randomUUID();
  const temporaryPath = join(directory, `client-id.${clientId}.tmp`);
  await writeFile(temporaryPath, `${clientId}\n`, { flag: 'wx' });
  try {
    // Publish a complete file atomically; concurrent processes read the winner.
    await link(temporaryPath, path);
    return clientId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return validateClientId(await readFile(path, 'utf8'));
  } finally {
    await unlink(temporaryPath);
  }
}
