FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
COPY package.json ./
ENV NODE_ENV=production
EXPOSE 3007
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3007/ > /dev/null || exit 1
CMD ["node", "server.js"]
