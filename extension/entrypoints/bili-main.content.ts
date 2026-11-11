/**
 * 运行在 B站页面 MAIN world（主世界）的轻量桥接脚本：
 * 1. 直接读取 B站 SSR / 全局对象 (`window.__NEPTUNE_IS_MY_WAIFU__`, `window.BilibiliLive`, `window.__INITIAL_STATE__`)
 *    秒级提取当前直播间真实 roomId、主播 UID、当前登录观众信息，无需额外发 HTTP 请求。
 * 2. 点击弹幕/SC/高能榜用户名时不拦截 B 站原生菜单；从 Vue 实例取出 UID，等原生菜单出现后嵌入「在 Danmakus 查看发言」。
 */
export default defineContentScript({
  matches: [
    '*://live.bilibili.com/*',
    '*://space.bilibili.com/*',
  ],
  world: 'MAIN',
  runAt: 'document_idle',
  main() {
    const PAGE_CONTEXT_EVENT = 'danmakus:bili-page-context';
    const USER_CLICK_EVENT = 'danmakus:bili-user-click';
    const REQUEST_CONTEXT_EVENT = 'danmakus:request-bili-context';
    const USER_MENU_EVENT = 'danmakus:bili-user-menu';

    function extractPageContext() {
      const w = window as any;
      let roomId: number | null = null;
      let streamerUid: number | null = null;
      let streamerUname: string | null = null;
      let loginUid: number | null = null;
      let loginUname: string | null = null;

      // 1. 直播间 SSR 数据 (__NEPTUNE_IS_MY_WAIFU__)
      const neptune = w.__NEPTUNE_IS_MY_WAIFU__;
      if (neptune) {
        const playInfo = neptune.roomInitRes?.data;
        const baseInfo = neptune.roomInfoRes?.data;
        roomId = Number(playInfo?.room_id || baseInfo?.room_info?.room_id || 0) || null;
        streamerUid = Number(playInfo?.uid || baseInfo?.room_info?.uid || 0) || null;
        streamerUname = baseInfo?.anchor_info?.base_info?.uname || null;
      }

      // 2. 直播间全局 BilibiliLive 对象兜底
      if (w.BilibiliLive) {
        if (!roomId && Number(w.BilibiliLive.ROOMID) > 0) {
          roomId = Number(w.BilibiliLive.ROOMID);
        }
        if (!streamerUid && Number(w.BilibiliLive.ANCHOR_UID) > 0) {
          streamerUid = Number(w.BilibiliLive.ANCHOR_UID);
        }
        if (Number(w.BilibiliLive.UID) > 0) {
          loginUid = Number(w.BilibiliLive.UID);
        }
      }

      // 3. 个人空间 / 主站 __INITIAL_STATE__ 或 __pinia
      const initState = w.__INITIAL_STATE__;
      if (initState) {
        const mid = Number(initState.mid || initState.user?.mid || 0);
        if (mid > 0 && !streamerUid && location.hostname === 'space.bilibili.com') {
          streamerUid = mid;
          streamerUname = initState.user?.name || initState.space?.info?.name || null;
        }
        const navLoginUid = Number(initState.loginInfo?.mid || 0);
        if (navLoginUid > 0 && !loginUid) {
          loginUid = navLoginUid;
          loginUname = initState.loginInfo?.uname || null;
        }
      }

      // 4. 从页面头部头像组件 Vue 实例提取当前登录用户
      if (!loginUid) {
        const headerEntry = document.querySelector('.v-popover-wrap.header-avatar-wrap, .bili-header .header-entry-mini');
        const userFromHeader = extractUserFromVueNode(headerEntry as HTMLElement | null);
        if (userFromHeader?.uid) {
          loginUid = userFromHeader.uid;
          loginUname = userFromHeader.uname || null;
        }
      }

      return {
        href: location.href,
        roomId,
        streamerUid,
        streamerUname,
        loginUid,
        loginUname,
      };
    }

    function probeObjectForBiliUser(obj: any, depth = 0): { uid: number; uname?: string } | null {
      if (!obj || typeof obj !== 'object' || depth > 3) return null;

      // 直接字段匹配 (B站直播间弹幕 item / SC item / 高能榜 item 常见结构)
      const rawUid =
        obj.uid ??
        obj.userId ??
        obj.user_id ??
        obj.mid ??
        obj.sender_uid ??
        obj.userInfo?.uid ??
        obj.user?.uid ??
        obj.uinfo?.uid ??
        obj.data?.uid;

      const uid = Number(rawUid);
      if (Number.isFinite(uid) && uid > 0) {
        const rawName =
          obj.uname ??
          obj.username ??
          obj.userName ??
          obj.name ??
          obj.userInfo?.uname ??
          obj.userInfo?.name ??
          obj.user?.uname ??
          obj.uinfo?.base?.name ??
          obj.data?.uname;
        return {
          uid: Math.floor(uid),
          uname: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined,
        };
      }

      // 常见容器属性递归一层
      for (const key of ['item', 'data', 'info', 'msg', 'danmaku', 'chat', 'user', 'uinfo', 'card']) {
        if (obj[key] && typeof obj[key] === 'object') {
          const found = probeObjectForBiliUser(obj[key], depth + 1);
          if (found) return found;
        }
      }

      return null;
    }

    function extractUserFromVueNode(startEl: HTMLElement | null): { uid: number; uname?: string } | null {
      let el: HTMLElement | null = startEl;
      let hops = 0;

      while (el && hops < 12) {
        const anyEl = el as any;

        // 1. DOM dataset 优先快速路径
        if (el.dataset?.uid || el.dataset?.userId) {
          const uid = Number(el.dataset.uid || el.dataset.userId);
          if (Number.isFinite(uid) && uid > 0) {
            const uname =
              el.dataset.uname ||
              el.querySelector('.user-name, .u-name, .name')?.textContent?.replace(/[:：]\s*$/, '')?.trim() ||
              undefined;
            return { uid, uname };
          }
        }

        // 2. Vue 2 实例 (el.__vue__)
        if (anyEl.__vue__) {
          const vm = anyEl.__vue__;
          const fromProps = probeObjectForBiliUser(vm.$props) || probeObjectForBiliUser(vm.$options?.propsData);
          if (fromProps) return fromProps;
          const fromData = probeObjectForBiliUser(vm.$data) || probeObjectForBiliUser(vm);
          if (fromData) return fromData;
        }

        // 3. Vue 3 组件实例 (el.__vueParentComponent)
        if (anyEl.__vueParentComponent) {
          let comp = anyEl.__vueParentComponent;
          let compHops = 0;
          while (comp && compHops < 6) {
            const found =
              probeObjectForBiliUser(comp.props) ||
              probeObjectForBiliUser(comp.vnode?.props) ||
              probeObjectForBiliUser(comp.setupState) ||
              probeObjectForBiliUser(comp.data) ||
              probeObjectForBiliUser(comp.ctx);
            if (found) return found;
            comp = comp.parent;
            compHops++;
          }
        }

        el = el.parentElement;
        hops++;
      }

      return null;
    }

    const NATIVE_MENU_SELECTORS = [
      '.user-card',
      '.user-panel',
      '.chat-user-panel',
      '.user-panel-ctnr',
      '.prompt-card',
      '.danmaku-menu',
      '.pointer-menu',
      '.context-menu',
      '.v-popover',
      '.el-popover',
      '[class*="user-card"]',
      '[class*="user-panel"]',
      '[class*="UserCard"]',
      '[class*="userCard"]',
    ].join(',');

    const ACTION_LABEL = /^(?:屏蔽|举报|拉黑|禁言|加入黑名单|关注|取消关注|发消息|发私信|查看主页)$/;
    const MENU_ACTION_HINT = /屏蔽|举报|拉黑|禁言|加入黑名单/;

    let pendingUser: { uid: number; uname?: string } | null = null;
    let injectTimer: number | null = null;

    function isVisiblePanel(el: HTMLElement): boolean {
      if (el.closest('danmakus-bili-enhancer')) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 48 || rect.width > 560 || rect.height > 720) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function findNativeActionItem(menu: HTMLElement): HTMLElement | null {
      let leaf: HTMLElement | null = null;
      for (const node of menu.querySelectorAll<HTMLElement>('button, a, li, span, div')) {
        const text = node.textContent?.replace(/\s+/g, '') ?? '';
        if (ACTION_LABEL.test(text) && node.children.length <= 2) {
          leaf = node;
          break;
        }
      }
      if (!leaf) return null;
      let el: HTMLElement = leaf;
      for (let i = 0; i < 4 && el.parentElement && el.parentElement !== menu; i++) {
        const siblings = [...el.parentElement.children].filter(
          (child) =>
            child instanceof HTMLElement &&
            ACTION_LABEL.test((child.textContent ?? '').replace(/\s+/g, '')),
        );
        if (siblings.length >= 2) return el;
        el = el.parentElement;
      }
      return leaf.closest('button, a, li') ?? leaf;
    }

    function findNativeUserMenu(): HTMLElement | null {
      const ranked: HTMLElement[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(NATIVE_MENU_SELECTORS)) {
        if (!isVisiblePanel(el)) continue;
        if (MENU_ACTION_HINT.test(el.textContent ?? '')) ranked.push(el);
      }
      if (ranked.length === 0) {
        for (const el of document.body.children) {
          if (!(el instanceof HTMLElement) || !isVisiblePanel(el)) continue;
          if (!MENU_ACTION_HINT.test(el.textContent ?? '')) continue;
          const style = getComputedStyle(el);
          if (style.position === 'absolute' || style.position === 'fixed') ranked.push(el);
        }
      }
      ranked.sort((a, b) => a.offsetWidth * a.offsetHeight - b.offsetWidth * b.offsetHeight);
      return ranked[0] ?? null;
    }

    /** 原生菜单会被复用给不同用户，已注入过就只更新 uid */
    function injectLookupItem(menu: HTMLElement, user: { uid: number; uname?: string }) {
      const uid = String(user.uid);
      let node = menu.querySelector<HTMLElement>('[data-danmakus-lookup]');
      if (!node) {
        const actionItem = findNativeActionItem(menu);
        node = actionItem ? (actionItem.cloneNode(false) as HTMLElement) : document.createElement('div');
        node.removeAttribute('href');
        node.removeAttribute('id');
        node.textContent = '在 Danmakus 查看发言';
        node.style.cursor = 'pointer';
        node.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(USER_CLICK_EVENT, {
              detail: {
                uid: Number(node!.dataset.danmakusLookup),
                uname: node!.dataset.danmakusUname,
                clientX: event.clientX,
                clientY: event.clientY,
              },
            }),
          );
        });
        (actionItem?.parentElement ?? menu).appendChild(node);
      }
      node.dataset.danmakusLookup = uid;
      node.dataset.danmakusUname = user.uname ?? '';
      if (menu.dataset.danmakusUid !== uid) {
        menu.dataset.danmakusUid = uid;
        // 隔离世界的卡片脚本读不到 Vue 实例，由这里把 uid 标在菜单上并通知它挂载弹幕记录
        menu.dispatchEvent(new CustomEvent(USER_MENU_EVENT, { bubbles: true }));
      }
    }

    function tryInjectLookupItem() {
      const menu = findNativeUserMenu();
      if (!menu) return;
      const user = extractUserFromVueNode(menu) ?? pendingUser;
      if (!user || user.uid <= 0) return;
      injectLookupItem(menu, user);
    }

    function scheduleMenuInject() {
      if (injectTimer !== null) window.clearInterval(injectTimer);
      let attempts = 0;
      const tick = () => {
        attempts += 1;
        tryInjectLookupItem();
        if (attempts >= 24) {
          if (injectTimer !== null) window.clearInterval(injectTimer);
          injectTimer = null;
        }
      };
      tick();
      injectTimer = window.setInterval(tick, 50);
    }

    function broadcastPageContext() {
      const detail = extractPageContext();
      window.dispatchEvent(new CustomEvent(PAGE_CONTEXT_EVENT, { detail }));
    }

    window.addEventListener(REQUEST_CONTEXT_EVENT, () => {
      broadcastPageContext();
    });

    // 不拦截点击：仅记录被点用户，等 B 站原生菜单出来后嵌入一项
    document.addEventListener('click', (event) => {
      if (location.hostname !== 'live.bilibili.com') return;
      const target = event.target as HTMLElement | null;
      if (!target || target.closest('danmakus-bili-enhancer')) return;
      if (target.closest('[data-danmakus-lookup]')) return;

      const inInteractiveArea = Boolean(
        target.closest(
          '#chat-items, .chat-history-list, .danmaku-item-container, .pay-note-panel, .rank-list-cntr, .guard-rank-cntr, .online-rank-cntr, .brush-prompt',
        ),
      );
      if (!inInteractiveArea) return;

      const user = extractUserFromVueNode(target);
      if (user && user.uid > 0) pendingUser = user;
      scheduleMenuInject();
    });

    broadcastPageContext();
    setTimeout(broadcastPageContext, 1200);
  },
});
