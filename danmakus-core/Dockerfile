FROM oven/bun:1 AS base

WORKDIR /app

FROM base AS install

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS build

COPY --from=install /app/node_modules ./node_modules
COPY . .
RUN bun build --compile --minify --target=bun-linux-x64-musl ./src/cli/index.ts --outfile ./dist/danmakus

FROM alpine:3.20 AS release

ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache libstdc++ libgcc \
    && addgroup -S danmakus \
    && adduser -S danmakus -G danmakus

COPY --from=build /app/dist/danmakus ./danmakus

USER danmakus

ENTRYPOINT ["./danmakus"]
