export const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://ukamnads.icu';

export const RUNTIME_URL = new URL('/api/v2/core-runtime', API_BASE).toString();
