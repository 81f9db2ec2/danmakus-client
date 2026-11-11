import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  // 直接引用 core 源码：bun 对 file: 依赖是复制而非链接，走 node_modules 会一直用旧快照
  alias: {
    'danmakus-core': fileURLToPath(new URL('../danmakus-core/src/lib/index.ts', import.meta.url)),
  },
  manifest: {
    name: 'Danmakus',
    short_name: 'Danmakus',
    description: 'Danmakus 浏览器扩展',
    icons: {
      32: 'icon/32.png',
      128: 'icon/128.png',
    },
    action: {
      default_icon: {
        32: 'icon/32.png',
        128: 'icon/128.png',
      },
    },
    web_accessible_resources: [
      {
        resources: ['icon/32.png', 'icon/128.png'],
        matches: ['*://*.bilibili.com/*', 'https://*.danmakus.com/*'],
      },
    ],
    permissions: [
      'storage',
      'cookies',
      'offscreen',
      'alarms',
      'declarativeNetRequestWithHostAccess',
    ],
    host_permissions: [
      '*://*.bilibili.com/*',
      'https://*.danmakus.com/*',
      'https://*.ukamnads.icu/*',
    ],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
