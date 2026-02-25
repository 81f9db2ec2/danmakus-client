# 使用Bun官方镜像
FROM oven/bun:1.0-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制依赖文件
COPY package.json bun.lock ./

# 安装依赖
RUN bun install

# 复制源代码
COPY . .

# 构建项目
RUN bun run build

# 运行阶段
FROM oven/bun:1.0-alpine

# 设置环境变量
ENV NODE_ENV=production

# 设置工作目录
WORKDIR /app

# 复制依赖文件
COPY package.json bun.lock ./

# 安装生产依赖
RUN bun install --production

# 复制构建产物
COPY --from=builder /app/dist ./dist

# 创建非root用户
RUN addgroup -g 1001 -S danmakus && \
    adduser -S danmakus -u 1001

# 切换到非root用户
USER danmakus

# 暴露端口（如果需要）
# EXPOSE 3000

# 设置启动命令
ENTRYPOINT ["bun", "dist/cli/index.js"]

# 默认参数（可以被覆盖）
CMD ["--help"]
