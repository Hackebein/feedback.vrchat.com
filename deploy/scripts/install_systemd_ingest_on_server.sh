#!/usr/bin/env bash
# Install systemd units on the OpenSearch host for git-pull, compose/nginx/OpenAPI refresh, and reindex.
# Run ON THE SERVER as root after the repo exists at FEEDBACK_REPO_ROOT.
#
#   export FEEDBACK_REPO_ROOT=/srv/feedback.vrchat.com
#   bash deploy/scripts/install_systemd_ingest_on_server.sh

set -euo pipefail

REPO_ROOT="${FEEDBACK_REPO_ROOT:?Set FEEDBACK_REPO_ROOT (e.g. /srv/feedback.vrchat.com)}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the OpenSearch host." >&2
  exit 1
fi

install -d /etc/default
cat <<ENV > /etc/default/feedback-opensearch-ingest
FEEDBACK_REPO_ROOT=${REPO_ROOT}
OPENSEARCH_URL=http://127.0.0.1:9200
FORCE_REINDEX=0
ENV

install -m 0644 "${REPO_ROOT}/deploy/systemd/feedback-ingest.service" /etc/systemd/system/feedback-ingest.service
install -m 0644 "${REPO_ROOT}/deploy/systemd/feedback-ingest.timer" /etc/systemd/system/feedback-ingest.timer

# Match installed unit name and repo path on disk
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_ROOT}|" /etc/systemd/system/feedback-ingest.service

systemctl daemon-reload
systemctl enable --now feedback-ingest.timer

echo "Enabled feedback-ingest.timer. Check: systemctl status feedback-ingest.timer" >&2
