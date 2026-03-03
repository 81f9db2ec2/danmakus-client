#!/usr/bin/env node

import { Command } from 'commander';
import { DanmakuClient } from '../core/DanmakuClient';
import { CliOptions } from '../types';

const program = new Command();
const DEFAULT_SIGNALR_HUB_URL = process.env.DANMAKUS_SIGNALR_URL || 'https://ukamnads.icu/api/v2/user-hub';
const DEFAULT_ACCOUNT_API_BASE = process.env.DANMAKUS_ACCOUNT_API || 'https://ukamnads.icu/api/v2/account';

program
  .name('danmakus')
  .description('轻量弹幕采集工具')
  .version('1.0.0');

program
  .option('-m, --max-connections <number>', '最大连接数 (1-10)', '5')
  .option('-t, --token <token>', '账号 Token（必填，用于加载远端配置）')
  .option('--account-api <url>', '账号 API 地址', DEFAULT_ACCOUNT_API_BASE)
  .option('-s, --signalr-url <url>', 'SignalR Hub 地址（本地调试可覆盖）', DEFAULT_SIGNALR_HUB_URL)
  .option('-k, --cookie-key <key>', 'CookieCloud密钥')
  .option('-p, --cookie-password <password>', 'CookieCloud密码')
  .option('--cookie-host <host>', 'CookieCloud服务器地址', 'http://localhost:8088')
  .option('--status-check-interval <seconds>', '主播状态检查间隔（秒）', '30')
  .option('-v, --verbose', '详细输出')
  .option('--log-level <level>', '日志级别 (debug|info|warn|error|silent)')

  .action(async (options: CliOptions) => {

    try {
      // 解析参数
      const maxConnections = parseInt(String(options.maxConnections || '5'));
      if (isNaN(maxConnections) || maxConnections < 1 || maxConnections > 10) {
        console.error('错误: 最大连接数必须在1-10之间');
        process.exit(1);
      }

      const statusCheckInterval = parseInt(String(options.statusCheckInterval || '30'));
      const accountToken = options.token || process.env.DANMAKUS_TOKEN;
      const accountApiBase = options.accountApi || DEFAULT_ACCOUNT_API_BASE;
      const signalrUrl = options.signalrUrl || DEFAULT_SIGNALR_HUB_URL;
      const logLevel = options.logLevel || (options.verbose ? 'debug' : 'info');

      if (!accountToken) {
        console.error('错误: 必须提供账号 Token (--token)');
        process.exit(1);
      }

      // 显示启动信息
      console.log('=== 弹幕采集客户端 ===');
      console.log(`最大连接数: ${maxConnections}`);
      console.log(`SignalR服务器: ${signalrUrl}`);
      console.log(`账号 API: ${accountApiBase}`);
      console.log(`状态检查间隔: ${statusCheckInterval}秒`);
      console.log(`日志级别: ${logLevel}`);

      console.log('账号配置: 自动从远端账号中心加载');

      if (options.cookieKey && options.cookiePassword) {
        console.log(`CookieCloud: ${options.cookieHost}`);
      } else {
        console.log('未配置CookieCloud');
      }

      console.log('================\n');

      // 创建弹幕客户端
      const client = new DanmakuClient({
        maxConnections,
        cookieCloudKey: options.cookieKey,
        cookieCloudPassword: options.cookiePassword,
        cookieCloudHost: options.cookieHost,
        signalrUrl,
        statusCheckInterval,
        cookieRefreshInterval: 3600,
        autoReconnect: true,
        reconnectInterval: 5000,
        accountToken,
        accountApiBase,
        clientVersion: 'cli',
        logLevel
      });

      // 从CLI选项更新配置
      client.applyCliOptions(options);

      // 设置事件监听
      client.on('DANMU_MSG', (message) => {
        try {
          const info = message.data.info || [];
          const text = info[1] || '';
          const userInfo = info[2] || [];
          const username = userInfo[1] || '未知用户';

          if (options.verbose) {
            console.log(`[弹幕][房间${message.roomId}] ${username}: ${text}`);
          } else {
            console.log(`[${message.roomId}] ${username}: ${text}`);
          }
        } catch (error) {
          console.log(`[弹幕][房间${message.roomId}] 解析失败: ${message.raw}`);
        }
      });

      client.on('SEND_GIFT', (message) => {
        try {
          const data = message.data;
          const username = data.uname || '未知用户';
          const giftName = data.giftName || '未知礼物';
          const num = data.num || 1;

          console.log(`[礼物][房间${message.roomId}] ${username} 送出 ${num}个 ${giftName}`);
        } catch (error) {
          console.log(`[礼物][房间${message.roomId}] 解析失败: ${message.raw}`);
        }
      });

      // 监听所有消息（调试用）
      if (options.verbose) {
        client.on('msg', (message) => {
          console.log(`[DEBUG][房间${message.roomId}][${message.cmd}] ${message.raw.slice(0, 100)}...`);
        });
      }

      client.on('connected', (roomId) => {
        console.log(`✓ 房间 ${roomId} 连接成功`);
      });

      client.on('disconnected', (roomId) => {
        console.log(`✗ 房间 ${roomId} 连接断开`);
      });

      client.on('error', (error, roomId) => {
        if (roomId) {
          console.error(`✗ 房间 ${roomId} 发生错误:`, error.message);
        } else {
          console.error('✗ 客户端错误:', error.message);
        }
      });

      client.on('roomAssigned', (roomId) => {
        console.log(`🎯 服务器分配房间: ${roomId}`);
      });

      // 处理退出信号
      process.on('SIGINT', async () => {
        console.log('\n正在停止客户端...');
        await client.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        console.log('\n正在停止客户端...');
        await client.stop();
        process.exit(0);
      });

      // 启动客户端
      await client.start();

      // 显示状态命令提示
      if (options.verbose) {
        console.log('\n可用命令:');
        console.log('  Ctrl+C - 停止客户端');
        console.log('  输入 "status" - 查看状态');
        console.log('  输入 "rooms" - 查看连接的房间');

        // 简单的命令行交互
        const readline = require('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        rl.on('line', (input: string) => {
          const command = input.trim().toLowerCase();

          switch (command) {
            case 'status':
              const status = client.getStatus();
              console.log('\n=== 客户端状态 ===');
              console.log(`运行中: ${status.isRunning}`);
              console.log(`SignalR连接: ${status.signalrConnected}`);
              console.log(`Cookie有效: ${status.cookieValid}`);
              console.log(`连接房间数: ${status.connectedRooms.length}`);
              console.log('==================\n');
              break;

            case 'rooms':
              const rooms = client.getConnectedRooms();
              console.log('\n=== 连接的房间 ===');
              if (rooms.length > 0) {
                rooms.forEach(roomId => console.log(`  - 房间 ${roomId}`));
              } else {
                console.log('  无连接的房间');
              }
              console.log('==================\n');
              break;

            case 'help':
              console.log('\n可用命令:');
              console.log('  status - 查看客户端状态');
              console.log('  rooms - 查看连接的房间');
              console.log('  help - 显示帮助');
              console.log('  exit - 退出程序\n');
              break;

            case 'exit':
              console.log('正在退出...');
              client.stop().then(() => process.exit(0));
              break;

            default:
              if (command) {
                console.log(`未知命令: ${command}，输入 "help" 查看可用命令`);
              }
          }
        });
      }

    } catch (error) {
      console.error('启动失败:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// 添加示例命令
program
  .command('example')
  .description('显示使用示例')
  .action(() => {
    console.log('使用示例:');
    console.log('');
    console.log('1. 基本使用（账号中心远端配置）:');
    console.log('   danmakus --token "your-account-token"');

    console.log('');
    console.log('2. 使用环境变量传 Token:');
    console.log('   DANMAKUS_TOKEN="your-account-token" danmakus');

    console.log('');
    console.log('3. 使用 CookieCloud:');
    console.log('   danmakus --token "your-account-token" -k "your-key" -p "your-password"');

    console.log('');
    console.log('4. 本地联调覆盖 SignalR 地址:');
    console.log('   danmakus --token "your-account-token" -s "http://localhost:5000/api/v2/user-hub"');

    console.log('');
    console.log('5. 完整示例:');
    console.log('   danmakus --token "your-account-token" --account-api "https://api.example.com/api/v2/account" \\');
    console.log('     -s "https://api.example.com/api/v2/user-hub" -k "your-key" -p "your-password" \\');
    console.log('     --cookie-host "http://192.168.1.100:8088" --status-check-interval 30 -m 3 -v');

  });

program.parse();
