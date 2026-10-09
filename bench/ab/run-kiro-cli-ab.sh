#!/usr/bin/env bash
# kiro-cli A/B harness: stock Kiro (arm A) vs Kiro + kopt (arm B), optional memory probe (arm M).
#
# UNTESTED: kiro-cli was not installed where this was written. Flags come from kiro.dev/docs/cli/headless;
# credit fields in stream-json / session files are undocumented (third-party captures). Before a campaign,
# run ONE task with N=1 and check runs/<label>/runs.csv has non-empty credits (see bench/ab/README.md).
#
# Usage: MODEL=<model-id> [N=3] [ARMS="A B"] bench/ab/run-kiro-cli-ab.sh <repo-name> [label]
#   repo-name   a task file bench/tasks/<repo-name>.json and a checkout bench/repos/<repo-name>
# Env:
#   MODEL (required)      model id pinned in every arm (--model)
#   EFFORT                reasoning effort (--effort), optional
#   N=3                   repetitions per task and arm (fresh session each run)
#   ARMS="A B"            arms to run; add M for the no-tools memory probe
#   ONLY=id1,id2          restrict to these task ids
#   SEED=42               plan shuffling seed
#   ENGINE=v3             kiro-cli agent engine (stream-json needs v2 or v3)
#   TIMEOUT_S=900         per-run wall clock limit
#   AB_ISOLATE_HOME=1     fresh HOME per run (no global steering/agents/MCP leaks; session files land in the
#                         run dir). Needs KIRO_API_KEY. Set 0 to use your real HOME.
#   KIRO_CLI=kiro-cli     kiro-cli binary
#   KOPT=kopt             kopt command line (arm B workspace: `kopt init` + `kopt index`), e.g. "node /abs/dist/cli.js"
#   TRUST_A / TRUST_B / TRUST_M   --trust-tools lists (defaults below)
#   PASS_RATIO=0.6        grading threshold (share of gold symbol names named in the answer)
#   AB_TASKS / AB_SRC / AB_OUT / AB_WORK   override the task file, checkout, output and worktree dirs
#   KOPT_CACHE_DIR        kopt index cache shared by every run (default: $AB_WORK/.kopt-cache). kopt keeps its
#                         index in a per-user cache dir, which an isolated HOME would otherwise empty on every run.

set -euo pipefail

REPO_NAME="${1:?usage: MODEL=<id> $0 <repo-name> [label]}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LABEL="${2:-${REPO_NAME}-$(date +%Y%m%d-%H%M%S)}"
MODEL="${MODEL:?set MODEL to the pinned model id (same for every arm)}"
EFFORT="${EFFORT:-}"
N="${N:-3}"
ARMS="${ARMS:-A B}"
SEED="${SEED:-42}"
ENGINE="${ENGINE:-v3}"
TIMEOUT_S="${TIMEOUT_S:-900}"
AB_ISOLATE_HOME="${AB_ISOLATE_HOME:-1}"
KIRO_CLI="${KIRO_CLI:-kiro-cli}"
KOPT="${KOPT:-kopt}"
read -r -a KOPT_CMD <<< "$KOPT"   # allows KOPT="node /abs/dist/cli.js"
PASS_RATIO="${PASS_RATIO:-0.6}"
TRUST_A="${TRUST_A:-read,grep,glob}"
TRUST_B="${TRUST_B:-read,grep,glob,@kopt}"
TRUST_M="${TRUST_M:-}"

TASKS="${AB_TASKS:-$ROOT/bench/tasks/$REPO_NAME.json}"
SRC="${AB_SRC:-$ROOT/bench/repos/$REPO_NAME}"
OUT="${AB_OUT:-$HERE/runs/$LABEL}"
WORK="${AB_WORK:-$HERE/work/$REPO_NAME}"
LIB="$HERE/ab-lib.mjs"
# One index cache for the whole campaign: the arm B index is built once (prepare_workspace), and runs with a fresh
# HOME still find it instead of re-indexing in the background. Inherited by kopt, Kiro's MCP server and the hooks.
export KOPT_CACHE_DIR="${KOPT_CACHE_DIR:-$WORK/.kopt-cache}"

