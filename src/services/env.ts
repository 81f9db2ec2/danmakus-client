import { BACKEND_PRIMARY_ORIGIN } from 'danmakus-core';
import { currentActiveOrigin } from './apiNodes';

export const API_BASE = import.meta.env.VITE_API_BASE ?? BACKEND_PRIMARY_ORIGIN;

export const getApiBase = (): string => currentActiveOrigin.value;

export const RUNTIME_URL = new URL('/api/v2/core-runtime', API_BASE).toString();

export const getRuntimeUrl = (): string =>
  new URL('/api/v2/core-runtime', currentActiveOrigin.value).toString();
