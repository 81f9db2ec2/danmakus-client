import { BACKEND_PRIMARY_ORIGIN } from 'danmakus-core';

export const API_BASE = import.meta.env.VITE_API_BASE ?? BACKEND_PRIMARY_ORIGIN;

export const RUNTIME_URL = new URL('/api/v2/core-runtime', API_BASE).toString();
