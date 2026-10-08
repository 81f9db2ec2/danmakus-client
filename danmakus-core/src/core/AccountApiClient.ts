import {
  CoreControlConfigDto,
  CoreRuntimeStateDto,
  CoreSyncTagSnapshot,
  CoreTaggedApiResult,
  RecordingInfoDto,
  ResponseValue,
  UpdateRecordingSettingPayload,
  UserInfo,
} from '../types/index.js';
import { BACKEND_PRIMARY_ORIGIN, fetchBackendApiWithFallback } from './BackendApiFallback.js';
import { resolveCoreRuntimeBaseUrl } from './CoreRuntimeUrl.js';
import type { RuntimeEndpoints } from './RuntimeEndpoints.js';

const CONFIG_TAG_HEADER = 'X-Core-Config-Tag';
const CLIENTS_TAG_HEADER = 'X-Core-Clients-Tag';
const RECORDING_TAG_HEADER = 'X-Core-Recording-Tag';
const DEFAULT_ACCOUNT_API_BASE = `${BACKEND_PRIMARY_ORIGIN}/api/v2/account`;
const DEFAULT_BACKEND_REQUEST_TIMEOUT_MS = 15000;

export class AccountApiClient {
  private fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private accountBaseUrl: string;
  private fallbackRuntimeBaseUrl: string;
  private endpoints?: RuntimeEndpoints;
  private coreConfigTag: string | null = null;

  constructor(
    private token: string,
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    endpoints?: RuntimeEndpoints
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.accountBaseUrl = this.normalizeBaseUrl(DEFAULT_ACCOUNT_API_BASE);
    this.fallbackRuntimeBaseUrl = resolveCoreRuntimeBaseUrl(this.accountBaseUrl);
    this.endpoints = endpoints;
  }

  /**
   * 设置运行态接口（sync/heartbeat/clients/state）基础地址，使其跟随服务端下发的 runtimeUrl。
   * 与弹幕上传、主播状态共用同一解析逻辑，避免多处地址不一致。account 中心接口不受影响。
   * 注入了共享 RuntimeEndpoints 时优先走共享源；否则回退到本地字段（独立使用场景）。
   */
  setCoreRuntimeBaseUrl(runtimeUrl: string | null | undefined): void {
    if (this.endpoints) {
      this.endpoints.setRuntimeUrl(runtimeUrl);
      return;
    }
    const resolved = resolveCoreRuntimeBaseUrl(runtimeUrl ?? '');
    this.fallbackRuntimeBaseUrl = resolved || resolveCoreRuntimeBaseUrl(this.accountBaseUrl);
  }

  // 运行态地址懒读：始终取共享源的当前值，杜绝持有过期快照。
  private get coreRuntimeBaseUrl(): string {
    return this.endpoints?.getCoreRuntimeBaseUrl() ?? this.fallbackRuntimeBaseUrl;
  }

  getCoreRuntimeBaseUrl(): string {
    return this.coreRuntimeBaseUrl;
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
    }, {
      timeoutMs: DEFAULT_BACKEND_REQUEST_TIMEOUT_MS,
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
}
