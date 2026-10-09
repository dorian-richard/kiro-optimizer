# CodeGraph (https://github.com/colbymchenry/codegraph), pinned, for the sandboxed benchmark.
# Build context: bench/competitors   (see bench/competitors/run.sh)
FROM node:22-bookworm-slim AS tool

ENV NO_COLOR=1 CI=1 DO_NOT_TRACK=1 CODEGRAPH_TELEMETRY=0 CODEGRAPH_NO_DOWNLOAD=1 \
    npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
    HOME=/home/bench

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/bench /work /results \
 && chmod 1777 /home/bench /work /results

# The npm package is a small shim; npm installs the matching per-platform bundle
# (@colbymchenry/codegraph-linux-<arch>, which ships its own Node 24 runtime) as an optional dep.
WORKDIR /opt/tool
COPY codegraph/package.json codegraph/package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && test -x "node_modules/@colbymchenry/codegraph-linux-$(node -p process.arch)/bin/codegraph"
ENV PATH=/opt/tool/node_modules/.bin:$PATH

WORKDIR /opt/harness
COPY harness/package.json harness/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY harness/run-tool.mjs ./

RUN codegraph version && chmod -R a+rwX /home/bench

USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/harness/run-tool.mjs", "--tool", "codegraph"]

# ---------------------------------------------------------------------------------------------
# Optional stages for the "buildkit" engine of run.sh: the benchmark itself runs as a sandboxed
# build step (no network, checkout mounted read-only) and only results/ is exported. Used where
# `docker run` is unavailable. Built only when targeted (--target results).
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
 && (node /opt/harness/run-tool.mjs --tool codegraph --mode "$MODE" --repo "$REPO" --inputs "$INPUTS" \
       --index-timeout "$INDEX_TIMEOUT" --query-timeout "$QUERY_TIMEOUT" ${ONLY:+--only "$ONLY"}; \
     echo $? > "/results/.exit-codegraph-${MODE}-${REPO}")

FROM scratch AS results
COPY --from=bench /results/ /

# Default target: the tool image.
FROM tool
