#!/usr/bin/env bash
# Sandboxed competitor benchmark: KiroGraph and CodeGraph run ONLY inside containers, never on the host.
#
#   bench/competitors/run.sh                       # every tool/mode on every repo that has tasks
#                                                  # (kirograph default+embeddings, codegraph, and kopt
#                                                  #  itself built from this repo, for same-box timings)
#   bench/competitors/run.sh --tools codegraph --repos django
#   bench/competitors/run.sh --runs kirograph:default,kirograph:embeddings,codegraph:default
#   bench/competitors/run.sh --inputs search       # default: search,question
#   bench/competitors/run.sh --engine buildkit     # run as sandboxed build steps (no `docker run`)
#   bench/competitors/run.sh --build               # force image rebuild (docker engine)
#   bench/competitors/run.sh --clean               # remove the benchmark images at the end
#
# Engines (both: no network, checkout + tasks read-only, only results/ comes back):
#   docker   (default) `docker run --network none --cap-drop ALL --read-only mounts` per tool x repo.
#   buildkit           `docker buildx build --target results` with `RUN --network=none` and read-only
#                      bind mounts of the checkout/tasks as named build contexts; results are exported
#                      with `--output type=local`. Use it where `docker run` is unavailable or wedged.
#
# Repos: every bench/tasks/<repo>.json whose checkout exists in bench/repos/<repo>.
# Results: bench/competitors/results/<label>-<repo>[-question].jsonl + <label>-<repo>.meta.json,
# then `node bench/competitors/score.mjs` writes results/summary.{md,json}.
#
# Linux and macOS (bash 3.2+). On Windows, run it from WSL2 or Git Bash with Docker Desktop.
# Env: BENCH_ENGINE, BENCH_BUILDER (buildx builder), BENCH_MEMORY (6g), BENCH_CPUS (8),
#      BENCH_INDEX_TIMEOUT (5400 s), BENCH_QUERY_TIMEOUT (300 s).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RESULTS="$HERE/results"

KIROGRAPH_IMAGE="kopt-bench/kirograph:1.4.0"
CODEGRAPH_IMAGE="kopt-bench/codegraph:1.6.2"
KOPT_IMAGE="kopt-bench/kopt:local"

RUNS="kirograph:default,kirograph:embeddings,codegraph:default,kopt:default"
REPOS="all"
INPUTS="search,question"
ENGINE="${BENCH_ENGINE:-docker}"
BUILD=0
CLEAN=0
ONLY=""
MEMORY="${BENCH_MEMORY:-6g}"
CPUS="${BENCH_CPUS:-8}"
INDEX_TIMEOUT="${BENCH_INDEX_TIMEOUT:-5400}"
QUERY_TIMEOUT="${BENCH_QUERY_TIMEOUT:-300}"
BUILDER_ARGS=()
[ -n "${BENCH_BUILDER:-}" ] && BUILDER_ARGS=(--builder "$BENCH_BUILDER")

while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --clean) CLEAN=1 ;;
    --engine) ENGINE="$2"; shift ;;
    --runs) RUNS="$2"; shift ;;
    --tools)
      RUNS=""
      IFS=',' read -r -a _tools <<<"$2"
      for t in "${_tools[@]}"; do
        case "$t" in
          kirograph) RUNS="$RUNS,kirograph:default,kirograph:embeddings" ;;
          *) RUNS="$RUNS,$t:default" ;;
        esac
      done
      RUNS="${RUNS#,}"; shift ;;
    --repos) REPOS="$2"; shift ;;
    --inputs) INPUTS="$2"; shift ;;
    --only) ONLY="$2"; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ENGINE" in docker|buildkit) ;; *) echo "--engine must be docker or buildkit" >&2; exit 2 ;; esac

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
mkdir -p "$RESULTS"
# Git Bash on Windows rewrites /paths in arguments; keep container paths intact.
export MSYS_NO_PATHCONV=1

image_for() {
  case "$1" in
    kirograph) echo "$KIROGRAPH_IMAGE" ;;
    codegraph) echo "$CODEGRAPH_IMAGE" ;;
    kopt) echo "$KOPT_IMAGE" ;;
    *) echo "unknown tool $1" >&2; return 1 ;;
  esac
}

build_image() {
  local tool="$1" image ctx=()
  image="$(image_for "$tool")"
  if [ "$BUILD" = 0 ] && docker image inspect "$image" >/dev/null 2>&1; then return 0; fi
  echo "== building $image"
  # kopt is built from this repository: its Dockerfile gets the repo root as a named context.
  [ "$tool" = kopt ] && ctx=(--build-context "kopt=$ROOT")
  docker buildx build ${BUILDER_ARGS[@]+"${BUILDER_ARGS[@]}"} --load -t "$image" -f "$HERE/$tool/Dockerfile" \
    ${ctx[@]+"${ctx[@]}"} "$HERE"
}

