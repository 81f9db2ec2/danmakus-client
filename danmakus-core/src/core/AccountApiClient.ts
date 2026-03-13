import {
  CoreControlConfigDto,
  CoreRuntimeStateDto,
  CoreSyncTagSnapshot,
  CoreTaggedApiResult,
  RecordingInfoDto,
  ResponseValue,
  UpdateRecordingSettingPayload,
  UserInfo,
} from '../types';
import { fetchBackendApiWithFallback } from './BackendApiFallback';

type HeartbeatRuntimeStateResult = {
  configTag: string | null;
  assignmentTag: string | null;
  clientsTag: string | null;
  recordingTag: string | null;
};

const CONFIG_TAG_HEADER = 'X-Core-Config-Tag';
const ASSIGNMENT_TAG_HEADER = 'X-Core-Assignment-Tag';
const CLIENTS_TAG_HEADER = 'X-Core-Clients-Tag';
const RECORDING_TAG_HEADER = 'X-Core-Recording-Tag';
const HEARTBEAT_FEATURES_HEADER = 'X-Core-Heartbeat-Features';
const HEARTBEAT_FEATURES = 'clients,recording';
const DEFAULT_ACCOUNT_API_BASE = 'https://ukamnads.icu/api/v2/account';

export class AccountApiClient {
  private fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private accountBaseUrl: string;
  private coreRuntimeBaseUrl: string;
  private coreConfigTag: string | null = null;

  constructor(
    private token: string,
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.accountBaseUrl = this.normalizeBaseUrl(DEFAULT_ACCOUNT_API_BASE);
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

  async getUserInfo(): Promise<UserInfo> {
    return this.requestWithBase<UserInfo>(this.accountBaseUrl, '/info', {
      method: 'GET',
    });
  }

  getCoreConfigTag(): string | null {
    return this.coreConfigTag;
  }

  async getRecordingList(): Promise<CoreTaggedApiResult<RecordingInfoDto[]>> {
    return this.requestTaggedAccount<RecordingInfoDto[]>('/recording', {
      method: 'GET',
    });
  }

  async addRecording(uid: number): Promise<CoreTaggedApiResult<RecordingInfoDto>> {
    return this.requestTaggedAccount<RecordingInfoDto>(`/add-record?uId=${encodeURIComponent(String(uid))}`, {
      method: 'GET',
    });
  }

  async removeRecording(uid: number): Promise<CoreTaggedApiResult<unknown>> {
    return this.requestTaggedAccount<unknown>(`/del-record?uId=${encodeURIComponent(String(uid))}`, {
      method: 'GET',
    });
  }

  async updateRecordingSetting(payload: UpdateRecordingSettingPayload[]): Promise<CoreTaggedApiResult<number[]>> {
    return this.requestTaggedAccount<number[]>('/update-recording-setting', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async updateCoreConfig(config: CoreControlConfigDto): Promise<CoreTaggedApiResult<CoreControlConfigDto>> {
    return this.requestTaggedAccount<CoreControlConfigDto>('/core-config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getCoreClients(): Promise<CoreTaggedApiResult<CoreRuntimeStateDto[]>> {
    return this.requestTaggedRuntime<CoreRuntimeStateDto[]>('/clients', {
      method: 'GET',
    });
  }

  async getCoreHeartbeatTags(): Promise<CoreSyncTagSnapshot> {
    const headers = new Headers();
    headers.set(HEARTBEAT_FEATURES_HEADER, HEARTBEAT_FEATURES);

    const response = await this.fetchWithBase(this.coreRuntimeBaseUrl, '/heartbeat', {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      await this.parseResponsePayload(response);
    }

    return this.readCoreSyncTags(response.headers);
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

  async releaseRuntimeState(clientId: string, options?: { force?: boolean }): Promise<void> {
    const suffix = options?.force ? `?clientId=${encodeURIComponent(clientId)}&force=true` : `?clientId=${encodeURIComponent(clientId)}`;
    await this.requestRuntime(`/state${suffix}`, {
      method: 'DELETE'
    });
  }

  private requestRuntime<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return this.requestWithBase(this.coreRuntimeBaseUrl, path, init);
  }

  private async requestRuntimeSignal(path: string, init?: RequestInit): Promise<HeartbeatRuntimeStateResult> {
    const headers = new Headers(init?.headers ?? {});
    headers.set(HEARTBEAT_FEATURES_HEADER, HEARTBEAT_FEATURES);

    const response = await this.fetchWithBase(this.coreRuntimeBaseUrl, path, {
      ...init,
      headers,
    });
    const tags = this.readCoreSyncTags(response.headers);
    const assignmentTag = this.normalizeTag(response.headers.get(ASSIGNMENT_TAG_HEADER));
    if (response.status === 204) {
      return {
        configTag: tags.configTag,
        assignmentTag,
        clientsTag: tags.clientsTag,
        recordingTag: tags.recordingTag,
      };
    }

    await this.parseResponsePayload(response);
    return {
      configTag: tags.configTag,
      assignmentTag,
      clientsTag: tags.clientsTag,
      recordingTag: tags.recordingTag,
    };
  }

  private async requestTaggedAccount<T>(path: string, init?: RequestInit): Promise<CoreTaggedApiResult<T>> {
    return this.requestTaggedWithBase<T>(this.accountBaseUrl, path, init);
  }

  private async requestTaggedRuntime<T>(path: string, init?: RequestInit): Promise<CoreTaggedApiResult<T>> {
    return this.requestTaggedWithBase<T>(this.coreRuntimeBaseUrl, path, init);
  }

  private async requestTaggedWithBase<T>(baseUrl: string, path: string, init?: RequestInit): Promise<CoreTaggedApiResult<T>> {
    const response = await this.fetchWithBase(baseUrl, path, init);
    return {
      data: await this.parseResponsePayload<T>(response),
      tags: this.readCoreSyncTags(response.headers),
    };
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

    return fetchBackendApiWithFallback(this.fetchImpl, `${baseUrl}${path}`, {
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

  private readCoreSyncTags(headers: Headers): CoreSyncTagSnapshot {
    return {
      configTag: this.normalizeTag(headers.get(CONFIG_TAG_HEADER)),
      clientsTag: this.normalizeTag(headers.get(CLIENTS_TAG_HEADER)),
      recordingTag: this.normalizeTag(headers.get(RECORDING_TAG_HEADER)),
    };
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
