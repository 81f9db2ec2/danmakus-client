import { apiFetch } from './http';

export const getDanmakuAreas = () =>
  apiFetch<Record<string, string[]>>('/api/v2/area');
