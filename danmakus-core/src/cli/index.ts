#!/usr/bin/env node

import { Command } from 'commander';
import { DanmakuClient } from '../core/DanmakuClient';
import { attachCliEventListeners } from './runtime';
import { CliOptions } from '../types';

const program = new Command();
const DEFAULT_RUNTIME_URL = 'https://ukamnads.icu/api/v2/core-runtime';
const DEFAULT_COOKIE_CLOUD_HOST = 'https://cookie.danmakus.com';

program
  .name('danmakus')
  .description('轻量弹幕采集工具')
  .version('1.0.0');

program
  .option('-m, --max-connections <number>', '最大连接数 (1-100)', '15')
  .option('--capacity-override <number>', '上报给服务端的槽位覆盖数 (1-100)')
  .option('-t, --token <token>', '账号 Token（必填，用于加载远端配置）')
  .option('-k, --cookie-key <key>', 'CookieCloud密钥')
  .option('-p, --cookie-password <password>', 'CookieCloud密码')
  .option('--cookie-host <host>', 'CookieCloud服务器地址')
  .option('--status-check-interval <seconds>', '主播状态检查间隔（秒）', '30')
  .option('-v, --verbose', '详细输出')
  .option('--log-level <level>', '日志级别 (debug|info|warn|error|silent)')

  .action(async (options: CliOptions) => {

    try {
      // 解析参数
      const maxConnections = parseInt(String(options.maxConnections || '15'));
      if (isNaN(maxConnections) || maxConnections < 1 || maxConnections > 100) {
        console.error('错误: 最大连接数必须在1-100之间');
        process.exit(1);
      }

      const statusCheckInterval = parseInt(String(options.statusCheckInterval || '30'));
      const capacityOverride = options.capacityOverride !== undefined
        ? parseInt(String(options.capacityOverride))
        : undefined;
      const accountToken = options.token || process.env.DANMAKUS_TOKEN;
      const runtimeUrl = DEFAULT_RUNTIME_URL;
      const cookieCloudKey = options.cookieKey || process.env.DANMAKUS_COOKIECLOUD_KEY;
      const cookieCloudPassword = options.cookiePassword || process.env.DANMAKUS_COOKIECLOUD_PASSWORD;
      const cookieCloudHost = options.cookieHost || process.env.DANMAKUS_COOKIECLOUD_HOST || DEFAULT_COOKIE_CLOUD_HOST;
      const logLevel = options.logLevel || (options.verbose ? 'debug' : 'info');

      if (capacityOverride !== undefined && (isNaN(capacityOverride) || capacityOverride < 1 || capacityOverride > 100)) {
        console.error('错误: 槽位覆盖数必须在1-100之间');
        process.exit(1);
      }

      if (!accountToken) {
        console.error('错误: 必须提供账号 Token (--token)');
        process.exit(1);
      }

      // 显示启动信息
      console.log('=== 弹幕采集客户端 ===');
      console.log(`最大连接数: ${maxConnections}`);
      console.log(`Runtime服务器: ${runtimeUrl}`);
      console.log(`状态检查间隔: ${statusCheckInterval}秒`);
      console.log(`日志级别: ${logLevel}`);
      if (capacityOverride !== undefined) {
        console.log(`槽位覆盖数: ${capacityOverride}`);
      }

      console.log('账号配置: 自动从远端账号中心加载');

      if (cookieCloudKey && cookieCloudPassword) {
        console.log(`CookieCloud: ${cookieCloudHost}`);
      } else {
        console.log('未配置CookieCloud');
      }

      console.log('================\n');

      // 创建弹幕客户端
      const client = new DanmakuClient({
        maxConnections,
        cookieCloudKey,
        cookieCloudPassword,
        cookieCloudHost,
        runtimeUrl,
        statusCheckInterval,
        capacityOverride,
        cookieRefreshInterval: 3600,
        autoReconnect: true,
        reconnectInterval: 5000,
        accountToken,
        clientVersion: 'cli',
        logLevel
      });

      // 从CLI选项更新配置
      client.applyCliOptions(options);

      // 设置事件监听
      attachCliEventListeners(client, options, console);

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
              console.log(`Runtime连接: ${status.runtimeConnected}`);
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
    console.log('4. 使用 CookieCloud 环境变量:');
    console.log('   DANMAKUS_COOKIECLOUD_KEY="your-key" DANMAKUS_COOKIECLOUD_PASSWORD="your-password" danmakus --token "your-account-token"');

    console.log('');
    console.log('5. 完整示例:');
    console.log('   danmakus --token "your-account-token" -k "your-key" -p "your-password" \\');
    console.log('     --cookie-host "https://cookie.example.com" --status-check-interval 30 -m 5 --capacity-override 3 -v');

  });

program.parse();
