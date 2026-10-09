# Build phase of the per-repo CodeBuild project (embedded in the buildspec at synth time).
# Env: REPO, BUCKET, SNAPSHOT_PREFIX, KOPT_CMD, KOPT_FULL (1 = nightly rebuild, recorded in latest.json),
#      KOPT_ORIGIN (where kopt was installed from) and KOPT_VERSION (fallback when `kopt --version` prints nothing).
# Publishes s3://$BUCKET/$SNAPSHOT_PREFIX/$REPO/<commit>.db.gz, then latest.json {commit,key,indexedAt,...}.
set -euo pipefail
: "${REPO:?}" "${BUCKET:?}" "${KOPT_CMD:?}"
PREFIX="${SNAPSHOT_PREFIX:-repos}/${REPO}"
WORK="${KOPT_WORK_DIR:-/tmp/kopt}"
OUT="$WORK/out.db"
mkdir -p "$WORK"
rm -f "$OUT" "$OUT-wal" "$OUT-shm" "$OUT.gz"

COMMIT="${CODEBUILD_RESOLVED_SOURCE_VERSION:-}"
if ! printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{7,64}$'; then
  COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
fi
if ! printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{7,64}$'; then
  # S3/zip sources carry no git metadata: key on the build time so every pointer stays unique.
  COMMIT="nogit-$(date -u +%Y%m%dT%H%M%SZ)"
fi
STARTED="${CODEBUILD_START_TIME:-$(date +%s)000}"
# The version actually installed (a git install of `main` floats); recorded in latest.json for operators.
KOPT_BUILD_VERSION="$(bash -c "$KOPT_CMD --version" </dev/null 2>/dev/null | head -1 | tr -cd 'A-Za-z0-9.+_-' || true)"
KOPT_BUILD_VERSION="${KOPT_BUILD_VERSION:-$(printf '%s' "${KOPT_VERSION:-}" | tr -cd 'A-Za-z0-9.+_-')}"
KOPT_ORIGIN_SAFE="$(printf '%s' "${KOPT_ORIGIN:-}" | tr -cd 'A-Za-z0-9@:._/#+-')"
echo "kopt: indexer ${KOPT_BUILD_VERSION:-unknown version} from ${KOPT_ORIGIN_SAFE:-unknown origin}"

pointer_field() {
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(v==null?"":String(v))}catch{}' "$1" "$2"
}
fetch_pointer() {
  rm -f "$1"
  aws s3 cp "s3://$BUCKET/$PREFIX/latest.json" "$1" --only-show-errors >/dev/null 2>&1 || true
}

# `kopt index --snapshot` always builds from scratch (self-contained file with gzip blobs, journal_mode=DELETE).
bash -c "$KOPT_CMD index --root \"\$1\" --snapshot \"\$2\" --repo \"\$3\"" kopt-index "${CODEBUILD_SRC_DIR:-$PWD}" "$OUT" "$REPO"
test -s "$OUT" || { echo "kopt: index produced no snapshot at $OUT" >&2; exit 1; }

# Defensive (kopt already does it): fold any WAL into the main file so the gzip is self-contained.
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");d.close()' "$OUT"
gzip -6 -c "$OUT" > "$OUT.gz"
KEY="$PREFIX/$COMMIT.db.gz"
aws s3api put-object --bucket "$BUCKET" --key "$KEY" --body "$OUT.gz" \
  --content-type application/gzip --tagging "kopt-latest=true" >/dev/null

# A build of the same repo that started later may already have published: never move the pointer backwards.
fetch_pointer "$WORK/cur.json"
CUR_KEY="$(pointer_field "$WORK/cur.json" key)"
CUR_STARTED="$(pointer_field "$WORK/cur.json" buildStartedAt)"
if printf '%s' "$CUR_STARTED" | grep -Eq '^[0-9]+$' && [ "$CUR_STARTED" -gt "$STARTED" ]; then
  echo "kopt: newer snapshot $CUR_KEY already published, pointer left unchanged"
  if [ "$CUR_KEY" != "$KEY" ]; then
    aws s3api put-object-tagging --bucket "$BUCKET" --key "$KEY" --tagging 'TagSet=[{Key=kopt-latest,Value=false}]' || true
  fi
  exit 0
fi

BYTES="$(wc -c < "$OUT.gz" | tr -d ' ')"
printf '{"commit":"%s","key":"%s","indexedAt":"%s","buildStartedAt":%s,"gzBytes":%s,"koptVersion":"%s","koptOrigin":"%s","buildId":"%s","nightly":%s}\n' \
  "$COMMIT" "$KEY" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STARTED" "$BYTES" "$KOPT_BUILD_VERSION" "$KOPT_ORIGIN_SAFE" "${CODEBUILD_BUILD_ID:-}" \
  "$([ "${KOPT_FULL:-0}" = 1 ] && echo true || echo false)" > "$WORK/latest.json"
aws s3api put-object --bucket "$BUCKET" --key "$PREFIX/latest.json" --body "$WORK/latest.json" \
  --content-type application/json --cache-control no-cache >/dev/null
if [ -n "$CUR_KEY" ] && [ "$CUR_KEY" != "$KEY" ]; then
  aws s3api put-object-tagging --bucket "$BUCKET" --key "$CUR_KEY" --tagging 'TagSet=[{Key=kopt-latest,Value=false}]' \
    || echo "kopt: warning: could not retag superseded snapshot $CUR_KEY" >&2
fi
echo "kopt: published s3://$BUCKET/$KEY ($BYTES bytes, commit $COMMIT)"
