import { createApp } from 'vue';
import '../../assets/tailwind.css';
import BiliEnhancerRoot from '../../components/BiliEnhancerRoot.vue';

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
        const syncDarkTheme = () => {
          const isBiliDark =
            document.documentElement.classList.contains('dark') ||
            document.documentElement.getAttribute('data-dark') === 'true' ||
            document.body?.classList.contains('dark') ||
            window.matchMedia('(prefers-color-scheme: dark)').matches;
          container.classList.toggle('dark', isBiliDark);
          shadow.host.classList.toggle('dark', isBiliDark);
        };
        syncDarkTheme();

        const observer = new MutationObserver(syncDarkTheme);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-dark', 'theme'],
        });

        const app = createApp(BiliEnhancerRoot);
        app.mount(container);
        return { app, observer };
      },
      onRemove(mounted) {
        mounted?.observer.disconnect();
        mounted?.app.unmount();
      },
    });

    ui.mount();
  },
});