# repos with tasks and a checkout
if [ "$REPOS" = all ]; then
  REPO_LIST=()
  for f in "$ROOT"/bench/tasks/*.json; do
    name="$(basename "$f" .json)"
    if [ -d "$ROOT/bench/repos/$name" ]; then REPO_LIST+=("$name"); else echo "skip $name: no checkout in bench/repos/$name"; fi
  done
else
  IFS=',' read -r -a REPO_LIST <<<"$REPOS"
fi
[ "${#REPO_LIST[@]}" -gt 0 ] || { echo "no repo to run" >&2; exit 1; }
IFS=',' read -r -a RUN_LIST <<<"$RUNS"

run_docker() { # tool mode repo
  local tool="$1" mode="$2" repo="$3" image user_args=() extra=()
  image="$(image_for "$tool")"
  # Linux bind mounts keep host uids: run as the caller so result files stay owned by them.
  [ "$(uname -s)" = Linux ] && user_args=(--user "$(id -u):$(id -g)")
  [ -n "$ONLY" ] && extra=(--only "$ONLY")
  docker run --rm --init \
    --network none --cap-drop ALL --security-opt no-new-privileges \
    --memory "$MEMORY" --cpus "$CPUS" --pids-limit 4096 \
    ${user_args[@]+"${user_args[@]}"} \
    -v "$ROOT/bench/repos/$repo:/src:ro" \
    -v "$ROOT/bench/tasks:/tasks:ro" \
    -v "$RESULTS:/results" \
    --entrypoint node "$image" /opt/harness/run-tool.mjs \
    --tool "$tool" --mode "$mode" --repo "$repo" --inputs "$INPUTS" \
    --index-timeout "$INDEX_TIMEOUT" --query-timeout "$QUERY_TIMEOUT" ${extra[@]+"${extra[@]}"} </dev/null
}

run_buildkit() { # tool mode repo
  local tool="$1" mode="$2" repo="$3" out code ctx=()
  [ "$tool" = kopt ] && ctx=(--build-context "kopt=$ROOT")
  out="$(mktemp -d "${TMPDIR:-/tmp}/kopt-bench-XXXXXX")"
  docker buildx build ${BUILDER_ARGS[@]+"${BUILDER_ARGS[@]}"} --progress plain \
    -f "$HERE/$tool/Dockerfile" --target results ${ctx[@]+"${ctx[@]}"} \
    --build-context "repo=$ROOT/bench/repos/$repo" \
    --build-context "tasks=$ROOT/bench/tasks" \
    --build-arg "REPO=$repo" --build-arg "MODE=$mode" --build-arg "INPUTS=$INPUTS" \
    --build-arg "ONLY=$ONLY" --build-arg "INDEX_TIMEOUT=$INDEX_TIMEOUT" \
    --build-arg "QUERY_TIMEOUT=$QUERY_TIMEOUT" --build-arg "RUN_ID=$(date +%s)-$$" \
    --output "type=local,dest=$out" "$HERE" </dev/null
  cp -R "$out"/. "$RESULTS"/
  code="$(cat "$RESULTS/.exit-$tool-$mode-$repo" 2>/dev/null || echo 1)"
  rm -rf "$out" "$RESULTS/.exit-$tool-$mode-$repo"
  return "$code"
}

if [ "$ENGINE" = docker ]; then
  for r in "${RUN_LIST[@]}"; do build_image "${r%%:*}"; done
fi

status=0
for repo in "${REPO_LIST[@]}"; do
  for r in "${RUN_LIST[@]}"; do
    tool="${r%%:*}"; mode="${r#*:}"
    echo "== $tool ($mode) on $repo [$ENGINE]"
    if ! "run_$ENGINE" "$tool" "$mode" "$repo"; then
      echo "!! $tool ($mode) on $repo failed (see $RESULTS/logs/)" >&2
      status=1
    fi
  done
done

if command -v node >/dev/null; then
  node "$HERE/score.mjs" || status=1
else
  echo "node not found on the host: run 'node bench/competitors/score.mjs' later to build the summary"
fi

if [ "$CLEAN" = 1 ]; then
  for r in "${RUN_LIST[@]}"; do docker image rm "$(image_for "${r%%:*}")" >/dev/null 2>&1 || true; done
fi
exit $status
