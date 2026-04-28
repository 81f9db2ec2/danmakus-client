export const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://backend.danmakus.com';

export const RUNTIME_URL = new URL('/api/v2/core-runtime', API_BASE).toString();
