import { DanmakuConfig, CliOptions, CoreControlConfigDto } from '../types';

export class ConfigManager {
  private config: DanmakuConfig;

  constructor(options: Partial<DanmakuConfig> = {}) {
    this.config = {
      maxConnections: 10,
      cookieCloudHost: 'http://localhost:8088',
      signalrUrl: 'https://ukamnads.icu/api/v2/user-hub',
      signalrHeaders: options.signalrHeaders,
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
      batchUploadSize: 20,
      heartbeatInterval: 5000,
      lockAcquireRetryCount: 4,
      lockAcquireRetryDelay: 1200,
      lockAcquireForceTakeover: false,
      errorHistoryLimit: 50,
      ...options,
      // 录制主播来源统一由 account.Recording（服务端分配）管理
      streamers: []
    };
  }

  /**
   * 从CLI选项更新配置
   */
  updateFromCliOptions(options: CliOptions): void {
    if (options.maxConnections !== undefined) {
      this.config.maxConnections = Math.min(Math.max(1, options.maxConnections), 10);
    }

    if (options.cookieKey) {
      this.config.cookieCloudKey = options.cookieKey;
    }

    if (options.cookiePassword) {
      this.config.cookieCloudPassword = options.cookiePassword;
    }

    if (options.cookieHost) {
      this.config.cookieCloudHost = options.cookieHost;
    }

    if (options.statusCheckInterval !== undefined) {
      this.config.statusCheckInterval = Math.max(10, options.statusCheckInterval);
    }

    if (options.signalrUrl) {
      this.config.signalrUrl = options.signalrUrl;
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
      // 如果本地配置了 localhost 开发环境，则忽略远程的 SignalR URL 配置
      signalrUrl: (this.config.signalrUrl.includes('localhost') || this.config.signalrUrl.includes('127.0.0.1'))
        ? this.config.signalrUrl
        : (remote.signalrUrl || this.config.signalrUrl),
      autoReconnect: remote.autoReconnect,
      reconnectInterval: remote.reconnectInterval,
      statusCheckInterval: remote.statusCheckInterval,
      cookieCloudKey: remote.cookieCloudKey ?? undefined,
      cookieCloudPassword: remote.cookieCloudPassword ?? undefined,
      cookieCloudHost: remote.cookieCloudHost ?? undefined,
      cookieRefreshInterval: remote.cookieRefreshInterval,
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
    if (!this.config.signalrUrl) {
      throw new Error('SignalR URL 必须设置');
    }

    if (this.config.maxConnections < 1 || this.config.maxConnections > 10) {
      throw new Error('最大连接数必须在1-10之间');
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
    return !!(this.config.cookieCloudKey && this.config.cookieCloudPassword);
  }
}
