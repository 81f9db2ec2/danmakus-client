import {
  DanmakuPayloadKindV3,
  DanmakuType,
  type DanmakuFrameV3,
  type DanmakuPayloadV3,
  type DanmakuRecordV3,
  type DecodedDanmakuItem,
} from './types';

const BILI_CDN_PREFIX = 'https://i0.hdslb.com';

export function resolveRoomEmojiUrl(resource: string): string {
  if (!resource) return '';
  if (/^https?:\/\//i.test(resource)) return resource;
  if (!resource.startsWith('/')) return `${BILI_CDN_PREFIX}/${resource}`;
  return `${BILI_CDN_PREFIX}${resource}`;
}

export function decodeDanmakuFrameV3(
  frame: DanmakuFrameV3 | null | undefined,
  idPrefix = '',
): DecodedDanmakuItem[] {
  if (!frame || !Array.isArray(frame.records)) {
    return [];
  }
  return frame.records.map((record, index) =>
    decodeRecord(frame, record, index, idPrefix),
  );
}

function decodeRecord(
  frame: DanmakuFrameV3,
  record: DanmakuRecordV3,
  index: number,
  idPrefix: string,
): DecodedDanmakuItem {
  const actor =
    record.actorId !== undefined ? frame.actors?.[record.actorId] : undefined;
  const sendDate = record.ts;
  const stablePrefix = idPrefix ? `${idPrefix}-` : '';
  const item: DecodedDanmakuItem = {
    id: `${stablePrefix}${sendDate}-${index}`,
    uId: actor?.uid ?? -1,
    uName: actor?.name ?? '',
    type: record.type,
    sendDate,
    message: '',
  };

  const payload: DanmakuPayloadV3 | undefined = record.payload ?? undefined;
  switch (record.payloadKind) {
    case DanmakuPayloadKindV3.TextMessage:
      item.message = payload?.rawText ?? '';
      break;
    case DanmakuPayloadKindV3.RoomEmojiMessage: {
      const emojiId = payload?.roomEmojiId;
      const emoji = emojiId !== undefined ? frame.roomEmojis?.[emojiId] : undefined;
      if (emoji) {
        item.roomEmojiUrl = resolveRoomEmojiUrl(emoji.resource);
        item.message = emoji.name ? `[${emoji.name}]` : '[表情]';
      }
      break;
    }
    case DanmakuPayloadKindV3.Gift:
      item.message = payload?.name ?? '礼物';
      item.count = payload?.count;
      item.price = payload?.price;
      item.mysteryBoxName = payload?.mysteryBoxName;
      break;
    case DanmakuPayloadKindV3.Guard:
      item.message = payload?.name ?? '大航海';
      item.count = payload?.count;
      item.price = payload?.price;
      break;
    case DanmakuPayloadKindV3.SuperChat:
      item.message = payload?.text ?? '';
      item.price = payload?.price;
      break;
    case DanmakuPayloadKindV3.TitleChange:
      item.message = payload?.currentTitle ?? '';
      break;
    case DanmakuPayloadKindV3.AreaChange:
      item.message = payload?.currentArea ?? '';
      break;
    case DanmakuPayloadKindV3.Warning:
    case DanmakuPayloadKindV3.RecordStart:
    case DanmakuPayloadKindV3.RecordInterrupt:
      item.message = payload?.text ?? '';
      break;
    case DanmakuPayloadKindV3.Enter:
      // count 是进场动作种类，不是数量，不能当×N 展示
      item.message = enterActionLabel(payload?.count);
      break;
    default:
      break;
  }

  if (record.type === DanmakuType.Enter && !item.message) {
    item.message = enterActionLabel(item.count);
    item.count = undefined;
  }

  return item;
}

function enterActionLabel(count?: number): string {
  if (count === 1) return '关注直播间';
  if (count === 2) return '分享直播间';
  return '进入直播间';
}

export function filterInteractiveDanmakus(items: DecodedDanmakuItem[]): DecodedDanmakuItem[] {
  return items.filter(
    (item) =>
      item.type === DanmakuType.Text ||
      item.type === DanmakuType.Gift ||
      item.type === DanmakuType.Guard ||
      item.type === DanmakuType.SuperChat ||
      item.type === DanmakuType.Enter,
  );
}

export function formatRelativeTime(tsMs: number): string {
  if (!tsMs || tsMs <= 0) return '';
  const normalized = tsMs < 10_000_000_000 ? tsMs * 1000 : tsMs;
  const diffSec = Math.floor((Date.now() - normalized) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}天前`;
  const d = new Date(normalized);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDateTime(tsMs: number): string {
  if (!tsMs || tsMs <= 0) return '-';
  const normalized = tsMs < 10_000_000_000 ? tsMs * 1000 : tsMs;
  const d = new Date(normalized);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTimeOnly(tsMs: number): string {
  if (!tsMs || tsMs <= 0) return '';
  const normalized = tsMs < 10_000_000_000 ? tsMs * 1000 : tsMs;
  const d = new Date(normalized);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatCompactNumber(num: number | undefined | null): string {
  const n = Number(num ?? 0);
  if (!Number.isFinite(n)) return '0';
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCurrency(amount: number | undefined | null): string {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '¥0';
  if (n >= 10000) return `¥${(n / 10000).toFixed(2)}w`;
  return `¥${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)}`;
}
