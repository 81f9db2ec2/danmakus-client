import { CoreControlConfigDto, CoreRuntimeStateDto, ResponseValue } from '../types';

type HeartbeatRuntimeStateResult = {
  configTag: string | null;
  assignmentTag: string | null;
};

const CONFIG_TAG_HEADER = 'X-Core-Config-Tag';
const ASSIGNMENT_TAG_HEADER = 'X-Core-Assignment-Tag';

export class AccountApiClient {
  private fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private accountBaseUrl: string;
  private coreRuntimeBaseUrl: string;
  private coreConfigTag: string | null = null;

  constructor(
    private token: string,
    private baseUrl: string = 'https://ukamnads.icu/api/v2/account',
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.accountBaseUrl = this.normalizeBaseUrl(this.baseUrl);
    this.coreRuntimeBaseUrl = this.resolveCoreRuntimeBaseUrl(this.accountBaseUrl);
  }

  async getCoreConfig(): Promise<CoreControlConfigDto> {
    const response = await this.fetchWithBase(this.accountBaseUrl, '/core-config', {
      method: 'GET'
    });

    const config = await this.parseResponsePayload<CoreControlConfigDto>(response);
    this.coreConfigTag = this.resolveConfigTag(response.headers);
    return config;
  }

  getCoreConfigTag(): string | null {
    return this.coreConfigTag;
  }

  async syncRuntimeState(
    payload: Partial<CoreRuntimeStateDto> & { clientId: string },
    options?: { force?: boolean }
  ): Promise<CoreRuntimeStateDto> {
    const suffix = options?.force ? '?force=true' : '';
    return this.requestRuntime<CoreRuntimeStateDto>(`/sync${suffix}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async heartbeatRuntimeState(
    payload: Partial<CoreRuntimeStateDto> & { clientId: string },
    options?: { force?: boolean }
  ): Promise<HeartbeatRuntimeStateResult> {
    const suffix = options?.force ? '?force=true' : '';
    return this.requestRuntimeSignal(`/heartbeat${suffix}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async releaseRuntimeState(clientId: string): Promise<void> {
    await this.requestRuntime(`/state?clientId=${encodeURIComponent(clientId)}`, {
      method: 'DELETE'
    });
  }

  private requestRuntime<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return this.requestWithBase(this.coreRuntimeBaseUrl, path, init);
  }

  private async requestRuntimeSignal(path: string, init?: RequestInit): Promise<HeartbeatRuntimeStateResult> {
    const response = await this.fetchWithBase(this.coreRuntimeBaseUrl, path, init);
    const configTag = this.normalizeTag(response.headers.get(CONFIG_TAG_HEADER));
    const assignmentTag = this.normalizeTag(response.headers.get(ASSIGNMENT_TAG_HEADER));
    if (response.status === 204) {
      return { configTag, assignmentTag };
    }

    await this.parseResponsePayload(response);
    return { configTag, assignmentTag };
  }

  private async requestWithBase<T = unknown>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchWithBase(baseUrl, path, init);
    return this.parseResponsePayload<T>(response);
  }

  private async fetchWithBase(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers ?? {});
    headers.set('Token', this.token);
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return this.fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers
    });
  }

  private async parseResponsePayload<T>(response: Response): Promise<T> {
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

  private resolveConfigTag(headers: Headers): string | null {
    return this.normalizeTag(headers.get(CONFIG_TAG_HEADER));
  }

  private normalizeTag(value: string | null): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private resolveCoreRuntimeBaseUrl(accountBaseUrl: string): string {
    const normalized = this.normalizeBaseUrl(accountBaseUrl);
    try {
      const parsed = new URL(normalized);
      const path = parsed.pathname.replace(/\/+$/, '');
      if (/\/account$/i.test(path)) {
        parsed.pathname = path.replace(/\/account$/i, '/core-runtime');
      } else if (/\/api\/v2(\/|$)/i.test(path)) {
        parsed.pathname = '/api/v2/core-runtime';
      } else {
        parsed.pathname = `${path}/core-runtime`;
      }
      parsed.search = '';
      parsed.hash = '';
      return this.normalizeBaseUrl(parsed.toString());
    } catch {
      if (/\/account$/i.test(normalized)) {
        return normalized.replace(/\/account$/i, '/core-runtime');
      }
      if (/\/api\/v2(\/|$)/i.test(normalized)) {
        return normalized.replace(/\/api\/v2(?:\/.*)?$/i, '/api/v2/core-runtime');
      }
      return `${normalized}/core-runtime`;
    }
  }
}
