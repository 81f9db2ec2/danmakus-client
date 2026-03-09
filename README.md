# danmakus-client

`danmakus-client` 是Danmakus的弹幕客户端, 可以帮你记录弹幕并查询 😋

## 文档

- **用户文档**: [danmakus.com/client-doc](https://danmakus.com/client-doc) - 安装配置、使用说明、常见问题
- **danmakus-core**: [README.md](./danmakus-core/README.md) | [GitHub](https://github.com/81f9db2ec2/danmakus-client/blob/main/danmakus-core/README.md) - CLI 使用、Docker/PM2 部署、API 文档

## 目录说明

- `src/`: 前端界面与业务逻辑
- `danmakus-core/`: 采集核心（可独立作为库/CLI）
- `src-tauri/`: Tauri 相关代码

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
