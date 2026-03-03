# danmakus-client

`danmakus-client` 是桌面采集客户端（Tauri + Vue + danmakus-core）。

## 目录说明

- `src/`: 前端界面与业务逻辑
- `danmakus-core/`: 采集核心（可独立作为库/CLI）
- `src-tauri/`: Tauri 桌面壳
- `scripts/`: 联调脚本（冒烟、契约检查）

## 开发命令

```bash
bun install

# 前端开发
bun run dev

# 生产构建（含类型检查）
bun run build

# Tauri 开发
bun run tauri dev
```

## 环境变量

复制 `.env.example` 为 `.env` 后按需修改：

```bash
Copy-Item .env.example .env
```
