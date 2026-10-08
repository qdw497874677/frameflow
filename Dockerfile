# art-workspace 后端镜像：一个进程、一个端口，同时提供 API 与前端静态产物。
#
# 为什么是多阶段：前端构建要一整套 devDependencies（vite/tsc/tailwind，web 的
# node_modules 有 240MB），运行期一行都不要。builder 里烤好 `web/dist` 与
# server 的生产依赖，runtime 只把这些拷进来，镜像里没有构建工具链。

# ── builder：装依赖 + 构建前端 ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
# 前端构建产物必须带 VITE_API_BASE=/api/v1，否则 mock 数据源会被静默打进包（真实踩过的坑）。
ENV VITE_API_BASE=/api/v1
WORKDIR /app

# web：装全量依赖只为构建；lockfile 在，用 npm ci 保证可复现
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci

# server：这里只装生产依赖 —— 运行期要的 node_modules 直接从这里带走。
# 先拷 package 文件再装，依赖没变时这层就命中缓存。
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev

# 源码放在依赖之后：改代码不会让上面几层失效
COPY web/ web/
COPY server/ server/

# 构建前端（tsc --noEmit + vite build）→ /app/web/dist
RUN cd web && npm run build

# ── runtime：只有跑起来要的东西 ────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# ffmpeg：视频抽封面（core/thumbs.ts spawn ffmpeg）
# perl：exiftool-vendored 附带的是 perl 脚本，npm 包里有二进制脚本但没有解释器
# ca-certificates：将来要访问 https 的外部服务（AI 执行器等）时不用再改镜像
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg perl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# 生产依赖优先（体积大、几乎不变），源码在后
COPY --from=builder /app/server/node_modules server/node_modules
COPY server/package.json server/package-lock.json server/
COPY server/src server/src
# server/src/api/server.ts 用 `join(process.cwd(), '..', 'web', 'dist')` 找前端产物，
# 所以 cwd 必须是 /app/server，dist 落在 /app/web/dist
COPY --from=builder /app/web/dist web/dist

# 配置：compose/裸机都靠 ARTWORKS_CONFIG 指向真实配置文件；这里只放一份示例兜底
COPY deploy/artworks.config.example.yaml deploy/artworks.config.example.yaml

WORKDIR /app/server
EXPOSE 8787

# 官方镜像自带 node 用户（uid 1000）。非 root 跑，但**挂进来的照片目录必须对 uid 1000 可写**，
# 否则 XMP 侧车与 .trash 写不进去 —— 权限不匹配时在 compose 里用 `user:` 覆盖（见 docker-compose.yml）。
USER node

# Node 22 原生跑 .ts（tsconfig 里 erasableSyntaxOnly，只用可擦除语法）：无需转译步骤。
# slim 镜像里没有 curl/wget，用 node 自带的 fetch 探健康检查。全部 127.0.0.1：
# 配置里的 host 若是 127.0.0.1，容器外就靠端口映射访问，健康检查不受影响。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.ts"]
