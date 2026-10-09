# KiroGraph (https://github.com/davide-desio-eleva/kirograph), pinned, for the sandboxed benchmark.
# Build context: bench/competitors   (see bench/competitors/run.sh)
FROM node:22-bookworm-slim AS tool

# 1 = download nomic-embed-text-v1.5 at build time (through KiroGraph's own loader) so that the
# `embeddings` mode runs with --network none. 0 = smaller image, `default` mode only.
ARG BAKE_EMBEDDING_MODEL=1

ENV NO_COLOR=1 CI=1 DO_NOT_TRACK=1 \
    npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
    HOME=/home/bench

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/bench /work /results \
 && chmod 1777 /home/bench /work /results

# The tool, with its full dependency tree pinned by package-lock.json (default npm install,
# optional dependencies included, like `npm i -g kirograph`).
WORKDIR /opt/tool
COPY kirograph/package.json kirograph/package-lock.json ./
RUN npm ci --no-audit --no-fund
ENV PATH=/opt/tool/node_modules/.bin:$PATH

# The harness: official MCP SDK + driver script.
WORKDIR /opt/harness
COPY harness/package.json harness/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY harness/run-tool.mjs ./

# Bake the default embedding model by indexing a one-file project with embeddings on.
RUN if [ "$BAKE_EMBEDDING_MODEL" = "1" ]; then \
      set -e; mkdir -p /tmp/bake && cd /tmp/bake \
      && printf 'def hello(name):\n    return "hi " + name\n' > hello.py \
      && kirograph init /tmp/bake \
      && node -e "const f='/tmp/bake/.kirograph/config.json';const fs=require('fs');const c=JSON.parse(fs.readFileSync(f,'utf8'));Object.assign(c,{enableEmbeddings:true,embeddingModel:'nomic-ai/nomic-embed-text-v1.5',embeddingDim:768,semanticEngine:'cosine'});fs.writeFileSync(f,JSON.stringify(c,null,2))" \
      && kirograph index /tmp/bake \
      && test -d /home/bench/.kirograph/models/nomic-ai/nomic-embed-text-v1.5 \
      && du -sh /home/bench/.kirograph/models \
      && cd / && rm -rf /tmp/bake; \
    fi \
 && chmod -R a+rwX /home/bench

USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/harness/run-tool.mjs", "--tool", "kirograph"]

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
 && (node /opt/harness/run-tool.mjs --tool kirograph --mode "$MODE" --repo "$REPO" --inputs "$INPUTS" \
       --index-timeout "$INDEX_TIMEOUT" --query-timeout "$QUERY_TIMEOUT" ${ONLY:+--only "$ONLY"}; \
     echo $? > "/results/.exit-kirograph-${MODE}-${REPO}")

FROM scratch AS results
COPY --from=bench /results/ /

# Default target: the tool image.
FROM tool
