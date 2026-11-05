# ---- Build stage ----
FROM node:26-alpine AS build
WORKDIR /app

# Install with only manifests first: this layer is cached until deps change.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/offerflow.db

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server --workspace=shared && npm cache clean --force

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
# Operational scripts (online backup): docker exec <ctr> node server/scripts/backup.mjs
COPY server/scripts server/scripts

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/dist/index.js"]
