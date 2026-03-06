import { DanmakuClient } from '../core/DanmakuClient';
import { CliOptions } from '../types';

type CliLogger = Pick<Console, 'log' | 'error'>;

export function attachCliEventListeners(
  client: Pick<DanmakuClient, 'on' | 'stop'>,
  _options: CliOptions,
  logger: CliLogger = console
): void {
  client.on('SEND_GIFT', (message) => {
    try {
      const data = message.data;
      const username = data.uname || '未知用户';
      const giftName = data.giftName || '未知礼物';
      const num = data.num || 1;

      logger.log(`[礼物][房间${message.roomId}] ${username} 送出 ${num}个 ${giftName}`);
    } catch {
      logger.log(`[礼物][房间${message.roomId}] 解析失败: ${message.raw}`);
    }
  });

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

  client.on('roomAssigned', (roomId) => {
    logger.log(`🎯 服务器分配房间: ${roomId}`);
  });
}
