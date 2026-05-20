FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# COPY --from=builder /app/public ./public

RUN addgroup -S awp && adduser -S awp -G awp && chown -R awp:awp /app
USER awp

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s \
  CMD wget -qO- http://localhost:3000 || exit 1
CMD ["node", "server.js"]