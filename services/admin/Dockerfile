FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3006
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3006/health || exit 1
CMD ["node", "src/index.js"]
