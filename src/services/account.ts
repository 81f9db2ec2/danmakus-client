import { apiFetch } from './http';
import type {
  CoreControlConfigDto,
  CoreRuntimeStateDto,
  RecordingInfoDto,
  UserInfo
} from '../types/api';

const ACCOUNT_PREFIX = '/api/v2/account';
const DANMAKU_PREFIX = '/api/v2';

export const getUserInfo = () => apiFetch<UserInfo>(`${ACCOUNT_PREFIX}/info`);

export const getCoreConfig = () => apiFetch<CoreControlConfigDto>(`${ACCOUNT_PREFIX}/core-config`);

export const getRecordingList = () =>
  apiFetch<RecordingInfoDto[]>(`${ACCOUNT_PREFIX}/recording`);

export const addRecording = (uid: number) =>
  apiFetch<RecordingInfoDto>(`${ACCOUNT_PREFIX}/add-record?uId=${encodeURIComponent(String(uid))}`);

export const removeRecording = (uid: number) =>
  apiFetch<unknown>(`${ACCOUNT_PREFIX}/del-record?uId=${encodeURIComponent(String(uid))}`);

export interface UpdateRecordingSettingPayload {
  id: number;
  setting: {
    isPublic: boolean;
  };
}

export const updateRecordingSetting = (payload: UpdateRecordingSettingPayload[]) =>
  apiFetch<number[]>(`${ACCOUNT_PREFIX}/update-recording-setting`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const updateCoreConfig = (config: CoreControlConfigDto) =>
  apiFetch<CoreControlConfigDto>(`${ACCOUNT_PREFIX}/core-config`, {
    method: 'POST',
    body: JSON.stringify(config)
  });

export const getCoreClients = () =>
  apiFetch<CoreRuntimeStateDto[]>(`${ACCOUNT_PREFIX}/core-clients`);

export const syncCoreRuntimeState = (
  payload: Partial<Omit<CoreRuntimeStateDto, 'lastHeartbeat'>> & { clientId: string },
  options?: { force?: boolean }
) =>
  apiFetch<CoreRuntimeStateDto>(`${ACCOUNT_PREFIX}/core-state/sync${options?.force ? '?force=true' : ''}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const getDanmakuAreas = () =>
  apiFetch<Record<string, string[]>>(`${DANMAKU_PREFIX}/area`);
