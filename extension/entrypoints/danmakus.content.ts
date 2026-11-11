import type { ExtensionMessage } from '../utils/types';

export default defineContentScript({
  matches: ['https://danmakus.com/*'],
  runAt: 'document_idle',
  main() {
    let lastSyncedToken = '';

    const checkAndSyncToken = () => {
      try {
        const token = (window.localStorage.getItem('Token') ?? '').trim();
        if (token === lastSyncedToken) return;
        // token 变为空：本页会话中观察到退出登录，带上旧 token 让后台判断是否清除
        const message: ExtensionMessage = token
          ? { type: 'SYNC_DANMAKUS_TOKEN', token }
          : { type: 'SYNC_DANMAKUS_TOKEN', token: '', previousToken: lastSyncedToken };
        lastSyncedToken = token;
        void chrome.runtime.sendMessage(message).catch(() => {
          // ignore when extension context is reloading
        });
      } catch {
        // ignore storage access errors
      }
    };

    checkAndSyncToken();
    window.addEventListener('storage', checkAndSyncToken);
    window.addEventListener('focus', checkAndSyncToken);
    setInterval(checkAndSyncToken, 5000);
  },
});
