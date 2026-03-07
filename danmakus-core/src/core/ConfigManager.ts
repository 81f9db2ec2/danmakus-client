import { DanmakuConfig, CliOptions, CoreControlConfigDto } from '../types';

export class ConfigManager {
  private config: DanmakuConfig;

  private normalizeCookieSecret(value?: string | null): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeCookieHost(value?: string | null): string {
    const fallback = this.config?.cookieCloudHost || 'https://cookie.danmakus.com';
    if (typeof value !== 'string') {
      return fallback;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }
    return trimmed.replace(/\/+$/, '');
  }

  private normalizeCookieRefreshInterval(value: number | null | undefined): number {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) {
      return this.config?.cookieRefreshInterval || 3600;
    }
    return Math.max(60, Math.floor(next));
  }

  private normalizeCapacityOverride(value: number | null | undefined): number | undefined {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) {
      return undefined;
    }
    return Math.min(100, Math.floor(next));
  }

  constructor(options: Partial<DanmakuConfig> = {}) {
    this.config = {
      maxConnections: 15,
      cookieCloudHost: 'https://cookie.danmakus.com',
      runtimeUrl: 'https://ukamnads.icu/api/v2/core-runtime',
      runtimeHeaders: options.runtimeHeaders,
      cookieRefreshInterval: 3600, // 1小时
      autoReconnect: true,
      reconnectInterval: 5000, // 5秒
      statusCheckInterval: 30, // 30秒
      requestServerRooms: true,
      allowedAreas: [],
      allowedParentAreas: [],
      logLevel: 'info',
      messageQueueMaxSize: 2000,
      messageRetryBaseDelay: 1000,
      messageRetryMaxDelay: 30000,
      messageRetryMaxAttempts: 6,
      batchUploadSize: 100,
      heartbeatInterval: 5000,
      lockAcquireRetryCount: 4,
      lockAcquireRetryDelay: 1200,
      lockAcquireForceTakeover: false,
      errorHistoryLimit: 50,
      ...options,
      // 录制主播来源统一由 account.Recording（服务端分配）管理
      streamers: []
    };

    this.config.cookieCloudKey = this.normalizeCookieSecret(this.config.cookieCloudKey);
    this.config.cookieCloudPassword = this.normalizeCookieSecret(this.config.cookieCloudPassword);
    this.config.cookieCloudHost = this.normalizeCookieHost(this.config.cookieCloudHost);
    this.config.cookieRefreshInterval = this.normalizeCookieRefreshInterval(this.config.cookieRefreshInterval);
    this.config.capacityOverride = this.normalizeCapacityOverride(this.config.capacityOverride);
  }

  /**
   * 从CLI选项更新配置
   */
  updateFromCliOptions(options: CliOptions): void {
    if (options.maxConnections !== undefined) {
      this.config.maxConnections = Math.min(Math.max(1, options.maxConnections), 100);
    }

    if (options.capacityOverride !== undefined) {
      this.config.capacityOverride = this.normalizeCapacityOverride(options.capacityOverride);
    }

    if (options.cookieKey) {
      this.config.cookieCloudKey = this.normalizeCookieSecret(options.cookieKey);
    }

    if (options.cookiePassword) {
      this.config.cookieCloudPassword = this.normalizeCookieSecret(options.cookiePassword);
    }

    if (options.cookieHost) {
      this.config.cookieCloudHost = this.normalizeCookieHost(options.cookieHost);
    }

    if (options.statusCheckInterval !== undefined) {
      this.config.statusCheckInterval = Math.max(10, options.statusCheckInterval);
    }

    if (options.runtimeUrl) {
      this.config.runtimeUrl = options.runtimeUrl;
    }

    if (options.token) {
      this.config.accountToken = options.token;
    }

    if (options.accountApi) {
      this.config.accountApiBase = options.accountApi;
    }

    if (options.logLevel) {
      this.config.logLevel = options.logLevel;
    } else if (options.verbose) {
      this.config.logLevel = 'debug';
    }
  }

  applyAccountConfig(remote: CoreControlConfigDto): void {
    this.config = {
      ...this.config,
      maxConnections: remote.maxConnections,
      // 如果本地配置了 localhost 开发环境，则忽略远程的 Runtime URL 配置
      runtimeUrl: (this.config.runtimeUrl.includes('localhost') || this.config.runtimeUrl.includes('127.0.0.1'))
        ? this.config.runtimeUrl
        : (remote.runtimeUrl || this.config.runtimeUrl),
      autoReconnect: remote.autoReconnect,
      reconnectInterval: remote.reconnectInterval,
      statusCheckInterval: remote.statusCheckInterval,
      requestServerRooms: remote.requestServerRooms,
      allowedAreas: Array.isArray(remote.allowedAreas) ? [...remote.allowedAreas] : [],
      allowedParentAreas: Array.isArray(remote.allowedParentAreas) ? [...remote.allowedParentAreas] : [],
      // 录制主播来源统一由 account.Recording（服务端分配）管理
      streamers: []
    };
  }

  /**
   * 验证配置有效性
   */
  validate(): boolean {
    if (!this.config.runtimeUrl) {
      throw new Error('Runtime URL 必须设置');
    }

    if (this.config.maxConnections < 1 || this.config.maxConnections > 100) {
      throw new Error('最大连接数必须在1-100之间');
    }

    if (this.config.capacityOverride !== undefined && (this.config.capacityOverride < 1 || this.config.capacityOverride > 100)) {
      throw new Error('capacityOverride 必须在 1-100 之间');
    }

    return true;
  }

  /**
   * 获取配置
   */
  getConfig(): DanmakuConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<DanmakuConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
      // 外部更新时也不允许写入本地主播列表
      streamers: []
    };
  }

  /**
   * 是否配置了CookieCloud
   */
  hasCookieCloudConfig(): boolean {
    return !!(
      this.normalizeCookieSecret(this.config.cookieCloudKey)
      && this.normalizeCookieSecret(this.config.cookieCloudPassword)
    );
  }
}
