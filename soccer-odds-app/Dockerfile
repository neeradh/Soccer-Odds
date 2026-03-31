FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY server/ ./server/
COPY index.html ./
COPY index.js ./

# DB lives on a mounted volume — don't bake it in
VOLUME ["/app/server"]

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Tini for proper signal handling (PID 1)
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/status | grep -q '"ok":true' || exit 1
