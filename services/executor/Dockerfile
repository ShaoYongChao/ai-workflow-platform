# ── 构建阶段 ─────────────────────────────────────────────────
# build context = 项目根目录
FROM node:20-alpine AS builder
WORKDIR /app

COPY services/executor/package*.json services/executor/tsconfig.json ./
RUN npm ci --only=production=false

COPY services/executor/src ./src
COPY services/agents ./agents
RUN npm run build

# ── 运行阶段 ─────────────────────────────────────────────────
# 镜像目录结构还原本地开发布局，让所有 require 相对路径一致：
#   /app/services/executor/dist/index.js
#   /app/services/agents/index.js
#   /app/gateway/tenant-middleware.js
#   /app/node_modules/  ← 共享依赖，所有模块沿目录树均可找到
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app/services/executor

# 安装 Go（用于沙箱测试）和必要工具
RUN apk add --no-cache go gcc musl-dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/agents /app/services/agents
COPY services/executor/package.json ./
COPY gateway /app/gateway

RUN addgroup -S awp && adduser -S awp -G awp
USER awp

EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s \
    CMD wget -qO- http://localhost:3004/health || exit 1

CMD ["node", "dist/index.js"]
