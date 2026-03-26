import { DanmakuClient } from '../core/DanmakuClient';
import { CliOptions } from '../types';

type CliLogger = Pick<Console, 'log' | 'error'>;

export function attachCliEventListeners(
  client: Pick<DanmakuClient, 'on' | 'stop'>,
  _options: CliOptions,
  logger: CliLogger = console
): void {
  client.on('connected', (roomId) => {
    logger.log(`✓ 房间 ${roomId} 连接成功`);
  });

  client.on('disconnected', (roomId) => {
    logger.log(`✗ 房间 ${roomId} 连接断开`);
  });

  client.on('error', (error, roomId) => {
    if (roomId) {
      logger.error(`✗ 房间 ${roomId} 发生错误:`, error.message);
    } else {
      logger.error('✗ 客户端错误:', error.message);
    }
  });

}
