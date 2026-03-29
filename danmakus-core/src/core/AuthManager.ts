import {
  AuthSourceKind,
  AuthSourceStateSnapshot,
  AuthStateSnapshot,
  AuthSyncPhase,
} from '../types/index.js';
import { BilibiliAuthApi } from './BilibiliAuthApi.js';
import { CookieManager } from './CookieManager.js';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type AuthManagerOptions = {
  localCookieProvider?: () => string | null | undefined;
  cookieCloudKey?: string;
  cookieCloudPassword?: string;
  cookieCloudHost?: string;
  cookieRefreshInterval?: number;
  fetchImpl?: FetchImpl;
};

const createSourceState = (configured = false): AuthSourceStateSnapshot => ({
  configured,
  hasCookie: false,
  valid: false,
  phase: 'idle',
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastValidatedAt: null,
  lastError: null,
  profile: null,
});

export class AuthManager {
  private readonly localCookieProvider?: () => string | null | undefined;
  private readonly api: BilibiliAuthApi;
  private readonly cookieManager?: CookieManager;

  private localState: AuthSourceStateSnapshot;
  private cloudState: AuthSourceStateSnapshot;
  private state: AuthStateSnapshot;

  private localValidatedCookie: string = '';
  private cloudValidatedCookie: string = '';
  private refreshTask?: Promise<AuthStateSnapshot>;
  private readonly listeners = new Set<(state: AuthStateSnapshot) => void>();

  constructor(options: AuthManagerOptions) {
    this.localCookieProvider = options.localCookieProvider;
    this.api = new BilibiliAuthApi(options.fetchImpl);
    this.cookieManager = options.cookieCloudKey && options.cookieCloudPassword
      ? new CookieManager(
        options.cookieCloudKey,
        options.cookieCloudPassword,
        options.cookieCloudHost,
        options.cookieRefreshInterval,
        options.fetchImpl,
      )
      : undefined;

    this.localState = createSourceState(Boolean(this.localCookieProvider));
    this.cloudState = createSourceState(Boolean(this.cookieManager));
    this.state = {
      activeSource: null,
      hasUsableCookie: false,
      phase: 'idle',
      lastError: null,
      local: { ...this.localState },
      cookieCloud: { ...this.cloudState },
    };

    if (this.cookieManager) {
      this.cookieManager.onChanged = () => {
        const isSyncing = this.cookieManager?.isSyncing() === true;
        void this.refreshState({
          validateProfile: !isSyncing,
          force: !isSyncing,
        }).catch(() => undefined);
      };
    }
  }

  dispose(): void {
    if (this.cookieManager) {
      this.cookieManager.onChanged = undefined;
      this.cookieManager.stopPeriodicUpdate();
    }
    this.listeners.clear();
  }

  start(): void {
    this.cookieManager?.startPeriodicUpdate();
  }

  stop(): void {
    this.cookieManager?.stopPeriodicUpdate();
  }

