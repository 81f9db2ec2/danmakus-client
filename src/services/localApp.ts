import { isTauri } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { LocalAppConfigDto } from '../types/api';

type TrayHealthState = 'healthy' | 'error' | 'disconnected';
type TrayRuntimeSnapshot = {
  isRunning: boolean;
  runtimeConnected: boolean;
  lastError: string | null;
};

const LOCAL_APP_CONFIG_STORAGE_KEY = 'danmakus.local-app-config.v1';
const MAIN_TRAY_ID = 'main-tray';
const MENU_ID_SHOW = 'tray.show';
const MENU_ID_HIDE = 'tray.hide';
const MENU_ID_QUIT = 'tray.quit';
const MINIMIZE_NOTIFICATION_TITLE = 'Danmakus Client';
const MINIMIZE_NOTIFICATION_BODY = '已最小化到托盘，点击托盘图标可恢复窗口。';
const TRAY_STATUS_COLOR_MAP: Record<TrayHealthState, [number, number, number]> = {
  healthy: [34, 197, 94],
  error: [239, 68, 68],
  disconnected: [59, 130, 246]
};
let traySetupTask: Promise<void> | null = null;
let trayBaseIconRgba: Uint8Array | null = null;
let trayBaseIconWidth = 0;
let trayBaseIconHeight = 0;
let trayCurrentHealthState: TrayHealthState | null = null;

const DEFAULT_LOCAL_APP_CONFIG: LocalAppConfigDto = {
  autoStart: false,
  startMinimized: false,
  minimizeToTray: false,
  cookieCloudKey: '',
  cookieCloudPassword: '',
  cookieCloudHost: '',
  cookieRefreshInterval: 3600,
  capacityOverride: null
};

const normalizeCookieText = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const normalizeCookieHost = (value: unknown): string => {
  const host = normalizeCookieText(value);
  return host ? host.replace(/\/+$/, '') : '';
};

const normalizeCookieRefreshInterval = (value: unknown): number => {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) {
    return DEFAULT_LOCAL_APP_CONFIG.cookieRefreshInterval;
  }
  return Math.max(60, Math.floor(next));
};

const normalizeCapacityOverride = (value: unknown): number | null => {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) {
    return null;
  }
  return Math.min(100, Math.floor(next));
};

const normalizeConfig = (value: unknown): LocalAppConfigDto => {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_LOCAL_APP_CONFIG };
  }
  const raw = value as Partial<LocalAppConfigDto>;
  return {
    autoStart: Boolean(raw.autoStart),
    startMinimized: Boolean(raw.startMinimized),
    minimizeToTray: Boolean(raw.minimizeToTray),
    cookieCloudKey: normalizeCookieText(raw.cookieCloudKey),
    cookieCloudPassword: normalizeCookieText(raw.cookieCloudPassword),
    cookieCloudHost: normalizeCookieHost(raw.cookieCloudHost),
    cookieRefreshInterval: normalizeCookieRefreshInterval(raw.cookieRefreshInterval),
    capacityOverride: normalizeCapacityOverride(raw.capacityOverride)
  };
};

export const isDesktopRuntime = (): boolean => isTauri();

export const loadLocalAppConfig = (): LocalAppConfigDto => {
  try {
    const raw = localStorage.getItem(LOCAL_APP_CONFIG_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_LOCAL_APP_CONFIG };
    }
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LOCAL_APP_CONFIG };
  }
};

export const saveLocalAppConfig = (config: LocalAppConfigDto): void => {
  localStorage.setItem(
    LOCAL_APP_CONFIG_STORAGE_KEY,
    JSON.stringify(normalizeConfig(config))
  );
};

export const readAutoStartEnabled = async (): Promise<boolean | null> => {
  if (!isDesktopRuntime()) {
    return null;
  }
  const autostart = await import('@tauri-apps/plugin-autostart');
  return autostart.isEnabled();
};

