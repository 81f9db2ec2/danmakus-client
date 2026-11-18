import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';
import { BilibiliAuthApi } from '../core/BilibiliAuthApi.js';
import type { LocalAuthCredentials } from '../types/index.js';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

export function resolveCliAuthFilePath(
  dataDirectory = process.env.DANMAKUS_DATA_DIR || process.cwd(),
): string {
  return join(dataDirectory, '.danmakus', 'bili-auth.json');
}

export async function loadCliAuthCredentials(
  dataDirectory = process.env.DANMAKUS_DATA_DIR || process.cwd(),
): Promise<LocalAuthCredentials> {
  const path = resolveCliAuthFilePath(dataDirectory);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LocalAuthCredentials>;
    const cookie = typeof parsed.cookie === 'string' ? parsed.cookie.trim() : '';
    const refreshToken = typeof parsed.refreshToken === 'string' ? parsed.refreshToken.trim() : '';
    return { cookie, refreshToken };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { cookie: '', refreshToken: '' };
    }
    return { cookie: '', refreshToken: '' };
  }
}

export async function saveCliAuthCredentials(
  credentials: LocalAuthCredentials,
  dataDirectory = process.env.DANMAKUS_DATA_DIR || process.cwd(),
): Promise<void> {
  const path = resolveCliAuthFilePath(dataDirectory);
  const cookie = credentials.cookie.trim();
  const refreshToken = credentials.refreshToken.trim();

  if (!cookie && !refreshToken) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  const payload = JSON.stringify({
    cookie,
    refreshToken,
    updatedAt: Date.now(),
  }, null, 2);

  await writeFile(tempPath, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function createCliAuthStore(
  dataDirectory = process.env.DANMAKUS_DATA_DIR || process.cwd(),
) {
  let current: LocalAuthCredentials = { cookie: '', refreshToken: '' };

  return {
    async load(): Promise<LocalAuthCredentials> {
      current = await loadCliAuthCredentials(dataDirectory);
      return { ...current };
    },
    getCookie(): string {
      return current.cookie;
    },
    getRefreshToken(): string {
      return current.refreshToken;
    },
    async save(next: LocalAuthCredentials): Promise<void> {
      current = {
        cookie: next.cookie.trim(),
        refreshToken: next.refreshToken.trim(),
      };
      await saveCliAuthCredentials(current, dataDirectory);
    },
  };
}

export function createCliInteractiveLoginProvider(fetchImpl?: FetchImpl): () => Promise<LocalAuthCredentials> {
  const authApi = new BilibiliAuthApi(fetchImpl);

  return async () => {
    const session = await authApi.createQrLoginSession();
    const { url } = session.getInfo();
    const terminalQr = await QRCode.toString(url, {
      type: 'terminal',
      small: true,
    });

    console.log('未检测到可用的 Bilibili Cookie，开始扫码登录...');
    console.log(terminalQr);
    console.log(`若二维码显示异常，请直接打开：${url}`);

    let previousStatus = '';
    while (true) {
      const result = await session.poll();
      if (result.status !== previousStatus) {
        previousStatus = result.status;
        if (result.status === 'waiting') {
          console.log('请使用哔哩哔哩手机客户端扫码。');
        } else if (result.status === 'scanned') {
          console.log('扫码成功，请在手机上确认。');
        }
      }

      if (result.status === 'confirmed') {
        console.log('扫码登录成功，正在继续启动核心...');
        return {
          cookie: result.cookie,
          refreshToken: result.refreshToken,
        };
      }

      if (result.status === 'expired') {
        throw new Error('二维码已过期，请重新启动客户端后重试');
      }

      if (result.status === 'unknown') {
        throw new Error('扫码登录状态未知，请稍后重试');
      }

      await sleep(2000);
    }
  };
}
