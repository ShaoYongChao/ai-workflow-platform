FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3005
HEALTHCHECK --interval=20s --timeout=5s \
  CMD wget -qO- http://localhost:3005/health || exit 1
CMD ["node", "src/index.js"]