die() { echo "ab: $*" >&2; exit 1; }
log() { echo "ab: $*" >&2; }

[ -f "$TASKS" ] || die "no task file $TASKS"
[ -d "$SRC/.git" ] || die "no checkout $SRC (see bench/README.md)"
command -v node >/dev/null || die "node not found"
command -v "$KIRO_CLI" >/dev/null || die "$KIRO_CLI not found (install Kiro CLI >= 2.27)"
if [ "$AB_ISOLATE_HOME" = 1 ] && [ -z "${KIRO_API_KEY:-}" ]; then die "AB_ISOLATE_HOME=1 needs KIRO_API_KEY (headless auth)"; fi
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
[ -n "$TIMEOUT_BIN" ] || log "warning: no timeout/gtimeout binary, runs are not time-limited"
KIRO_VERSION="$("$KIRO_CLI" --version 2>/dev/null </dev/null | head -1 || echo unknown)"

mkdir -p "$OUT" "$WORK"
log "label=$LABEL model=$MODEL arms=[$ARMS] N=$N engine=$ENGINE kiro=$KIRO_VERSION"

# ---------------------------------------------------------------------------------------------------------
# One git worktree per arm, so that workspace-level Kiro config (.kiro/steering, hooks, mcp.json) of arm B
# can never leak into arm A.
prepare_workspace() {
  local arm="$1" wt="$WORK/$1" lower
  lower="$(echo "$arm" | tr '[:upper:]' '[:lower:]')"
  if [ ! -d "$wt" ]; then
    git -C "$SRC" worktree add --detach "$wt" HEAD >/dev/null 2>&1 || die "git worktree add failed for $wt"
  fi
  mkdir -p "$wt/.kiro/agents" "$wt/.kiro/hooks"
  cp "$HERE/agents/kopt-ab-$lower.json" "$wt/.kiro/agents/"
  cp "$HERE/agents/capture-hook.json" "$wt/.kiro/hooks/kopt-ab-capture.json"
  if [ "$arm" = B ]; then
    command -v "${KOPT_CMD[0]}" >/dev/null || die "${KOPT_CMD[0]} not found (arm B needs the kopt CLI)"
    "${KOPT_CMD[@]}" init --root "$wt" --force </dev/null >&2
    "${KOPT_CMD[@]}" index --root "$wt" </dev/null >&2
  else
    # control arms must not see any kopt artefact: workspace config, a per-project index, a cached index
    for leak in .kiro/steering .kiro/settings/mcp.json .kiro/hooks/kopt.json .kopt; do
      if [ -e "$wt/$leak" ]; then die "arm $arm workspace has $leak (remove it: it would contaminate the control)"; fi
    done
    if compgen -G "$KOPT_CACHE_DIR/$arm-*" >/dev/null; then
      die "arm $arm has a kopt index in $KOPT_CACHE_DIR (remove $KOPT_CACHE_DIR/$arm-*: it would contaminate the control)"
    fi
  fi
}

# A shared HOME carries the user-level kopt install (`kopt setup`): global hooks, MCP server and steering would load
# in the control arms too.
if [ "$AB_ISOLATE_HOME" != 1 ]; then
  kiro_home="${KIRO_HOME:-$HOME/.kiro}"
  for leak in "$kiro_home/hooks/kopt.json" "$kiro_home/steering/kopt.md"; do
    if [ -e "$leak" ]; then die "$leak exists: with AB_ISOLATE_HOME=0 kopt would run in the control arms (use AB_ISOLATE_HOME=1 or kopt uninstall --user)"; fi
  done
  if grep -q '"kopt"' "$kiro_home/settings/mcp.json" 2>/dev/null; then
    die "$kiro_home/settings/mcp.json registers kopt: with AB_ISOLATE_HOME=0 kopt would run in the control arms (use AB_ISOLATE_HOME=1 or kopt uninstall --user)"
  fi
fi

for arm in $ARMS; do prepare_workspace "$arm"; done

node "$LIB" plan --tasks "$TASKS" --arms "$ARMS" --reps "$N" --seed "$SEED" ${ONLY:+--only "$ONLY"} > "$OUT/plan.tsv"
TOTAL="$(wc -l < "$OUT/plan.tsv" | tr -d ' ')"
log "plan: $TOTAL runs -> $OUT/plan.tsv"

