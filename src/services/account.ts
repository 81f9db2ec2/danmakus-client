import { apiFetch } from './http';
import type {
  CoreControlConfigDto,
  CoreRuntimeStateDto,
  UserInfo
} from '../types/api';

const ACCOUNT_PREFIX = '/api/v2/account';

export const getUserInfo = () => apiFetch<UserInfo>(`${ACCOUNT_PREFIX}/info`);

export const getCoreConfig = () => apiFetch<CoreControlConfigDto>(`${ACCOUNT_PREFIX}/core-config`);

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
