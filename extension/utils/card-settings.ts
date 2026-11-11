import { storage } from 'wxt/utils/storage';
import { onScopeDispose, shallowRef } from 'vue';

export interface CardSettings {
  /** 在 B 站用户卡片里显示弹幕记录 */
  enabled: boolean;
  /** 卡片打开就加载；关闭时需手动点一下，避免划过头像也计一次查询 */
  autoLoad: boolean;
  /** 每页直播场数 */
  pageSize: number;
  /** 隐藏只有进场记录的场次 */
  hideOnlyEnter: boolean;
  /** 显示直播封面缩略图 */
  showCover: boolean;
}

export const CARD_PAGE_SIZE_OPTIONS = [2, 3, 5, 8, 10] as const;

export const cardSettings = storage.defineItem<CardSettings>('local:danmakus_card_settings_v1', {
  fallback: {
    enabled: true,
    autoLoad: true,
    pageSize: 3,
    hideOnlyEnter: true,
    showCover: true,
  },
});

/** 响应式读取卡片设置，popup 修改后各标签页即时生效 */
export function useCardSettings() {
  const settings = shallowRef<CardSettings | null>(null);
  void cardSettings.getValue().then((value) => (settings.value = value));
  const unwatch = cardSettings.watch((value) => (settings.value = value));
  onScopeDispose(unwatch);
  return settings;
}
