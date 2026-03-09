# Danmakus Core

`danmakus-core` 是 `danmakus-client` 的采集内核，负责：

- 连接 Bilibili 直播间并解析消息
- 通过 Runtime API 上行消息
- 轮询主播状态并维护连接池
- 与账号中心同步

## CLI 使用

### 安装与运行

```bash
bun install
bun run build
bun run start --help
```

### 常用命令

```bash
# 最小启动
danmakus --token "your-account-token"

# 使用 CookieCloud
danmakus --token "your-account-token" -k "cookie-key" -p "cookie-password"
```

### CLI 参数

| 参数 | 简写 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `--max-connections <number>` | `-m` | 最大连接数，范围 `1-100` | `15` |
| `--token <token>` | `-t` | 账号 Token（必填） | - |
| `--cookie-key <key>` | `-k` | CookieCloud Key | - |
| `--cookie-password <password>` | `-p` | CookieCloud Password | - |
| `--cookie-host <host>` | - | CookieCloud 服务地址 | `https://cookie.danmakus.com` |
| `--log-level <level>` | - | 日志级别：`debug/info/warn/error/silent` | `info` |
| `--verbose` | `-v` | 详细日志 | `false` |

### CLI 环境变量

| 变量 | 说明 |
| --- | --- |
| `DANMAKUS_TOKEN` | 等价于 `--token` |
| `DANMAKUS_COOKIECLOUD_HOST` | 等价于 `--cookie-host` |
| `DANMAKUS_COOKIECLOUD_KEY` | 等价于 `--cookie-key` |
| `DANMAKUS_COOKIECLOUD_PASSWORD` | 等价于 `--cookie-password` |

### CookieCloud 说明

[CookieCloud](https://github.com/easychen/CookieCloud) 是一个浏览器扩展，可以把 Cookie 同步到云端。使用端到端加密，只有你知道密钥。

本站提供实例：`https://cookie.danmakus.com/`，也可自建。配置示例：

- **服务器地址**：`https://cookie.danmakus.com/`
- **同步域名关键词**：`bilibili.com`
- **同步 Local Storage**：否

只会读取 bilibili.com 的 Cookie。

## 作为库使用

```ts
import { DanmakuClient } from 'danmakus-core';

const client = new DanmakuClient({
  maxConnections: 15,
  accountToken: process.env.DANMAKUS_TOKEN,
  streamers: [
    { roomId: 123456, priority: 'high', name: '主播A' }
  ]
});

client.on('msg', (message) => {
  console.log(`[${message.roomId}] ${message.cmd}`);
});

client.on('streamerStatusUpdated', () => {
  const status = client.getStatus();
  console.log('holding rooms:', status.holdingRooms);
});

await client.start();
```

## 关键类型（节选）

```ts
interface StreamerConfig {
  roomId: number;
  priority: 'high' | 'normal' | 'low';
  name?: string;
}

interface DanmakuConfig {
  maxConnections: number;
  streamers: StreamerConfig[];
  accountToken?: string;
  cookieProvider?: () => string | null | undefined;
  cookieCloudKey?: string;
  cookieCloudPassword?: string;
}
```

## 事件

- `msg`: 所有消息（统一结构）
- `<CMD>`: 按原始 `cmd` 动态派发（如 `DANMU_MSG`、`SEND_GIFT`）
- `connected`: 房间连接成功
- `disconnected`: 房间断开
- `error`: 客户端或房间错误
- `streamerStatusUpdated`: 主播状态刷新，可结合 `getStatus().holdingRooms` 读取当前持有房间

## 开发说明

```bash
# 运行 CLI
bun run dev --token "your-account-token"

# 构建
bun run build

# 类型检查
bun run compile
```

## Docker 部署

### 使用预构建镜像（推荐）

```bash
# 最小启动
docker run -d --name danmakus \
  -e DANMAKUS_TOKEN="your-account-token" \
  ghcr.io/81f9db2ec2/danmakus-core

# 使用 CookieCloud
docker run -d --name danmakus \
  -e DANMAKUS_TOKEN="your-account-token" \
  -e DANMAKUS_COOKIECLOUD_KEY="cookie-key" \
  -e DANMAKUS_COOKIECLOUD_PASSWORD="cookie-password" \
  -e DANMAKUS_COOKIECLOUD_HOST="https://cookie.example.com" \
  ghcr.io/81f9db2ec2/danmakus-core
```

### 自行构建

```bash
cd danmakus-core
docker build -t danmakus-core .
docker run -d --name danmakus -e DANMAKUS_TOKEN="your-token" danmakus-core
```

### Docker Compose（推荐）

推荐使用 [Watchtower](https://containrrr.dev/watchtower/) 自动更新镜像：

```yaml
# docker-compose.yml
services:
  danmakus:
    image: ghcr.io/81f9db2ec2/danmakus-core
    container_name: danmakus
    restart: unless-stopped
    environment:
      - DANMAKUS_TOKEN=your-account-token
      # DANMAKUS_COOKIECLOUD_KEY=cookie-key
      # DANMAKUS_COOKIECLOUD_PASSWORD=cookie-password

  watchtower:
    image: containrrr/watchtower
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 3600 danmakus
```

```bash
docker compose up -d
```

Watchtower 会每小时检查一次 `danmakus-core` 镜像更新并自动重启容器。

## PM2 部署

```bash
cd danmakus-core
bun install

# 启动
export DANMAKUS_TOKEN="your-account-token"
pm2 start src/cli/index.ts --name danmakus --interpreter bun

# 带参数启动
pm2 start src/cli/index.ts --name danmakus --interpreter bun -- -t "your-token" -m 20
```

### 常用 PM2 命令

```bash
pm2 logs danmakus     # 查看日志
pm2 restart danmakus  # 重启
pm2 stop danmakus     # 停止
pm2 delete danmakus   # 删除
pm2 save              # 保存进程列表
pm2 startup           # 设置开机自启
```
