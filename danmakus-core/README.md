# Danmakus Core

`danmakus-core` 是 `danmakus-client` 的采集内核，负责：

- 连接 Bilibili 直播间并解析消息
- 通过 Runtime API 上行消息
- 轮询主播状态并维护连接池
- 与账号中心同步核心运行态

## 当前行为说明

- CLI 以账号中心配置为主（需要 `Token`）。
- 主播列表、连接参数默认从 `/api/v2/account/core-config` 拉取。
- Cookie 策略固定为 `BiliLocal > CookieCloud`（本地扫码 Cookie 优先）。
- Runtime 默认地址：`https://ukamnads.icu/api/v2/core-runtime`，可通过参数覆盖。

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

# 本地联调：覆盖 Runtime API 地址
danmakus --token "your-account-token" -s "http://localhost:5000/api/v2/core-runtime"
```

### CLI 参数

| 参数 | 简写 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `--max-connections <number>` | `-m` | 最大连接数，范围 `1-10` | `5` |
| `--token <token>` | `-t` | 账号 Token（必填） | - |
| `--account-api <url>` | - | 账号 API 地址 | `https://ukamnads.icu/api/v2/account` |
| `--runtime-url <url>` | `-s` | Runtime API 地址 | `https://ukamnads.icu/api/v2/core-runtime` |
| `--cookie-key <key>` | `-k` | CookieCloud Key | - |
| `--cookie-password <password>` | `-p` | CookieCloud Password | - |
| `--cookie-host <host>` | - | CookieCloud 服务地址 | `http://localhost:8088` |
| `--status-check-interval <seconds>` | - | 主播状态检查间隔（秒） | `30` |
| `--log-level <level>` | - | 日志级别：`debug/info/warn/error/silent` | `info` |
| `--verbose` | `-v` | 详细日志 | `false` |

### CLI 环境变量

| 变量 | 说明 |
| --- | --- |
| `DANMAKUS_TOKEN` | 等价于 `--token` |
| `DANMAKUS_ACCOUNT_API` | 等价于 `--account-api` 默认值 |
| `DANMAKUS_RUNTIME_URL` | 等价于 `--runtime-url` 默认值 |

## 作为库使用

```ts
import { DanmakuClient } from 'danmakus-core';

const client = new DanmakuClient({
  maxConnections: 5,
  runtimeUrl: 'https://ukamnads.icu/api/v2/core-runtime',
  accountToken: process.env.DANMAKUS_TOKEN,
  accountApiBase: 'https://ukamnads.icu/api/v2/account',
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
  runtimeUrl: string;
  accountToken?: string;
  accountApiBase?: string;
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
bun run dev -- --token "your-account-token"

# 构建
bun run build

# 类型检查
bun run compile
```