export const applyAutoStartEnabled = async (enabled: boolean): Promise<void> => {
  if (!isDesktopRuntime()) {
    return;
  }
  const autostart = await import('@tauri-apps/plugin-autostart');
  const current = await autostart.isEnabled();
  if (current === enabled) {
    return;
  }
  if (enabled) {
    await autostart.enable();
    return;
  }
  await autostart.disable();
};

export const showMainWindow = async (): Promise<void> => {
  if (!isDesktopRuntime()) {
    return;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const window = getCurrentWindow();
  await window.show();
  await window.setFocus();
};

const notifyMinimizedToTray = async (): Promise<void> => {
  const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification');
  let permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    permissionGranted = (await requestPermission()) === 'granted';
  }
  if (!permissionGranted) {
    return;
  }
  sendNotification({
    title: MINIMIZE_NOTIFICATION_TITLE,
    body: MINIMIZE_NOTIFICATION_BODY
  });
};

const cacheBaseTrayIcon = async (
  icon: { rgba: () => Promise<Uint8Array>; size: () => Promise<{ width: number; height: number }> } | null
): Promise<void> => {
  if (!icon) {
    return;
  }

  const size = await icon.size();
  if (size.width <= 0 || size.height <= 0) {
    return;
  }

  trayBaseIconWidth = size.width;
  trayBaseIconHeight = size.height;
  trayBaseIconRgba = await icon.rgba();
};

const ensureBaseTrayIcon = async (): Promise<boolean> => {
  if (trayBaseIconRgba && trayBaseIconWidth > 0 && trayBaseIconHeight > 0) {
    return true;
  }

  const { defaultWindowIcon } = await import('@tauri-apps/api/app');
  const icon = await defaultWindowIcon();
  await cacheBaseTrayIcon(icon);
  return trayBaseIconRgba !== null && trayBaseIconWidth > 0 && trayBaseIconHeight > 0;
};

const renderTrayStatusIconRgba = (status: TrayHealthState): Uint8Array => {
  if (!trayBaseIconRgba || trayBaseIconWidth <= 0 || trayBaseIconHeight <= 0) {
    throw new Error('tray base icon not ready');
  }

  const result = new Uint8Array(trayBaseIconRgba);
  const minSide = Math.min(trayBaseIconWidth, trayBaseIconHeight);
  const rawRadius = Math.round(minSide * 0.18);
  const radius = Math.max(3, Math.min(rawRadius, Math.floor(minSide / 2) - 1));
  const border = Math.max(1, Math.round(radius * 0.28));
  const margin = Math.max(1, Math.round(radius * 0.35));
  const centerX = trayBaseIconWidth - radius - margin;
  const centerY = trayBaseIconHeight - radius - margin;
  const [dotR, dotG, dotB] = TRAY_STATUS_COLOR_MAP[status];

  const startY = Math.max(0, centerY - radius - 1);
  const endY = Math.min(trayBaseIconHeight - 1, centerY + radius + 1);
  const startX = Math.max(0, centerX - radius - 1);
  const endX = Math.min(trayBaseIconWidth - 1, centerX + radius + 1);

  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > radius + 0.15) {
        continue;
      }

      const pixelOffset = (y * trayBaseIconWidth + x) * 4;
      const useBorder = distance >= radius - border;
      result[pixelOffset] = useBorder ? 255 : dotR;
      result[pixelOffset + 1] = useBorder ? 255 : dotG;
      result[pixelOffset + 2] = useBorder ? 255 : dotB;
      result[pixelOffset + 3] = 255;
    }
  }

  return result;
};

