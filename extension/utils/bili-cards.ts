/**
 * B 站悬浮用户卡片适配表，内部结构各不相同：
 * - `<bili-user-profile>`：视频页评论区，Lit web component，内容在 open shadow root 的 `#wrap` 里
 * - `div.bili-user-profile`：动态 / 空间页，Vue 2 组件
 * - `.usercard-wrap > .user-card-m-exp`：视频页 UP 主 / 合作者头像，Vue 2 组件，每次显示都会重建内层
 * - 直播间弹幕用户菜单：uid 只在 Vue 实例上，由 MAIN world 桥接脚本标到 `data-danmakus-uid` 后通知
 */
export interface BiliCardAdapter {
  /** 前三类卡片是 body 的直接子节点，按选择器识别；直播间菜单由桥接事件交付，不走选择器 */
  selector?: string;
  /** 卡片内容所在的查询根 */
  scope(root: Element): ParentNode | null;
  /** 面板挂载到的父节点，面板始终保持为它的最后一个子节点 */
  mountParent(scope: ParentNode): Element | null;
  /** 加载中或出错时卡片里没有用户信息，返回 null */
  readUid(scope: ParentNode): number | null;
  /** 宿主卡片本身很窄时给面板定宽 */
  hostWidth?: string;
  /** 挂载后的附加处理，如把被撑高的菜单拉回视口 */
  afterSync?(root: HTMLElement): void;
}

const SPACE_LINK = /space\.bilibili\.com\/(\d+)/;

/** 卡片里的头像 / 昵称都链到用户空间 */
function readSpaceLinkUid(scope: ParentNode): number | null {
  for (const link of scope.querySelectorAll('a[href*="space.bilibili.com/"]')) {
    const match = link.getAttribute('href')?.match(SPACE_LINK);
    if (match) return Number(match[1]);
  }
  return null;
}

export const BILI_CARD_ADAPTERS: BiliCardAdapter[] = [
  {
    selector: 'bili-user-profile',
    scope: (root) => root.shadowRoot,
    mountParent: (scope) => scope.querySelector('#wrap'),
    readUid: readSpaceLinkUid,
  },
  {
    selector: 'div.bili-user-profile',
    scope: (root) => root,
    mountParent: (scope) => scope as Element,
    readUid: readSpaceLinkUid,
  },
  {
    selector: '.usercard-wrap',
    scope: (root) => root,
    mountParent: (scope) => scope.querySelector('.user-card-m-exp'),
    readUid: readSpaceLinkUid,
  },
];

export const LIVE_MENU_EVENT = 'danmakus:bili-user-menu';

export const LIVE_MENU_ADAPTER: BiliCardAdapter = {
  scope: (root) => root,
  mountParent: (scope) => scope as Element,
  readUid: (scope) => Number((scope as HTMLElement).dataset.danmakusUid) || null,
  hostWidth: '340px',
  afterSync(root) {
    // 菜单按点击位置定位，嵌入面板后变高可能超出视口底部
    requestAnimationFrame(() => {
      const rect = root.getBoundingClientRect();
      const overflow = rect.bottom - (window.innerHeight - 12);
      if (overflow > 0) root.style.top = `${Math.max(12 - rect.top, -overflow) + root.offsetTop}px`;
    });
  },
};
