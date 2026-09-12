import { fetchBackendApiWithFallback as fetchCoreBackendApi } from 'danmakus-core';
import { fetchImpl } from './fetchImpl';

export const fetchBackendApiWithFallback = (url: string, init?: RequestInit): Promise<Response> =>
  fetchCoreBackendApi(fetchImpl, url, init);
