#!/usr/bin/env bash
# Alert when the newest OpenSearch backing index is older than STALE_AFTER_MIN.
set -euo pipefail

STALE_AFTER_MIN="${STALE_AFTER_MIN:-120}"
ALIAS="${OPENSEARCH_ALIAS:-feedback-posts}"

if [[ -f /etc/feedback-search/ingest.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/feedback-search/ingest.env
  set +a
fi

if [[ -f /etc/feedback-search/github.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/feedback-search/github.env
  set +a
fi

REPO_ROOT="${FEEDBACK_REPO_ROOT:-/srv/feedback.vrchat.com}"
OS_URL="${OPENSEARCH_URL:-http://127.0.0.1:9200}"
OS_URL="${OS_URL%/}"

if [[ -z "${OPENSEARCH_USER:-}" || -z "${OPENSEARCH_PASSWORD:-}" ]]; then
  echo "[check_ingest_health] missing OpenSearch credentials in ingest.env" >&2
  exit 1
fi

indices="$(curl -fsS -u "${OPENSEARCH_USER}:${OPENSEARCH_PASSWORD}" \
  "${OS_URL}/_cat/indices/${ALIAS}-*?h=index" 2>/dev/null || true)"

if [[ -z "${indices}" ]]; then
  BODY="No backing indices matching ${ALIAS}-* were found on ${OS_URL}."
  printf '%s\n' "${BODY}" | FEEDBACK_REPO_ROOT="${REPO_ROOT}" \
    /bin/bash "${REPO_ROOT}/deploy/scripts/open_github_issue.sh" \
    stale-index "search index missing" -
  exit 1
fi

newest="$(printf '%s\n' "${indices}" | sort -r | head -1)"
suffix="${newest#${ALIAS}-}"

if [[ ! "${suffix}" =~ ^[0-9]{12}$ ]]; then
  echo "[check_ingest_health] unexpected index name: ${newest}" >&2
  exit 1
fi

index_epoch="$(
  date -u -d "${suffix:0:4}-${suffix:4:2}-${suffix:6:2} ${suffix:8:2}:${suffix:10:2}:00" +%s
)"
now_epoch="$(date -u +%s)"
age_min="$(( (now_epoch - index_epoch) / 60 ))"

if (( age_min <= STALE_AFTER_MIN )); then
  echo "[check_ingest_health] ${newest} is ${age_min}m old (threshold ${STALE_AFTER_MIN}m); ok"
  exit 0
fi

git_head="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
last_ingested=""
state_file="${FEEDBACK_STATE_DIR:-/var/lib/feedback-search}/last_ingested_sha"
if [[ -f "${state_file}" ]]; then
  last_ingested="$(tr -d '\n' < "${state_file}")"
fi

BODY="$(cat <<EOF
Newest backing index **${newest}** is **${age_min}** minutes old (threshold **${STALE_AFTER_MIN}**).
Server git HEAD: \`${git_head}\`
Last ingested SHA: \`${last_ingested:-unknown}\`
EOF
)"

printf '%s\n' "${BODY}" | FEEDBACK_REPO_ROOT="${REPO_ROOT}" \
  /bin/bash "${REPO_ROOT}/deploy/scripts/open_github_issue.sh" \
  stale-index "search index stale (${age_min}m)" -

echo "[check_ingest_health] alerted: ${newest} is ${age_min}m old" >&2
exit 1
