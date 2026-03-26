import { ref } from 'vue';
import { API_BASE } from './env';
import { fetchBackendApiWithFallback } from './backendApi';

const authTokenRef = ref('');
const serverLoggedInRef = ref(false);

const tokenStorageKey = 'danmakus_token';

if (typeof localStorage !== 'undefined') {
  authTokenRef.value = localStorage.getItem(tokenStorageKey) ?? '';
}

export const getAuthToken = () => authTokenRef.value;

export { serverLoggedInRef };

export const setServerLoggedIn = (loggedIn: boolean) => {
  serverLoggedInRef.value = loggedIn;
};

export const setAuthToken = (token: string) => {
  const normalizedToken = token.trim();
  if (normalizedToken !== authTokenRef.value) {
    serverLoggedInRef.value = false;
  }
  authTokenRef.value = normalizedToken;
  if (typeof localStorage !== 'undefined') {
    if (authTokenRef.value) {
      localStorage.setItem(tokenStorageKey, authTokenRef.value);
    } else {
      localStorage.removeItem(tokenStorageKey);
    }
  }
};

interface ResponseValue<T> {
  code: number;
  message?: string;
  data: T;
}

const buildUrl = (path: string) => {
  if (/^https?:/i.test(path)) {
    return path;
  }
  return new URL(path, API_BASE).toString();
};

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (authTokenRef.value) {
    headers.set('Token', authTokenRef.value);
  }

  const response = await fetchBackendApiWithFallback(buildUrl(path), {
    ...init,
    headers
  });

  const contentType = response.headers.get('content-type');
  let payload: unknown;

  if (contentType?.includes('application/json')) {
    payload = await response.json();
  } else {
    payload = await response.text();
  }

  if (!response.ok) {
    const reason = typeof payload === 'object' && payload !== null && 'message' in payload
      ? (payload as { message?: string }).message
      : response.statusText;
    throw new Error(reason || '请求失败');
  }

  if (typeof payload === 'object' && payload !== null && 'code' in payload && 'data' in payload) {
    const { code, message, data } = payload as ResponseValue<T>;
    if (code !== 200) {
      throw new Error(message || '请求失败');
    }
    return data;
  }

  return payload as T;
}
