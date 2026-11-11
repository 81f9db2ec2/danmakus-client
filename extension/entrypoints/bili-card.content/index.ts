import { createApp, defineComponent, h, ref } from 'vue';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import '../../assets/tailwind.css';
import CardDanmakuHistory from '../../components/CardDanmakuHistory.vue';
import { BILI_CARD_ADAPTERS, LIVE_MENU_ADAPTER, LIVE_MENU_EVENT, type BiliCardAdapter } from '../../utils/bili-cards';
import { useCardSettings } from '../../utils/card-settings';

const OBSERVE_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  // 各卡片的显隐方式不同（v-show 内联样式 / Lit 属性或 class / data-danmakus-uid），不限定属性名，sync 已按微任务合并
  attributes: true,
};

/** 把弹幕记录面板嵌进 B 站原生用户卡片底部，卡片切换用户 / 显隐 / 重渲染时跟随同步 */
async function bindCard(ctx: ContentScriptContext, root: Element, adapter: BiliCardAdapter) {
  const uid = ref<number | null>(null);
  const CardRoot = defineComponent(() => {
    const settings = useCardSettings();
    return () =>
      settings.value?.enabled && uid.value
        ? h(CardDanmakuHistory, { uid: uid.value, settings: settings.value })
        : null;
  });
  const ui = await createShadowRootUi(ctx, {
    name: 'danmakus-card-history',
    position: 'inline',
    anchor: root,
    // 挂载位置由 sync 决定
    append: () => {},
    onMount(container) {
      const app = createApp(CardRoot);
      app.mount(container);
      return app;
    },
    onRemove(app) {
      app?.unmount();
    },
  });
  ui.mount();
  ui.shadowHost.style.display = 'block';
  if (adapter.hostWidth) ui.shadowHost.style.width = adapter.hostWidth;

  const observer = new MutationObserver(() => schedule());
  let observedShadow: ShadowRoot | null = null;
  let scheduled = false;

  const sync = () => {
    scheduled = false;
    // Lit 组件可能晚于节点插入才升级出 shadow root
    if (root.shadowRoot && root.shadowRoot !== observedShadow) {
      observedShadow = root.shadowRoot;
      observer.observe(observedShadow, OBSERVE_OPTIONS);
    }
    const scope = adapter.scope(root);
    const parent = scope && adapter.mountParent(scope);
    uid.value = parent && getComputedStyle(root).display !== 'none' ? adapter.readUid(scope) : null;
    if (parent && parent.lastChild !== ui.shadowHost) {
      parent.append(ui.shadowHost);
    }
    if (uid.value) adapter.afterSync?.(root as HTMLElement);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(sync);
  };

  observer.observe(root, OBSERVE_OPTIONS);
  sync();

  return () => {
    observer.disconnect();
    ui.remove();
  };
}

export default defineContentScript({
  matches: ['*://*.bilibili.com/*'],
  cssInjectionMode: 'ui',
  main(ctx) {
    const bindings = new Map<Element, Promise<() => void>>();

    const bind = (node: Element, adapter: BiliCardAdapter) => {
      if (!bindings.has(node)) bindings.set(node, bindCard(ctx, node, adapter));
    };
    const scan = (nodes: Iterable<Node>) => {
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        const adapter = BILI_CARD_ADAPTERS.find((item) => node.matches(item.selector!));
        if (adapter) bind(node, adapter);
      }
    };
    const release = (node: Element) => {
      const binding = bindings.get(node);
      if (!binding) return;
      bindings.delete(node);
      void binding.then((dispose) => dispose());
    };

    // 悬浮卡片都挂在 body 下，只监听 body 的直接子节点，避免在整页子树上做变更监听
    const bodyObserver = new MutationObserver((records) => {
      for (const record of records) {
        scan(record.addedNodes);
        record.removedNodes.forEach((node) => node instanceof Element && !node.isConnected && release(node));
      }
    });
    bodyObserver.observe(document.body, { childList: true });
    scan(document.body.children);

    // 直播间菜单嵌在聊天面板里，可能随面板重建而脱离文档，每次通知时顺带清理
    const onLiveMenu = (event: Event) => {
      for (const node of bindings.keys()) if (!node.isConnected) release(node);
      bind(event.target as Element, LIVE_MENU_ADAPTER);
    };
    document.addEventListener(LIVE_MENU_EVENT, onLiveMenu);

    ctx.onInvalidated(() => {
      bodyObserver.disconnect();
      document.removeEventListener(LIVE_MENU_EVENT, onLiveMenu);
      for (const node of [...bindings.keys()]) release(node);
    });
  },
});
