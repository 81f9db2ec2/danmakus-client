import { LiveWsRoomConfig } from '../types';
import { mergeCookieJar, readCookieValue } from './BilibiliCookie';
import { BilibiliAuthApi } from './BilibiliAuthApi';
import { getStartupBilibiliUserAgent } from './BilibiliUserAgent';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const WBI_KEY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function getMixinKey(origin: string): string {
  let mixed = '';
  for (const idx of WBI_MIXIN_KEY_ENC_TAB) {
    if (idx < origin.length) {
      mixed += origin[idx];
    }
  }
  return mixed.slice(0, 32);
}

function sanitizeWbiValue(value: string): string {
  return value.replace(/[!'()*]/g, '');
}

function leftRotate(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function md5Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  const origBitLen = msg.length * 8;
  const withPaddingLen = (((msg.length + 8) >> 6) + 1) * 64;
  const buffer = new Uint8Array(withPaddingLen);
  buffer.set(msg);
  buffer[msg.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(withPaddingLen - 8, origBitLen >>> 0, true);
  view.setUint32(withPaddingLen - 4, Math.floor(origBitLen / 0x100000000), true);

  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < withPaddingLen; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i += 1) {
      m[i] = view.getUint32(offset + i * 4, true);
    }

    for (let i = 0; i < 64; i += 1) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const next = d;
      d = c;
      c = b;
      const sum = (a + f + k[i] + m[g]) >>> 0;
      b = (b + leftRotate(sum, s[i]!)) >>> 0;
      a = next;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out).map((v) => v.toString(16).padStart(2, '0')).join('');
}

function buildWssAddress(host: string, wssPort: number): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('host 为空');
  }

  let base = trimmed;
  if (/^wss?:\/\//i.test(base)) {
    base = base.replace(/^ws:\/\//i, 'wss://');
  } else {
    const portSuffix = Number.isFinite(wssPort) && wssPort > 0 && wssPort !== 443
      ? `:${wssPort}`
      : '';
    base = `wss://${base}${portSuffix}`;
  }

  return base.endsWith('/sub') ? base : `${base}/sub`;
}

export class BilibiliLiveWsAuthApi {
  private readonly fetchImpl: FetchImpl;
  private readonly authApi: BilibiliAuthApi;

  private baseCookie = '';
  private cookieJar = '';
  private buvid = '';
  private sessionWarmAt = 0;
  private wbiImgKey = '';
  private wbiSubKey = '';
  private wbiKeyExpireAt = 0;