  onStateChanged(listener: (state: AuthStateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): AuthStateSnapshot {
    return {
      ...this.state,
      local: { ...this.state.local },
      cookieCloud: { ...this.state.cookieCloud },
    };
  }

  getPreferredCookie(): { source: AuthSourceKind; value: string } | null {
    const cloudCookie = this.cookieManager?.getCookies().trim();
    const localCookie = this.localCookieProvider?.()?.trim();

    if (this.state.activeSource === 'cookieCloud' && cloudCookie) {
      return { source: 'cookieCloud', value: cloudCookie };
    }

    if (this.state.activeSource === 'local' && localCookie) {
      return { source: 'local', value: localCookie };
    }

    if (cloudCookie) {
      return { source: 'cookieCloud', value: cloudCookie };
    }

    if (localCookie) {
      return { source: 'local', value: localCookie };
    }

    return null;
  }

  hasAvailableCookie(): boolean {
    return this.getPreferredCookie() !== null;
  }

  async ensureReadyForStartup(): Promise<void> {
    if (this.cookieManager && !this.cookieManager.getCookies().trim()) {
      await this.cookieManager.updateCookies();
    }

    const preferred = this.getPreferredCookie();
    if (!preferred) {
      if (this.cookieManager) {
        throw new Error('CookieCloud 未返回可用的 Bilibili Cookie，无法启动弹幕客户端');
      }
      throw new Error('未提供可用的 Bilibili Cookie，无法启动弹幕客户端；请先配置本地 Cookie 或 CookieCloud');
    }

    const state = await this.refreshState({ validateProfile: true });
    if (!state.hasUsableCookie) {
      if (preferred.source === 'cookieCloud') {
        throw new Error(state.cookieCloud.lastError || 'CookieCloud Cookie 无效或已过期，无法启动弹幕客户端');
      }
      throw new Error(state.local.lastError || '本地 Bilibili Cookie 无效或已过期，无法启动弹幕客户端，请重新扫码登录');
    }
  }

  async syncCookieCloud(): Promise<AuthStateSnapshot> {
    if (!this.cookieManager) {
      throw new Error('当前未配置 CookieCloud');
    }
    await this.cookieManager.updateCookies();
    return this.refreshState({ validateProfile: true, force: true });
  }

  async refreshState(options?: { validateProfile?: boolean; force?: boolean }): Promise<AuthStateSnapshot> {
    if (this.refreshTask && !options?.force) {
      return this.refreshTask;
    }

    const task = this.doRefreshState(options);
    this.refreshTask = task;
    try {
      return await task;
    } finally {
      if (this.refreshTask === task) {
        this.refreshTask = undefined;
      }
    }
  }

  private async doRefreshState(options?: { validateProfile?: boolean; force?: boolean }): Promise<AuthStateSnapshot> {
    const validateProfile = options?.validateProfile === true;

    const localCookie = this.localCookieProvider?.()?.trim() || '';
    const cloudCookie = this.cookieManager?.getCookies().trim() || '';

    const nextLocal = this.buildBaseLocalState(localCookie);
    const nextCloud = this.buildBaseCloudState(cloudCookie);

    if (validateProfile) {
      await this.validateCookie('local', localCookie, nextLocal, options?.force === true);
      await this.validateCookie('cookieCloud', cloudCookie, nextCloud, options?.force === true);
    } else {
      this.reuseValidationSnapshot('local', localCookie, nextLocal);
      this.reuseValidationSnapshot('cookieCloud', cloudCookie, nextCloud);
    }

    const activeSource = nextCloud.valid
      ? 'cookieCloud'
      : (nextLocal.valid ? 'local' : null);
    const hasUsableCookie = activeSource !== null;
    const activeState = activeSource === 'cookieCloud'
      ? nextCloud
      : (activeSource === 'local' ? nextLocal : null);
    const phase = this.resolveAggregatePhase(activeState, nextLocal, nextCloud);
    const lastError = activeState?.lastError ?? nextCloud.lastError ?? nextLocal.lastError ?? null;

    this.localState = nextLocal;
    this.cloudState = nextCloud;
    this.state = {
      activeSource,
      hasUsableCookie,
      phase,
      lastError,
      local: { ...nextLocal },
      cookieCloud: { ...nextCloud },
    };
    this.emitStateChanged();
    return this.getState();
  }

  private buildBaseLocalState(cookie: string): AuthSourceStateSnapshot {
    const next = { ...this.localState };
    next.configured = Boolean(this.localCookieProvider);
    next.hasCookie = Boolean(cookie);
    if (!cookie) {
      next.valid = false;
      next.phase = next.configured ? 'idle' : 'idle';
      next.profile = null;
      next.lastError = null;
      next.lastValidatedAt = null;
    }
    return next;
  }

  private buildBaseCloudState(cookie: string): AuthSourceStateSnapshot {
    const next = { ...this.cloudState };
    next.configured = Boolean(this.cookieManager);
    next.hasCookie = Boolean(cookie);
    next.lastAttemptAt = this.cookieManager?.getLastAttemptTime() || null;
    next.lastSuccessAt = this.cookieManager?.getLastSuccessTime() || null;
    next.lastError = this.cookieManager?.getLastError() ?? null;
    if (this.cookieManager?.isSyncing()) {
      next.phase = 'syncing';
      return next;
    }
    if (!next.configured) {
      next.phase = 'idle';
      next.valid = false;
      next.profile = null;
      next.lastValidatedAt = null;
      return next;
    }
    if (!cookie) {
      next.valid = false;
      next.profile = null;
      next.lastValidatedAt = null;
      next.phase = next.lastError ? 'error' : 'idle';
      return next;
    }
    next.phase = next.lastError ? 'degraded' : 'ready';
    return next;
  }

  private reuseValidationSnapshot(
    source: AuthSourceKind,
    cookie: string,
    target: AuthSourceStateSnapshot,
  ): void {
    const cachedCookie = source === 'local' ? this.localValidatedCookie : this.cloudValidatedCookie;
    const cachedState = source === 'local' ? this.localState : this.cloudState;
    if (!cookie || cachedCookie !== cookie) {
      target.valid = false;
      target.profile = null;
      target.lastValidatedAt = null;
      if (!target.lastError && cookie) {
        target.phase = 'idle';
      }
      return;
    }
    target.valid = cachedState.valid;
    target.profile = cachedState.profile ? { ...cachedState.profile } : null;
    target.lastValidatedAt = cachedState.lastValidatedAt;
    target.lastError = cachedState.lastError;
    target.phase = cachedState.phase;
  }

  private async validateCookie(
    source: AuthSourceKind,
    cookie: string,
    target: AuthSourceStateSnapshot,
    force: boolean,
  ): Promise<void> {
    if (!cookie) {
      target.valid = false;
      target.profile = null;
      target.lastValidatedAt = null;
      if (!target.lastError) {
        target.phase = target.configured ? 'idle' : 'idle';
      }
      return;
    }

    const cachedCookie = source === 'local' ? this.localValidatedCookie : this.cloudValidatedCookie;
    if (!force && cachedCookie === cookie && target.lastValidatedAt && target.profile) {
      target.valid = true;
      target.profile = { ...target.profile };
      target.phase = source === 'cookieCloud' && this.cookieManager?.getLastError() ? 'degraded' : 'ready';
      return;
    }

    try {
      const profile = await this.api.getNavProfile(cookie);
      target.lastValidatedAt = Date.now();
      target.profile = profile;
      target.valid = profile !== null;
      target.lastError = profile === null ? 'Cookie 无效或已过期' : null;
      target.phase = profile === null
        ? 'error'
        : (source === 'cookieCloud' && this.cookieManager?.getLastError() ? 'degraded' : 'ready');

      if (source === 'local') {
        this.localValidatedCookie = cookie;
      } else {
        this.cloudValidatedCookie = cookie;
      }
    } catch (error) {
      target.lastValidatedAt = Date.now();
      target.profile = null;
      target.valid = false;
      target.lastError = error instanceof Error ? error.message : String(error);
      target.phase = 'error';
    }
  }

  private resolveAggregatePhase(
    activeState: AuthSourceStateSnapshot | null,
    local: AuthSourceStateSnapshot,
    cloud: AuthSourceStateSnapshot,
  ): AuthSyncPhase {
    if (cloud.phase === 'syncing') {
      return 'syncing';
    }
    if (activeState) {
      return activeState.phase;
    }
    if (cloud.phase === 'error' || local.phase === 'error') {
      return 'error';
    }
    return 'idle';
  }

  private emitStateChanged(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
