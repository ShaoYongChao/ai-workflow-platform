FROM node:20-alpine
WORKDIR /app

# 先复制依赖文件，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY src ./src

ENV NODE_ENV=production
CMD ["node", "src/scheduler.js"]
