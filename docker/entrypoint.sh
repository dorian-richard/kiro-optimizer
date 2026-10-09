#!/bin/sh
# Entrypoint of the central kopt query service container.
# 1. blocking first sync of index snapshots from S3 (bounded by SYNC_INITIAL_TIMEOUT_SEC),
# 2. background re-sync every SYNC_INTERVAL_SEC (0 disables),
# 3. exec the server command (CMD / ECS command) so it receives signals directly.
set -eu

REPOS_DIR="${KOPT_REPOS_DIR:-/data/repos}"
INTERVAL="${SYNC_INTERVAL_SEC:-300}"
INITIAL_TIMEOUT="${SYNC_INITIAL_TIMEOUT_SEC:-900}"
SYNC_SCRIPT="${KOPT_SYNC_SCRIPT:-/app/docker/s3sync.mjs}"
export KOPT_REPOS_DIR="$REPOS_DIR"

mkdir -p "$REPOS_DIR"

if [ -n "${KOPT_SNAPSHOT_BUCKET:-}" ]; then
  # A failed or slow first sync must not keep the service down: it serves whatever is on disk and the
  # background loop retries.
  if ! timeout "$INITIAL_TIMEOUT" node --disable-warning=ExperimentalWarning "$SYNC_SCRIPT"; then
    echo "kopt-entrypoint: initial snapshot sync incomplete, continuing" >&2
  fi
  case "$INTERVAL" in
    ''|*[!0-9]*) echo "kopt-entrypoint: invalid SYNC_INTERVAL_SEC='$INTERVAL', background sync disabled" >&2 ;;
    0) ;;
    *) node --disable-warning=ExperimentalWarning "$SYNC_SCRIPT" --loop "$INTERVAL" & ;;
  esac
else
  echo "kopt-entrypoint: KOPT_SNAPSHOT_BUCKET not set, snapshot sync disabled" >&2
fi

if [ "$#" -eq 0 ]; then
  echo "kopt-entrypoint: no command given" >&2
  exit 64
fi
exec "$@"
