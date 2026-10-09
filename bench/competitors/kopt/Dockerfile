# kopt (this repository), built from the local sources, so that it is measured with the SAME
# harness, container, limits and MCP client as the competitors (apples-to-apples timings).
# Build context: bench/competitors, plus a named context `kopt` = the repository root
# (its .dockerignore allowlist applies):
#   docker buildx build --build-context kopt=. -f bench/competitors/kopt/Dockerfile bench/competitors
FROM node:22-bookworm-slim AS build
WORKDIR /opt/tool
COPY --from=kopt package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --from=kopt tsconfig.json ./
COPY --from=kopt src ./src
COPY --from=kopt templates ./templates
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS tool
ENV NO_COLOR=1 CI=1 DO_NOT_TRACK=1 \
    npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
    HOME=/home/bench
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/bench /work /results \
 && chmod 1777 /home/bench /work /results
WORKDIR /opt/tool
COPY --from=build /opt/tool/package.json ./
COPY --from=build /opt/tool/node_modules ./node_modules
COPY --from=build /opt/tool/dist ./dist
COPY --from=build /opt/tool/templates ./templates
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /opt/tool/dist/cli.js "$@"\n' > /usr/local/bin/kopt \
 && chmod 0555 /usr/local/bin/kopt && kopt --version

WORKDIR /opt/harness
COPY harness/package.json harness/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY harness/run-tool.mjs ./

USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/harness/run-tool.mjs", "--tool", "kopt"]

# ---------------------------------------------------------------------------------------------
# Optional stages for the "buildkit" engine of run.sh (see kirograph/Dockerfile).
FROM tool AS bench
ARG REPO
ARG MODE=default
ARG INPUTS=search,question
ARG ONLY=
ARG INDEX_TIMEOUT=5400
ARG QUERY_TIMEOUT=300
ARG RUN_ID=0
RUN --network=none \
    --mount=type=bind,from=repo,target=/src \
    --mount=type=bind,from=tasks,target=/tasks \
    echo "run ${RUN_ID}" \
 && (node /opt/harness/run-tool.mjs --tool kopt --mode "$MODE" --repo "$REPO" --inputs "$INPUTS" \
       --index-timeout "$INDEX_TIMEOUT" --query-timeout "$QUERY_TIMEOUT" ${ONLY:+--only "$ONLY"}; \
     echo $? > "/results/.exit-kopt-${MODE}-${REPO}")

FROM scratch AS results
COPY --from=bench /results/ /

# Default target: the tool image.
FROM tool
