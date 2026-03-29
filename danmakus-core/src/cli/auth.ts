import QRCode from 'qrcode';
import { BilibiliAuthApi } from '../core/BilibiliAuthApi.js';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

export function createCliInteractiveLoginProvider(fetchImpl?: FetchImpl): () => Promise<string> {
  const authApi = new BilibiliAuthApi(fetchImpl);

  return async () => {
    const session = await authApi.createQrLoginSession();
    const { url } = session.getInfo();
    const terminalQr = await QRCode.toString(url, {
      type: 'terminal',
      small: true,
    });

    console.log('未检测到可用的 Bilibili Cookie，开始扫码登录...');
    console.log(terminalQr);
    console.log(`若二维码显示异常，请直接打开：${url}`);

    let previousStatus = '';
    while (true) {
      const result = await session.poll();
      if (result.status !== previousStatus) {
        previousStatus = result.status;
        if (result.status === 'waiting') {
          console.log('请使用哔哩哔哩手机客户端扫码。');
        } else if (result.status === 'scanned') {
          console.log('扫码成功，请在手机上确认。');
        }
      }

      if (result.status === 'confirmed') {
        console.log('扫码登录成功，正在继续启动核心...');
        return result.cookie;
      }

      if (result.status === 'expired') {
        throw new Error('二维码已过期，请重新启动客户端后重试');
      }

      if (result.status === 'unknown') {
        throw new Error('扫码登录状态未知，请稍后重试');
      }

      await sleep(2000);
    }
  };
}
