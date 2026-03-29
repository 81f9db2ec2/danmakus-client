// 导出核心类
export { DanmakuClient } from '../core/DanmakuClient.js';
export { AuthManager } from '../core/AuthManager.js';
export { BilibiliAuthApi, BilibiliQrLoginSession } from '../core/BilibiliAuthApi.js';
export { ConfigManager } from '../core/ConfigManager.js';
export { CookieManager } from '../core/CookieManager.js';
export { RuntimeConnection } from '../core/RuntimeConnection.js';
export { StreamerStatusManager } from '../core/StreamerStatusManager.js';
export { createSqliteLiveSessionOutbox } from '../core/SqliteLiveSessionOutbox.js';
export type {
  SqliteLiveSessionOutboxBackend,
  SqliteLiveSessionOutboxValue,
} from '../core/SqliteLiveSessionOutbox.js';

// 导出类型
export * from '../types/index.js';

// 导出工具函数
import { DanmakuClient } from '../core/DanmakuClient.js';
import { DanmakuConfig } from '../types/index.js';

export const createDanmakuClient = (config?: Partial<DanmakuConfig>) => {
  return new DanmakuClient(config);
};

// 版本信息
export const version = '1.0.3';
