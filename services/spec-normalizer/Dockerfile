# ── 构建阶段 ─────────────────────────────────────────────────
# 注意：build context 已改为项目根目录，以便访问 gateway/ 文件夹
FROM node:20-alpine AS builder
WORKDIR /app
COPY services/spec-normalizer/package*.json services/spec-normalizer/tsconfig.json ./
RUN npm ci --only=production=false
COPY services/spec-normalizer/src ./src
RUN npm run build

# ── 运行阶段 ─────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# 只复制运行所需文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY services/spec-normalizer/package.json ./

# dist/index.js 里 require('../../../gateway/tenant-middleware')
# 从 /app/dist/ 往上 3 级解析为 /gateway/，所以需要把 gateway 放在这里
COPY gateway /gateway

# 非 root 用户运行（安全）
RUN addgroup -S awp && adduser -S awp -G awp
USER awp

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
