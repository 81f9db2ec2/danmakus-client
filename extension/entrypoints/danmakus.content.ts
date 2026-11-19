import type { ExtensionMessage } from '../utils/types';

export default defineContentScript({
  matches: ['https://danmakus.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    let lastSyncedToken = '';
    let syncing = false;

    const checkAndSyncToken = async () => {
      if (syncing) return;
      let token = '';
      try {
        token = (window.localStorage.getItem('Token') ?? '').trim();
      } catch {
        return;
      }
      if (token === lastSyncedToken) return;

      // token 变为空：本页会话中观察到退出登录，带上旧 token 让后台判断是否清除
      const message: ExtensionMessage = token
        ? { type: 'SYNC_DANMAKUS_TOKEN', token }
        : { type: 'SYNC_DANMAKUS_TOKEN', token: '', previousToken: lastSyncedToken };

      syncing = true;
      try {
        const res = (await chrome.runtime.sendMessage(message)) as { ok?: boolean } | undefined;
        if (res?.ok !== false) {
          lastSyncedToken = token;
        }
      } catch {
        // 扩展上下文重载等异常时不更新 lastSyncedToken，等待下次重试
      } finally {
        syncing = false;
      }
    };

    const onTrigger = () => {
      void checkAndSyncToken();
    };

    onTrigger();
    window.addEventListener('storage', onTrigger);
    window.addEventListener('focus', onTrigger);
    const timer = window.setInterval(onTrigger, 5000);

    ctx.onInvalidated(() => {
      window.removeEventListener('storage', onTrigger);
      window.removeEventListener('focus', onTrigger);
      window.clearInterval(timer);
    });
  },
});
