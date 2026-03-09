import { CookieCloudResponse } from '../types';

export class CookieManager {
  private cookies: string = '';
  private lastUpdate: number = 0;
  private lastAttempt: number = 0;
  private lastSuccess: number = 0;
  private lastError: string | null = null;
  private updateTimer?: ReturnType<typeof setInterval>;
  private updateTask?: Promise<boolean>;

  onChanged?: () => void;

  private fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(
    private key: string,
    private password: string,
    private host: string = 'https://cookie.danmakus.com',
    private refreshInterval: number = 3600, // 秒
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  ) {
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  /**
   * 启动定期更新Cookie
   */
  startPeriodicUpdate(): void {
    if (this.updateTimer) {
      return;
    }
    if (!this.isValid()) {
      void this.updateCookies();
    }
    this.updateTimer = setInterval(() => {
      void this.updateCookies();
    }, this.refreshInterval * 1000);
  }

  /**
   * 停止定期更新
   */
  stopPeriodicUpdate(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
    }
  }

  /**
   * 更新Cookie信息
   */
  async updateCookies(): Promise<boolean> {
    if (this.updateTask) {
      return this.updateTask;
    }

    this.updateTask = (async () => {
      this.lastAttempt = Date.now();
      this.lastError = null;
      this.notifyChanged();

      try {
        console.log('正在从CookieCloud获取Cookie信息...');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        try {
          const response = await this.fetch(`${this.host}/get/${this.key}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Connection': 'close'
            },
            body: JSON.stringify({ password: this.password }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            const cookieData: CookieCloudResponse = await response.json();
            this.cookies = this.extractBilibiliCookies(cookieData);
            if (!this.cookies.trim()) {
              this.lastError = 'CookieCloud 未返回可用的 Bilibili Cookie';
              this.notifyChanged();
              return false;
            }
            this.lastUpdate = Date.now();
            this.lastSuccess = this.lastUpdate;
            this.lastError = null;

            console.log('Cookie信息已更新');
            this.notifyChanged();
            return true;
          }

          this.lastError = `CookieCloud HTTP ${response.status}`;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error('获取Cookie失败:', this.lastError);
        this.notifyChanged();
        return false;
      } finally {
        this.updateTask = undefined;
        this.notifyChanged();
      }

      this.notifyChanged();
      return false;
    })();

    return this.updateTask;
  }

  /**
   * 从CookieCloud响应中提取Bilibili相关Cookie
   */
  private extractBilibiliCookies(data: CookieCloudResponse): string {
    const bilibiliDomains = ['.bilibili.com', 'bilibili.com', '.live.bilibili.com'];
    const cookiePairs: string[] = [];

    for (const domain in data.cookie_data) {
      if (bilibiliDomains.some(bilibiliDomain => domain.includes(bilibiliDomain))) {
        for (const cookieName in data.cookie_data[domain]) {
          const cookie = data.cookie_data[domain][cookieName];

          // 检查Cookie是否过期
          if (cookie.expires && cookie.expires < Date.now() / 1000) {
            continue;
          }

          cookiePairs.push(`${cookie.name}=${cookie.value}`);
        }
      }
    }

    return cookiePairs.join('; ');
  }

  /**
   * 获取当前Cookie字符串
   */
  getCookies(): string {
    return this.cookies;
  }

  /**
   * 检查Cookie是否有效（不为空且更新时间在有效期内）
   */
  isValid(): boolean {
    const now = Date.now();
    const maxAge = this.refreshInterval * 1000 * 2; // 允许Cookie过期2个周期

    return this.cookies.length > 0 && (now - this.lastUpdate) < maxAge;
  }

  /**
   * 获取最后更新时间
   */
  getLastUpdateTime(): number {
    return this.lastUpdate;
  }

  getLastAttemptTime(): number {
    return this.lastAttempt;
  }

  getLastSuccessTime(): number {
    return this.lastSuccess;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  isSyncing(): boolean {
    return this.updateTask !== undefined;
  }

  /**
   * 手动设置Cookie（用于测试或直接设置）
   */
  setCookies(cookies: string): void {
    this.cookies = cookies;
    this.lastUpdate = Date.now();
    this.lastSuccess = this.lastUpdate;
    this.lastError = null;
    this.notifyChanged();
  }

  /**
   * 清空Cookie
   */
  clearCookies(): void {
    this.cookies = '';
    this.lastUpdate = 0;
    this.notifyChanged();
  }

  /**
   * 获取关键Cookie值（如SESSDATA）
   */
  getKeyValue(key: string): string | null {
    const cookies = this.cookies.split('; ');
    for (const cookie of cookies) {
      const [name, value] = cookie.split('=');
      if (name === key) {
        return value;
      }
    }
    return null;
  }

  private notifyChanged(): void {
    this.onChanged?.();
  }
}
