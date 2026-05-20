# ── 构建阶段 ─────────────────────────────────────────────────
# 注意：build context 已改为项目根目录，以便访问 gateway/ 文件夹
FROM node:20-alpine AS builder
WORKDIR /app
COPY services/executor/package*.json services/executor/tsconfig.json ./
RUN npm ci --only=production=false
COPY services/executor/src ./src
RUN npm run build

# ── 运行阶段 ─────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# 安装 Go（用于沙箱测试）和必要工具
# 不锁定小版本，使用仓库提供的最新稳定 Go
RUN apk add --no-cache go gcc musl-dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY services/executor/package.json ./

# dist/index.js 里 require('../../../gateway/tenant-middleware')
# 从 /app/dist/ 往上 3 级解析为 /gateway/，所以需要把 gateway 放在这里
COPY gateway /gateway

RUN addgroup -S awp && adduser -S awp -G awp
# executor 需要写 /tmp，不能用非 root（写沙箱目录）
USER awp

EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s \
    CMD wget -qO- http://localhost:3004/health || exit 1

CMD ["node", "dist/index.js"]
