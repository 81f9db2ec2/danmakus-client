import { isTauri } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';

export const APP_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export type AvailableUpdate = {
  version: string;
  notes: string | null;
  date: string | null;
};

const normalizeUpdate = (update: NonNullable<Awaited<ReturnType<typeof check>>>): AvailableUpdate => ({
  version: update.version,
  notes: update.body ?? null,
  date: update.date ?? null
});

export const updaterEnabled = () => isTauri();

export const checkForUpdate = async (): Promise<AvailableUpdate | null> => {
  if (!isTauri()) {
    return null;
  }

  const update = await check();
  if (!update) {
    return null;
  }

  return normalizeUpdate(update);
};

export const installLatestUpdate = async (options?: { relaunchAfterInstall?: boolean }): Promise<AvailableUpdate | null> => {
  if (!isTauri()) {
    throw new Error('当前环境不是 Tauri 桌面端，无法安装更新');
  }

  const update = await check();
  if (!update) {
    return null;
  }

  const normalized = normalizeUpdate(update);
  await update.downloadAndInstall();
  if (options?.relaunchAfterInstall) {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }
  return normalized;
};
