import { CoreControlConfigDto, CoreRuntimeStateDto, ResponseValue } from '../types';

export class AccountApiClient {
  private fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(
    private token: string,
    private baseUrl: string = 'https://ukamnads.icu/api/v2/account',
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async getCoreConfig(): Promise<CoreControlConfigDto> {
    return this.request<CoreControlConfigDto>('/core-config');
  }

  async getRuntimeState(): Promise<CoreRuntimeStateDto | null> {
    return this.request<CoreRuntimeStateDto | null>('/core-state');
  }

  async syncRuntimeState(
    payload: Partial<CoreRuntimeStateDto> & { clientId: string },
    options?: { force?: boolean }
  ): Promise<CoreRuntimeStateDto> {
    const suffix = options?.force ? '?force=true' : '';
    return this.request<CoreRuntimeStateDto>(`/core-state/sync${suffix}` , {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async releaseRuntimeState(clientId: string): Promise<void> {
    await this.request(`/core-state?clientId=${encodeURIComponent(clientId)}`, {
      method: 'DELETE'
    });
  }

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers ?? {});
    headers.set('Token', this.token);
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers
    });

    const contentType = response.headers.get('content-type');
    const isJson = contentType?.includes('application/json');
    const payload: ResponseValue<T> | T = isJson ? await response.json() : await response.text() as any;

    if (!response.ok) {
      const message = typeof payload === 'object' && payload && 'message' in payload
        ? (payload as ResponseValue<T>).message
        : response.statusText;
      throw new Error(message || '请求失败');
    }

    if (payload && typeof payload === 'object' && 'code' in payload && 'data' in payload) {
      const typed = payload as ResponseValue<T>;
      if (typed.code !== 200) {
        throw new Error(typed.message || '请求失败');
      }
      return typed.data;
    }

    return payload as T;
  }
}