  constructor(fetchImpl?: FetchImpl) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.authApi = new BilibiliAuthApi(this.fetchImpl);
  }

  async getRoomConfig(roomId: number, cookie: string): Promise<LiveWsRoomConfig> {
    if (!Number.isFinite(roomId) || roomId <= 0) {
      throw new Error(`无效房间号: ${roomId}`);
    }

    this.useCookie(cookie);
    if (!this.cookieJar.trim()) {
      throw new Error(`房间 ${roomId} 缺少可用 Cookie，无法获取内置鉴权信息`);
    }

    await this.warmupBiliSession();
    const query = await this.buildWbiQueryString({
      id: String(roomId),
      isGaiaAvoided: 'true',
      type: '0',
    });
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`;

    type DanmuInfoPayload = {
      code?: unknown;
      message?: unknown;
      msg?: unknown;
      data?: {
        token?: unknown;
        host_list?: Array<{ host?: unknown; wss_port?: unknown }>;
      };
    };

    const queryDanmuInfo = async (): Promise<{ payload: DanmuInfoPayload; vVoucher: string; hasCookie: boolean }> => {
      const response = await this.queryBiliApi(url);
      if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new Error(`获取房间 ${roomId} 鉴权信息失败: HTTP ${response.status}${message ? ` ${message}` : ''}`);
      }
      const payload = await response.json() as DanmuInfoPayload;
      const vVoucher = response.headers.get('x-bili-gaia-vvoucher')
        ?? response.headers.get('X-Bili-Gaia-VVoucher')
        ?? '';
      return {
        payload,
        vVoucher: vVoucher.trim(),
        hasCookie: this.cookieJar.trim().length > 0,
      };
    };

    let first = await queryDanmuInfo();
    let payload = first.payload;
    let vVoucher = first.vVoucher;
    let hasCookie = first.hasCookie;
    if (payload.code === -352) {
      await this.warmupBiliSession(true);
      const second = await queryDanmuInfo();
      payload = second.payload;
      vVoucher = second.vVoucher;
      hasCookie = second.hasCookie;
    }

    if (payload.code !== 0) {
      const message = typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : (typeof payload.msg === 'string' && payload.msg.trim()
          ? payload.msg.trim()
          : `code=${String(payload.code)}`);
      if (payload.code === -352) {
        throw new Error(`获取房间 ${roomId} 鉴权信息失败: ${message} (wbi=on,cookie=${hasCookie ? 'present' : 'missing'},vvoucher=${vVoucher || 'none'})`);
      }
      throw new Error(`获取房间 ${roomId} 鉴权信息失败: ${message}`);
    }

    const token = typeof payload.data?.token === 'string' ? payload.data.token.trim() : '';
    if (!token) {
      throw new Error(`获取房间 ${roomId} 鉴权信息失败: token 为空`);
    }

    const validHosts = (payload.data?.host_list ?? []).filter((item): item is { host: string; wss_port?: unknown } => {
      return typeof item?.host === 'string' && item.host.trim().length > 0;
    });
    if (validHosts.length === 0) {
      throw new Error(`获取房间 ${roomId} 鉴权信息失败: host_list 为空`);
    }

    const hostInfo = validHosts[Math.floor(Math.random() * validHosts.length)]!;
    const address = buildWssAddress(hostInfo.host, Number(hostInfo.wss_port));

    const roomInitResponse = await this.queryBiliApi(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`);
    if (!roomInitResponse.ok) {
      throw new Error(`获取房间 ${roomId} 初始化信息失败: HTTP ${roomInitResponse.status}`);
    }
    const roomInitPayload = await roomInitResponse.json() as {
      code?: unknown;
      message?: unknown;
      data?: { room_id?: unknown };
    };
    if (roomInitPayload.code !== 0) {
      throw new Error(`获取房间 ${roomId} 初始化信息失败: ${String(roomInitPayload.message ?? roomInitPayload.code)}`);
    }
    const resolvedRoomIdRaw = roomInitPayload.data?.room_id;
    const resolvedRoomId = typeof resolvedRoomIdRaw === 'number' ? resolvedRoomIdRaw : Number(resolvedRoomIdRaw);
    if (!Number.isFinite(resolvedRoomId) || resolvedRoomId <= 0) {
      throw new Error(`获取房间 ${roomId} 初始化信息失败: room_id 无效`);
    }

    let apiUid = 0;
    try {
      const navProfile = await this.authApi.getNavProfile(this.cookieJar);
      apiUid = navProfile?.uid ?? 0;
    } catch {
      apiUid = 0;
    }

    const uidText = readCookieValue(this.cookieJar, 'DedeUserID');
    const cookieUid = uidText && /^[0-9]+$/.test(uidText) ? Number(uidText) : 0;
    const uid = apiUid > 0 ? apiUid : cookieUid;
    const buvid = this.buvid
      || readCookieValue(this.cookieJar, 'buvid3')
      || readCookieValue(this.cookieJar, 'buvid4')
      || readCookieValue(this.cookieJar, 'buvid_fp');

    return {
      roomId: resolvedRoomId,
      address,
      key: token,
      uid,
      buvid,
      protover: 3,
    };
  }

  private useCookie(cookie: string): void {
    const normalized = cookie.trim();
    if (normalized === this.baseCookie) {
      return;
    }

    this.baseCookie = normalized;
    this.cookieJar = normalized;
    this.buvid = '';
    this.sessionWarmAt = 0;
  }

  private buildBiliHeaders(): Headers {
    const headers = new Headers();
    headers.set('User-Agent', getStartupBilibiliUserAgent());
    headers.set('Accept', 'application/json, text/plain, */*');
    headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    headers.set('Origin', 'https://www.bilibili.com');
    headers.set('Referer', 'https://www.bilibili.com/');

    const cookie = this.cookieJar.trim();
    if (cookie) {
      headers.set('Cookie', cookie);
    }
    return headers;
  }

  private async queryBiliApi(url: string, method: string = 'GET', body?: unknown): Promise<Response> {
    const headers = this.buildBiliHeaders();
    const options: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined) {
      if (typeof body === 'object' && body !== null) {
        headers.set('Content-Type', 'application/json');
        options.body = JSON.stringify(body);
      } else {
        options.body = String(body);
      }
    }

    const response = await this.fetchImpl(url, options);
    this.persistCookiesFromResponse(response);
    return response;
  }

  private persistCookiesFromResponse(response: Response): void {
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) {
      return;
    }
    const nextCookie = mergeCookieJar(this.cookieJar, setCookie);
    if (nextCookie) {
      this.cookieJar = nextCookie;
    }
  }

  private async warmupBiliSession(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.sessionWarmAt > 0 && now - this.sessionWarmAt < 10 * 60 * 1000) {
      return;
    }

    const response = await this.fetchImpl('https://api.bilibili.com/x/web-frontend/getbuvid', {
      method: 'GET',
      headers: this.buildBiliHeaders(),
    });
    this.persistCookiesFromResponse(response);
    if (response.ok) {
      const payload = await response.json() as {
        code?: unknown;
        data?: { buvid?: unknown };
      };
      if (payload.code === 0 && typeof payload.data?.buvid === 'string' && payload.data.buvid.trim()) {
        this.buvid = payload.data.buvid.trim();
      }
    }
    this.sessionWarmAt = now;
  }

  private async getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
    const now = Date.now();
    if (this.wbiImgKey && this.wbiSubKey && now < this.wbiKeyExpireAt) {
      return { imgKey: this.wbiImgKey, subKey: this.wbiSubKey };
    }

    const response = await this.queryBiliApi('https://api.bilibili.com/x/web-interface/nav');
    if (!response.ok) {
      throw new Error(`获取 WBI Key 失败: HTTP ${response.status}`);
    }
    const payload = await response.json() as {
      code?: unknown;
      data?: {
        wbi_img?: {
          img_url?: unknown;
          sub_url?: unknown;
        };
      };
      message?: unknown;
    };
    if (payload.code !== 0) {
      throw new Error(`获取 WBI Key 失败: ${String(payload.message ?? payload.code)}`);
    }

    const imgUrl = typeof payload.data?.wbi_img?.img_url === 'string' ? payload.data.wbi_img.img_url : '';
    const subUrl = typeof payload.data?.wbi_img?.sub_url === 'string' ? payload.data.wbi_img.sub_url : '';
    const imgName = imgUrl.split('/').pop()?.split('.')[0] ?? '';
    const subName = subUrl.split('/').pop()?.split('.')[0] ?? '';
    if (!imgName || !subName) {
      throw new Error('获取 WBI Key 失败: img/sub key 为空');
    }

    this.wbiImgKey = imgName;
    this.wbiSubKey = subName;
    this.wbiKeyExpireAt = now + WBI_KEY_REFRESH_INTERVAL_MS;
    return { imgKey: imgName, subKey: subName };
  }

  private async buildWbiQueryString(params: Record<string, string>): Promise<string> {
    const { imgKey, subKey } = await this.getWbiKeys();
    const mixinKey = getMixinKey(imgKey + subKey);
    const withWts: Record<string, string> = {
      ...params,
      wts: String(Math.floor(Date.now() / 1000)),
    };

    const sortedKeys = Object.keys(withWts).sort();
    const search = new URLSearchParams();
    for (const key of sortedKeys) {
      search.set(key, sanitizeWbiValue(withWts[key] ?? ''));
    }
    const query = search.toString();
    const wRid = md5Hex(query + mixinKey);
    search.set('w_rid', wRid);
    return search.toString();
  }
}
