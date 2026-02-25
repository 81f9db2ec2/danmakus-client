# Danmakus Core

一个轻量级的 Bilibili 弹幕采集库，支持 CLI 和库引用两种使用方式。

## 功能特性

- 🚀 **轻量高效**: 基于 TypeScript 开发，体积小、性能优
- 🔌 **多平台支持**: 支持 CLI（Docker + Bun）和库引用（Tauri 浏览器环境）
- 📡 **SignalR 集成**: 通过 SignalR 实时上传弹幕数据到服务器
- 🍪 **CookieCloud 集成**: 定期从 CookieCloud 获取用户认证信息
- 🎯 **智能分配**: 服务器可动态分配监听直播间
- ⚙️ **灵活配置**: 支持命令行参数和编程配置

## 快速开始

### CLI 使用

#### 安装

```bash
# 使用npm
npm install -g danmakus-core

# 使用bun
bun install -g danmakus-core
```

#### 基本使用

```bash
# 监听指定房间
danmakus -r "123456,789012" -s "http://localhost:5000/danmakuHub"

# 使用CookieCloud
danmakus -k "your-key" -p "your-password" -s "http://localhost:5000/danmakuHub"

# 详细输出模式
danmakus -v -m 3 -s "http://localhost:5000/danmakuHub"
```

#### Docker 使用

```bash
# 构建镜像
docker build -t danmakus-core .

# 运行容器
docker run -it danmakus-core \
  -s "http://host.docker.internal:5000/danmakuHub" \
  -r "123456,789012" \
  -v
```

### 库引用

```typescript
import { DanmakuClient, createDanmakuClient } from 'danmakus-core';

// 方式1：直接实例化
const client = new DanmakuClient({
  maxConnections: 5,
  roomIds: [123456, 789012],
  signalrUrl: 'http://localhost:5000/danmakuHub',
  cookieCloudKey: 'your-key',
  cookieCloudPassword: 'your-password',
});

// 方式2：使用工厂函数
const client = createDanmakuClient({
  maxConnections: 3,
  signalrUrl: 'http://localhost:5000/danmakuHub',
});

// 事件监听
client.on('danmaku', (message) => {
  console.log(`[${message.roomId}] ${message.username}: ${message.message}`);
});

client.on('gift', (gift) => {
  console.log(`礼物: ${gift.username} 送出 ${gift.num}个 ${gift.giftName}`);
});

// 启动客户端
await client.start();
```

## 配置选项

### CLI 参数

| 参数                | 简写 | 描述                      | 默认值                |
| ------------------- | ---- | ------------------------- | --------------------- |
| `--max-connections` | `-m` | 最大连接数 (1-10)         | 5                     |
| `--rooms`           | `-r` | 要监听的房间 ID，逗号分隔 | -                     |
| `--cookie-key`      | `-k` | CookieCloud 密钥          | -                     |
| `--cookie-password` | `-p` | CookieCloud 密码          | -                     |
| `--cookie-host`     | `-h` | CookieCloud 服务器地址    | http://localhost:8088 |
| `--signalr-url`     | `-s` | SignalR 服务器地址        | 必需                  |
| `--verbose`         | `-v` | 详细输出                  | false                 |

### 编程配置

```typescript
interface DanmakuConfig {
  maxConnections: number; // 最大连接数
  roomIds: number[]; // 房间ID列表
  cookieCloudKey?: string; // CookieCloud密钥
  cookieCloudPassword?: string; // CookieCloud密码
  cookieCloudHost?: string; // CookieCloud服务器
  signalrUrl: string; // SignalR服务器地址
  cookieRefreshInterval: number; // Cookie刷新间隔（秒）
  autoReconnect: boolean; // 自动重连
  reconnectInterval: number; // 重连间隔（毫秒）
}
```

## 事件系统

```typescript
client.on('danmaku', (message: DanmakuMessage) => {
  // 收到弹幕消息
});

client.on('gift', (gift: GiftMessage) => {
  // 收到礼物消息
});

client.on('connected', (roomId: number) => {
  // 房间连接成功
});

client.on('disconnected', (roomId: number) => {
  // 房间连接断开
});

client.on('error', (error: Error, roomId?: number) => {
  // 发生错误
});

client.on('roomAssigned', (roomId: number) => {
  // 服务器分配新房间
});
```

## Docker Compose 示例

```yaml
version: '3.8'

services:
  danmakus-client:
    build: .
    environment:
      - NODE_ENV=production
    command: ['-s', 'http://signalr-server:5000/danmakuHub', '-r', '123456,789012', '-v']
    restart: unless-stopped

  # 如果需要CookieCloud
  danmakus-with-cookies:
    build: .
    environment:
      - NODE_ENV=production
    command:
      [
        '-s',
        'http://signalr-server:5000/danmakuHub',
        '-k',
        '${COOKIE_KEY}',
        '-p',
        '${COOKIE_PASSWORD}',
        '-h',
        'http://cookiecloud:8088',
        '-m',
        '3',
        '-v',
      ]
    restart: unless-stopped
```

## API 文档

### DanmakuClient

主要的弹幕客户端类。

#### 方法

- `start(): Promise<void>` - 启动客户端
- `stop(): Promise<void>` - 停止客户端
- `connectToRoom(roomId: number): Promise<void>` - 连接到指定房间
- `disconnectFromRoom(roomId: number): void` - 断开房间连接
- `getConnectedRooms(): number[]` - 获取已连接的房间列表
- `getStatus()` - 获取客户端状态

### 类型定义

详细的类型定义请参考 `src/types/index.ts` 文件。

## 开发

### 环境要求

- Node.js >= 18
- Bun >= 1.0 (推荐)

### 开发流程

```bash
# 克隆项目
git clone <repository-url>
cd danmakus-core

# 安装依赖
bun install

# 开发模式运行
bun run dev --help

# 构建项目
bun run build

# 运行CLI
bun run start --help
```

### 目录结构

```
danmakus-core/
├── src/
│   ├── core/           # 核心功能模块
│   │   ├── DanmakuClient.ts
│   │   ├── SignalRConnection.ts
│   │   ├── CookieManager.ts
│   │   └── ConfigManager.ts
│   ├── cli/            # CLI入口
│   │   └── index.ts
│   ├── lib/            # 库导出
│   │   └── index.ts
│   └── types/          # 类型定义
│       └── index.ts
├── dist/               # 编译输出
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！
