# syntax=docker/dockerfile:1
# Central kopt query service (ECS Fargate, linux/arm64 by default; also builds for amd64).
#   docker build --platform linux/arm64 -t kopt:local .
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: compile TypeScript with dev dependencies
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies only (no compiler, no test tooling in the final image)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    KOPT_DISABLE_RUN=1 \
    KOPT_REPOS_DIR=/data/repos \
    KOPT_HOME=/data/home \
    HOME=/data/home \
    PORT=8080
WORKDIR /app
# App files stay root-owned and read-only for the service user; only /data is writable.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY templates ./templates
COPY docker/entrypoint.sh docker/s3sync.mjs ./docker/
RUN chmod 0555 /app/docker/entrypoint.sh \
 && printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /app/dist/cli.js "$@"\n' > /usr/local/bin/kopt \
 && chmod 0555 /usr/local/bin/kopt \
 && mkdir -p /data/repos /data/home \
 && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
# --disable-warning: node:sqlite prints an ExperimentalWarning on every start otherwise.
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/dist/cli.js", "serve", "--port", "8080", "--repos-dir", "/data/repos"]