# ---------------------------------------------------------------------------------------------------------
while IFS=$'\t' read -r idx task arm rep; do
  [ -n "$idx" ] || continue
  run_dir="$OUT/$task/$arm-$rep"
  if [ -f "$run_dir/exit_code" ]; then continue; fi   # resumable
  rm -rf "$run_dir" && mkdir -p "$run_dir"
  lower="$(echo "$arm" | tr '[:upper:]' '[:lower:]')"
  wt="$WORK/$arm"
  case "$arm" in A) trust="$TRUST_A" ;; B) trust="$TRUST_B" ;; *) trust="$TRUST_M" ;; esac
  prompt="$(node "$LIB" prompt --tasks "$TASKS" --task "$task")"

  run_home="$HOME"
  if [ "$AB_ISOLATE_HOME" = 1 ]; then run_home="$run_dir/home"; mkdir -p "$run_home"; fi
  marker="$run_dir/.start"; touch "$marker"

  args=(chat --no-interactive --agent-engine "$ENGINE" --agent "kopt-ab-$lower" --model "$MODEL" --output-format stream-json)
  [ -n "$EFFORT" ] && args+=(--effort "$EFFORT")
  [ -n "$trust" ] && args+=("--trust-tools=$trust")
  [ "$arm" = B ] && args+=(--require-mcp-startup)
  args+=("$prompt")

  start="$(date +%s)"
  log "[$idx/$TOTAL] $task arm=$arm rep=$rep"
  set +e
  (
    cd "$wt"
    export HOME="$run_home" KOPT_AB_RUN_DIR="$run_dir"
    if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$TIMEOUT_S" "$KIRO_CLI" "${args[@]}"; else "$KIRO_CLI" "${args[@]}"; fi
  ) > "$run_dir/stream.jsonl" 2> "$run_dir/stderr.log" < /dev/null
  code=$?
  set -e
  end="$(date +%s)"

  if [ "$AB_ISOLATE_HOME" != 1 ] && [ -d "$HOME/.kiro/sessions" ]; then
    # shared HOME: keep only the session files written during this run
    mkdir -p "$run_dir/sessions"
    find "$HOME/.kiro/sessions" -type f -newer "$marker" \( -name '*.json' -o -name '*.jsonl' \) -print0 2>/dev/null |
      while IFS= read -r -d '' f; do cp "$f" "$run_dir/sessions/$(echo "${f#"$HOME"/.kiro/sessions/}" | tr '/' '_')"; done
  fi

  dirty=0
  if [ -n "$(git -C "$wt" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    dirty=1
    git -C "$wt" checkout -- . >/dev/null 2>&1 || true
  fi
  printf '{"task":"%s","arm":"%s","rep":%s,"idx":%s,"model":"%s","effort":"%s","engine":"%s","start":%s,"end":%s,"exit_code":%s,"dirty":%s,"kiro_version":"%s"}\n' \
    "$task" "$arm" "$rep" "$idx" "$MODEL" "$EFFORT" "$ENGINE" "$start" "$end" "$code" "$dirty" "${KIRO_VERSION//\"/}" > "$run_dir/meta.json"
  echo "$code" > "$run_dir/exit_code"
  [ "$code" = 0 ] || log "  exit $code (kept as a failed attempt; see $run_dir/stderr.log)"
done < "$OUT/plan.tsv"

for arm in $ARMS; do
  if [ "$arm" != B ] && compgen -G "$KOPT_CACHE_DIR/$arm-*" >/dev/null; then
    log "warning: kopt indexed the arm $arm worktree during the runs ($KOPT_CACHE_DIR/$arm-*): the control saw kopt"
  fi
done

node "$LIB" parse --tasks "$TASKS" --runs "$OUT" --pass-ratio "$PASS_RATIO" > "$OUT/runs.csv"
node "$HERE/analyze.mjs" "$OUT/runs.csv" --json "$OUT/analysis.json" > "$OUT/report.md"
log "wrote $OUT/runs.csv and $OUT/report.md"
cat "$OUT/report.md"
