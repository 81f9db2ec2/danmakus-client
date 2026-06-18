import { resolveCoreRuntimeBaseUrl } from './CoreRuntimeUrl.js';

/**
 * core-runtime 地址的唯一持有者。
 *
 * 弹幕上传、运行态同步/心跳、主播状态三类请求的目标地址都从这里**懒读**，
 * 服务端下发新 runtimeUrl 时只需调用一次 {@link setRuntimeUrl}，所有消费者下次请求即生效，
 * 无需重建客户端、也不会有谁持有过期的地址快照。
 */
export class RuntimeEndpoints {
  private coreRuntimeBaseUrl: string;

  constructor(runtimeUrl: string) {
    this.coreRuntimeBaseUrl = resolveCoreRuntimeBaseUrl(runtimeUrl);
  }

  /** 更新运行态地址；空值忽略以保留当前有效地址。 */
  setRuntimeUrl(runtimeUrl: string | null | undefined): void {
    const resolved = resolveCoreRuntimeBaseUrl(runtimeUrl ?? '');
    if (resolved) {
      this.coreRuntimeBaseUrl = resolved;
    }
  }

  /** 上传 / 同步 / 心跳 / 房间分配的基础地址，如 `https://host/api/v2/core-runtime`。 */
  getCoreRuntimeBaseUrl(): string {
    return this.coreRuntimeBaseUrl;
  }

  /** 主播状态接口地址，与 core-runtime 同源同版本前缀。 */
  getStreamerStatusBaseUrl(): string {
    const base = this.coreRuntimeBaseUrl;
    if (base.endsWith('/api/v2/core-runtime')) {
      return base.replace(/\/api\/v2\/core-runtime$/, '/api/v2/streamer-status');
    }
    return base.replace(/\/api\/core-runtime$/, '/api/streamer-status');
  }
}
