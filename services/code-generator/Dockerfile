# ── 构建阶段 ─────────────────────────────────────────────────
# build context = 项目根目录
FROM node:20-alpine AS builder
WORKDIR /app

COPY services/code-generator/package*.json services/code-generator/tsconfig.json ./
RUN npm ci --only=production=false

COPY services/code-generator/src ./src
COPY services/agents ./agents
COPY gateway ./gateway 
RUN npm run build

# ── 运行阶段 ─────────────────────────────────────────────────
# 镜像目录结构还原本地开发布局，让所有 require 相对路径一致：
#   /app/services/code-generator/dist/index.js
#   /app/services/agents/index.js
#   /app/gateway/tenant-middleware.js
#   /app/node_modules/  ← 共享依赖，所有模块沿目录树均可找到
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/dist ./services/code-generator/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agents ./services/agents
COPY --from=builder /app/gateway ./gateway

COPY services/code-generator/package.json ./

RUN addgroup -S awp && adduser -S awp -G awp
USER awp

EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s \
    CMD wget -qO- http://localhost:3003/health || exit 1

CMD ["node", "services/code-generator/dist/index.js"]
