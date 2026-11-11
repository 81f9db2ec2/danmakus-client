import {
  DEFAULT_EXTENSION_ROOMS,
  MAX_EXTENSION_ROOMS,
  type ExtensionRecorderConfig,
  type ExtensionRecorderState,
} from './types';

const CONFIG_STORAGE_KEY = 'danmakus_ext_recorder_config_v1';
const STATE_STORAGE_KEY = 'danmakus_ext_recorder_state_v1';

const createClientId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `ext_${crypto.randomUUID()}`;
  }
  return `ext_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

export const clampMaxRooms = (value: unknown): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return DEFAULT_EXTENSION_ROOMS;
  }
  return Math.max(1, Math.min(MAX_EXTENSION_ROOMS, Math.floor(num)));
};

export const createDefaultRecorderConfig = (): ExtensionRecorderConfig => ({
  enabled: false,
  maxRooms: DEFAULT_EXTENSION_ROOMS,
  accountToken: '',
  clientId: createClientId(),
});

export const createEmptyRecorderState = (): ExtensionRecorderState => ({
  isRunning: false,
  runtimeConnected: false,
  cookieValid: false,
  biliUid: null,
  biliUname: null,
  accountId: null,
  accountName: null,
  accountAvatar: null,
  todayProvidedCount: 0,
  totalProvidedCount: 0,
  connectedRooms: [],
  holdingRooms: [],
  rooms: [],
  messageCount: 0,
  pendingMessageCount: 0,
  lastError: null,
  updatedAt: Date.now(),
});

export async function loadRecorderConfig(): Promise<ExtensionRecorderConfig> {
  const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
  const raw = stored[CONFIG_STORAGE_KEY] as Partial<ExtensionRecorderConfig> | undefined;
  const fallback = createDefaultRecorderConfig();
  if (!raw || typeof raw !== 'object') {
    await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: fallback });
    return fallback;
  }

  const merged: ExtensionRecorderConfig = {
    enabled: Boolean(raw.enabled),
    maxRooms: clampMaxRooms(raw.maxRooms),
    accountToken: typeof raw.accountToken === 'string' ? raw.accountToken.trim() : '',
    clientId: typeof raw.clientId === 'string' && raw.clientId.trim() ? raw.clientId.trim() : fallback.clientId,
  };

  if (merged.clientId !== raw.clientId || merged.maxRooms !== raw.maxRooms) {
    await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: merged });
  }
  return merged;
}

export async function saveRecorderConfig(
  patch: Partial<ExtensionRecorderConfig>,
): Promise<ExtensionRecorderConfig> {
  const current = await loadRecorderConfig();
  const next: ExtensionRecorderConfig = {
    ...current,
    ...patch,
    maxRooms: patch.maxRooms !== undefined ? clampMaxRooms(patch.maxRooms) : current.maxRooms,
    accountToken:
      patch.accountToken !== undefined ? String(patch.accountToken).trim() : current.accountToken,
  };
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: next });
  return next;
}

export async function loadRecorderState(): Promise<ExtensionRecorderState> {
  const stored = await chrome.storage.local.get(STATE_STORAGE_KEY);
  const raw = stored[STATE_STORAGE_KEY] as ExtensionRecorderState | undefined;
  if (!raw || typeof raw !== 'object') {
    return createEmptyRecorderState();
  }
  return {
    ...createEmptyRecorderState(),
    ...raw,
  };
}

export async function saveRecorderState(state: ExtensionRecorderState): Promise<void> {
  await chrome.storage.local.set({
    [STATE_STORAGE_KEY]: {
      ...state,
      updatedAt: Date.now(),
    },
  });
}

export function onStorageStateChanged(
  callback: (state: ExtensionRecorderState, config: ExtensionRecorderConfig) => void,
): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
    if (areaName !== 'local') return;
    if (changes[STATE_STORAGE_KEY] || changes[CONFIG_STORAGE_KEY]) {
      void Promise.all([loadRecorderState(), loadRecorderConfig()]).then(([state, config]) => {
        callback(state, config);
      });
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
