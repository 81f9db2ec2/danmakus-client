import { DanmakuConfig, CliOptions, StreamerConfig, CoreControlConfigDto } from '../types';

export class ConfigManager {
  private config: DanmakuConfig;

  constructor(options: Partial<DanmakuConfig> = {}) {
    this.config = {
      maxConnections: 10,
      streamers: [],
      cookieCloudHost: 'http://localhost:8088',
      signalrUrl: 'https://ukamnads.icu/api/v2/user-hub',
      signalrHeaders: options.signalrHeaders,
      cookieRefreshInterval: 3600, // 1小时
      autoReconnect: true,
      reconnectInterval: 5000, // 5秒
      statusCheckInterval: 30, // 30秒
      requestServerRooms: true,
      ...options
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

    if (options.token) {
      this.config.accountToken = options.token;
    }

    if (options.accountApi) {
      this.config.accountApiBase = options.accountApi;
    }
  }

  applyAccountConfig(remote: CoreControlConfigDto): void {
    const streamers: StreamerConfig[] = remote.streamers.map(streamer => ({
      roomId: Number(streamer.roomId),
      priority: streamer.priority ?? 'normal',
      name: streamer.name || undefined
    }));

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
      streamers
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

    // 验证主播配置
    const nonLowPriorityCount = this.config.streamers.filter(s => s.priority !== 'low').length;
    if (nonLowPriorityCount > 10) {
      throw new Error('高优先级和普通优先级主播总数不能超过10个');
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
    this.config = { ...this.config, ...updates };
  }

  /**
   * 是否配置了CookieCloud
   */
  hasCookieCloudConfig(): boolean {
    return !!(this.config.cookieCloudKey && this.config.cookieCloudPassword);
  }

  /**
   * 获取主播配置列表
   */
  getStreamers(): StreamerConfig[] {
    return [...this.config.streamers];
  }

  /**
   * 添加主播配置
   */
  addStreamer(streamer: StreamerConfig): void {
    const existingIndex = this.config.streamers.findIndex(s => s.roomId === streamer.roomId);
    if (existingIndex >= 0) {
      this.config.streamers[existingIndex] = streamer;
    } else {
      this.config.streamers.push(streamer);
    }
  }

  /**
   * 移除主播配置
   */
  removeStreamer(roomId: number): void {
    this.config.streamers = this.config.streamers.filter(s => s.roomId !== roomId);
  }

  /**
   * 获取所有房间ID
   */
  getAllRoomIds(): number[] {
    return this.config.streamers.map(s => s.roomId);
  }
}