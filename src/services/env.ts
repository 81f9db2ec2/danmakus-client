export const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://ukamnads.icu';

export const SIGNALR_URL = import.meta.env.VITE_SIGNALR_URL
  ?? new URL('/api/v2/user-hub', API_BASE).toString();

export const ACCOUNT_API_BASE = new URL('/api/v2/account', API_BASE).toString();