const setTrayHealthState = async (nextState: TrayHealthState): Promise<void> => {
  if (!isDesktopRuntime()) {
    return;
  }
  if (trayCurrentHealthState === nextState) {
    return;
  }

  const ready = await ensureBaseTrayIcon();
  if (!ready) {
    return;
  }

  const { TrayIcon } = await import('@tauri-apps/api/tray');
  const tray = await TrayIcon.getById(MAIN_TRAY_ID);
  if (!tray) {
    return;
  }

  const rgba = renderTrayStatusIconRgba(nextState);
  const { Image } = await import('@tauri-apps/api/image');
  const image = await Image.new(rgba, trayBaseIconWidth, trayBaseIconHeight);
  try {
    await tray.setIcon(image);
    trayCurrentHealthState = nextState;
  } finally {
    await image.close();
  }
};

const resolveTrayHealthState = (snapshot: TrayRuntimeSnapshot): TrayHealthState => {
  if (snapshot.isRunning && snapshot.runtimeConnected) {
    return 'healthy';
  }
  if (snapshot.lastError) {
    return 'error';
  }
  return 'disconnected';
};

export const syncTrayHealthFromRuntime = async (snapshot: TrayRuntimeSnapshot): Promise<void> => {
  if (!isDesktopRuntime()) {
    return;
  }
  await setTrayHealthState(resolveTrayHealthState(snapshot));
};

export const hideMainWindow = async (options: { notify?: boolean } = {}): Promise<void> => {
  if (!isDesktopRuntime()) {
    return;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().hide();
  if (options.notify ?? true) {
    await notifyMinimizedToTray();
  }
};

export const toggleMainWindow = async (): Promise<void> => {
  if (!isDesktopRuntime()) {
    return;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const window = getCurrentWindow();
  const visible = await window.isVisible();
  if (visible) {
    await hideMainWindow();
    return;
  }
  await window.show();
  await window.setFocus();
};

export const quitApplication = async (): Promise<void> => {
  if (!isDesktopRuntime()) {
    return;
  }
  const { exit } = await import('@tauri-apps/plugin-process');
  await exit(0);
};

export const registerCloseToTrayHandler = async (
  shouldMinimizeToTray: () => boolean
): Promise<UnlistenFn | null> => {
  if (!isDesktopRuntime()) {
    return null;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const window = getCurrentWindow();
  return window.onCloseRequested(event => {
    if (!shouldMinimizeToTray()) {
      return;
    }
    event.preventDefault();
    void hideMainWindow();
  });
};

export const setupTrayInTs = async (): Promise<void> => {
  if (!isDesktopRuntime()) {
    return;
  }
  if (traySetupTask) {
    return traySetupTask;
  }

  traySetupTask = (async () => {
    const [{ Menu }, { TrayIcon }, { defaultWindowIcon }] = await Promise.all([
      import('@tauri-apps/api/menu'),
      import('@tauri-apps/api/tray'),
      import('@tauri-apps/api/app')
    ]);

    const existingTray = await TrayIcon.getById(MAIN_TRAY_ID);
    if (existingTray) {
      await TrayIcon.removeById(MAIN_TRAY_ID);
    }

    const trayMenu = await Menu.new({
      items: [
        {
          id: MENU_ID_SHOW,
          text: '显示主窗口',
          action: () => {
            void showMainWindow();
          }
        },
        {
          id: MENU_ID_HIDE,
          text: '隐藏到托盘',
          action: () => {
            void hideMainWindow();
          }
        },
        {
          id: MENU_ID_QUIT,
          text: '退出应用',
          action: () => {
            void quitApplication().catch(error => {
              console.error('Failed to quit application from tray menu', error);
            });
          }
        }
      ]
    });

    const icon = await defaultWindowIcon();
    await cacheBaseTrayIcon(icon);
    await TrayIcon.new({
      id: MAIN_TRAY_ID,
      menu: trayMenu,
      icon: icon ?? undefined,
      tooltip: 'Danmakus Client',
      showMenuOnLeftClick: false,
      action: event => {
        if (
          event.type === 'Click' &&
          event.button === 'Left' &&
          event.buttonState === 'Up'
        ) {
          void toggleMainWindow();
        }
      }
    });

    await setTrayHealthState('disconnected');
  })();

  return traySetupTask;
};
