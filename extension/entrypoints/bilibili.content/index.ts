import { createApp } from 'vue';
import '../../assets/tailwind.css';
import BiliEnhancerRoot from '../../components/BiliEnhancerRoot.vue';
import { watchBiliDarkTheme } from '../../utils/bili-dom';

export default defineContentScript({
  matches: [
    '*://live.bilibili.com/*',
    '*://space.bilibili.com/*',
  ],
  cssInjectionMode: 'ui',
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'danmakus-bili-enhancer',
      position: 'inline',
      anchor: 'body',
      onMount(container, shadow) {
        const stopTheme = watchBiliDarkTheme(container, shadow.host as HTMLElement);
        const app = createApp(BiliEnhancerRoot);
        app.mount(container);
        return { app, stopTheme };
      },
      onRemove(mounted) {
        mounted?.stopTheme();
        mounted?.app.unmount();
      },
    });

    ui.mount();
  },
});
