#!/usr/bin/env bash
# Install systemd units for scheduled ingest / reindex refresh.
# Run ON THE SERVER as root after the repo exists at FEEDBACK_REPO_ROOT and
# bootstrap_security.sh has populated /etc/feedback-search/ingest.env.
#
#   export FEEDBACK_REPO_ROOT=/srv/feedback.vrchat.com
#   bash deploy/scripts/install_systemd_ingest_on_server.sh

set -euo pipefail

REPO_ROOT="${FEEDBACK_REPO_ROOT:?Set FEEDBACK_REPO_ROOT (e.g. /srv/feedback.vrchat.com)}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the indexer host." >&2
  exit 1
fi

if [[ ! -f /etc/feedback-search/ingest.env ]]; then
  echo "Missing /etc/feedback-search/ingest.env — run deploy/scripts/bootstrap_security.sh first." >&2
  exit 1
fi

# Dedicated venv for the bulk ingest (opensearch-py). Keeping it out of the
# system python avoids PEP 668 friction with apt-managed packages.
VENV_DIR="${VENV_DIR:-/opt/feedback-ingest/venv}"
REQS="${REPO_ROOT}/scripts/requirements-ingest.txt"

export DEBIAN_FRONTEND=noninteractive
apt-get install -y python3-venv

install -d "$(dirname "${VENV_DIR}")"
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  python3 -m venv "${VENV_DIR}"
fi
"${VENV_DIR}/bin/pip" install --quiet --upgrade pip
"${VENV_DIR}/bin/pip" install --quiet -r "${REQS}"

install -m 0644 "${REPO_ROOT}/deploy/systemd/feedback-ingest.service" /etc/systemd/system/feedback-ingest.service
install -m 0644 "${REPO_ROOT}/deploy/systemd/feedback-ingest.timer" /etc/systemd/system/feedback-ingest.timer
install -m 0644 "${REPO_ROOT}/deploy/systemd/feedback-ingest-alert@.service" /etc/systemd/system/feedback-ingest-alert@.service
install -m 0644 "${REPO_ROOT}/deploy/systemd/feedback-health.service" /etc/systemd/system/feedback-health.service
install -m 0644 "${REPO_ROOT}/deploy/systemd/feedback-health.timer" /etc/systemd/system/feedback-health.timer

sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_ROOT}|" /etc/systemd/system/feedback-ingest.service
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_ROOT}|" /etc/systemd/system/feedback-health.service

# Pin the ingest unit to the venv interpreter via a systemd drop-in
# (git_pull_reindex.sh and run_reindex_maybe.py honour $PYTHON / sys.executable).
install -d /etc/systemd/system/feedback-ingest.service.d
cat > /etc/systemd/system/feedback-ingest.service.d/python.conf <<EOF
[Service]
Environment=PYTHON=${VENV_DIR}/bin/python
EOF
chmod 0644 /etc/systemd/system/feedback-ingest.service.d/python.conf

install -d -m 0755 /var/lib/feedback-search

systemctl daemon-reload
systemctl enable --now feedback-ingest.timer
systemctl enable --now feedback-health.timer

echo "Enabled feedback-ingest.timer and feedback-health.timer." >&2
echo "Check: systemctl status feedback-ingest.timer feedback-health.timer" >&2
