// 导出核心类
export { DanmakuClient } from '../core/DanmakuClient';
export { AuthManager } from '../core/AuthManager';
export { BilibiliAuthApi, BilibiliQrLoginSession } from '../core/BilibiliAuthApi';
export { ConfigManager } from '../core/ConfigManager';
export { CookieManager } from '../core/CookieManager';
export { RuntimeConnection } from '../core/RuntimeConnection';
export { StreamerStatusManager } from '../core/StreamerStatusManager';
export { createSqliteLiveSessionOutbox } from '../core/SqliteLiveSessionOutbox';
export type {
  SqliteLiveSessionOutboxBackend,
  SqliteLiveSessionOutboxValue,
} from '../core/SqliteLiveSessionOutbox';

// 导出类型
export * from '../types';

// 导出工具函数
import { DanmakuClient } from '../core/DanmakuClient';
import { DanmakuConfig } from '../types';

export const createDanmakuClient = (config?: Partial<DanmakuConfig>) => {
  return new DanmakuClient(config);
};

// 版本信息
export const version = '1.0.3';
