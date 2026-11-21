FROM --platform=$BUILDPLATFORM oven/bun:1 AS base

WORKDIR /app

FROM base AS install

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS build

ARG TARGETARCH
COPY --from=install /app/node_modules ./node_modules
COPY . .
RUN target_arch="${TARGETARCH:-$(uname -m)}" && \
    case "$target_arch" in \
      amd64|x86_64) bun_arch=x64 ;; \
      arm64|aarch64) bun_arch=arm64 ;; \
      *) echo "Unsupported target architecture: $target_arch" >&2; exit 1 ;; \
    esac && \
    bun build --compile --minify --target="bun-linux-${bun_arch}-musl" ./src/cli/index.ts --outfile ./dist/danmakus

FROM alpine:3.20 AS release

ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache libstdc++ libgcc \
    && addgroup -S danmakus \
    && adduser -S danmakus -G danmakus

COPY --from=build /app/dist/danmakus ./danmakus

RUN mkdir -p /app/.danmakus \
    && chown -R danmakus:danmakus /app

USER danmakus

ENTRYPOINT ["./danmakus"]
