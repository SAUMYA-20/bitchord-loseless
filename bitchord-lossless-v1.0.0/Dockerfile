# BitChord Lossless — zero-dependency, distroless-ish and small.
FROM node:20-alpine AS base
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
# Drop privileges: the addon needs no root.
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null 2>&1 || exit 1
CMD ["node", "server.js"]
