import type {
  CoreControlConfigDto,
  CoreRuntimeStateDto,
  RecordingInfoDto,
  UserInfo
} from '../types/api';
import { API_BASE } from './env';
import { fetchBackendApiWithFallback } from './backendApi';
import { apiFetch, getAuthToken } from './http';

const ACCOUNT_PREFIX = '/api/v2/account';
const CORE_RUNTIME_PREFIX = '/api/v2/core-runtime';
const DANMAKU_PREFIX = '/api/v2';
const HEARTBEAT_FEATURES_HEADER = 'X-Core-Heartbeat-Features';
const CONFIG_TAG_HEADER = 'X-Core-Config-Tag';
const CLIENTS_TAG_HEADER = 'X-Core-Clients-Tag';
const RECORDING_TAG_HEADER = 'X-Core-Recording-Tag';
const HEARTBEAT_FEATURES = 'clients,recording';

interface ResponseValue<T> {
  code: number;
  message?: string;
  data: T;
}

export interface CoreSyncTagSnapshot {
  configTag: string | null;
  clientsTag: string | null;
  recordingTag: string | null;
}

export interface CoreTaggedApiResult<T> {
  data: T;
  tags: CoreSyncTagSnapshot;
}

const buildApiUrl = (path: string) => new URL(path, API_BASE).toString();

const normalizeTag = (value: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const readCoreSyncTags = (headers: Headers): CoreSyncTagSnapshot => ({
  configTag: normalizeTag(headers.get(CONFIG_TAG_HEADER)),
  clientsTag: normalizeTag(headers.get(CLIENTS_TAG_HEADER)),
  recordingTag: normalizeTag(headers.get(RECORDING_TAG_HEADER))
});

const requestApi = async (path: string, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }

  const token = getAuthToken();
  if (token) {
    headers.set('Token', token);
  }

  return fetchBackendApiWithFallback(buildApiUrl(path), {
    ...init,
    headers
  });
};

const parseApiPayload = async <T>(response: Response): Promise<T> => {
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json() as ResponseValue<T> | T
    : await response.text() as T;

  if (!response.ok) {
    const reason = typeof payload === 'object' && payload !== null && 'message' in payload
      ? (payload as ResponseValue<T>).message
      : response.statusText;
    throw new Error(reason || '请求失败');
  }

  if (typeof payload === 'object' && payload !== null && 'code' in payload && 'data' in payload) {
    const typed = payload as ResponseValue<T>;
    if (typed.code !== 200) {
      throw new Error(typed.message || '请求失败');
    }
    return typed.data;
  }

  return payload as T;
};

const requestTaggedApi = async <T>(path: string, init?: RequestInit): Promise<CoreTaggedApiResult<T>> => {
  const response = await requestApi(path, init);
  return {
    data: await parseApiPayload<T>(response),
    tags: readCoreSyncTags(response.headers)
  };
};

const resolveErrorMessage = async (response: Response): Promise<string> => {
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json() as { message?: string }
    : await response.text();

  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    return payload.message || response.statusText || '请求失败';
  }

  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }

  return response.statusText || '请求失败';
};

export const getUserInfo = () => apiFetch<UserInfo>(`${ACCOUNT_PREFIX}/info`);

export const getCoreConfig = () => requestTaggedApi<CoreControlConfigDto>(`${ACCOUNT_PREFIX}/core-config`);

export const getRecordingList = () =>
  requestTaggedApi<RecordingInfoDto[]>(`${ACCOUNT_PREFIX}/recording`);

export const addRecording = (uid: number) =>
  requestTaggedApi<RecordingInfoDto>(`${ACCOUNT_PREFIX}/add-record?uId=${encodeURIComponent(String(uid))}`);

export const removeRecording = (uid: number) =>
  requestTaggedApi<unknown>(`${ACCOUNT_PREFIX}/del-record?uId=${encodeURIComponent(String(uid))}`);

export interface UpdateRecordingSettingPayload {
  id: number;
  setting: {
    isPublic: boolean;
  };
}

export const updateRecordingSetting = (payload: UpdateRecordingSettingPayload[]) =>
  requestTaggedApi<number[]>(`${ACCOUNT_PREFIX}/update-recording-setting`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const updateCoreConfig = (config: CoreControlConfigDto) =>
  requestTaggedApi<CoreControlConfigDto>(`${ACCOUNT_PREFIX}/core-config`, {
    method: 'POST',
    body: JSON.stringify(config)
  });

export const getCoreClients = () =>
  requestTaggedApi<CoreRuntimeStateDto[]>(`${CORE_RUNTIME_PREFIX}/clients`);

export const getCoreHeartbeatTags = async (): Promise<CoreSyncTagSnapshot> => {
  const headers = new Headers();
  headers.set(HEARTBEAT_FEATURES_HEADER, HEARTBEAT_FEATURES);

  const response = await requestApi(`${CORE_RUNTIME_PREFIX}/heartbeat`, {
    method: 'GET',
    headers
  });

  if (!response.ok) {
    throw new Error(await resolveErrorMessage(response));
  }

  return readCoreSyncTags(response.headers);
};

export const syncCoreRuntimeState = (
  payload: Partial<Omit<CoreRuntimeStateDto, 'lastHeartbeat'>> & { clientId: string },
  options?: { force?: boolean }
) =>
  apiFetch<CoreRuntimeStateDto>(`${CORE_RUNTIME_PREFIX}/sync${options?.force ? '?force=true' : ''}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const getDanmakuAreas = () =>
  apiFetch<Record<string, string[]>>(`${DANMAKU_PREFIX}/area`);
