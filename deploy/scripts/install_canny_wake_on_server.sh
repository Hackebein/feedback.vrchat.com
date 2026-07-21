#!/usr/bin/env bash
# Install systemd timer that polls Canny notifications + newest posts and
# wakes GitHub Actions via repository_dispatch (canny-wake).
#
#   export FEEDBACK_REPO_ROOT=/srv/feedback.vrchat.com
#   bash deploy/scripts/install_canny_wake_on_server.sh
#
# Secrets: /etc/feedback-search/canny.env (VRChat) and github.env (GH token).

set -euo pipefail

REPO_ROOT="${FEEDBACK_REPO_ROOT:?Set FEEDBACK_REPO_ROOT (e.g. /srv/feedback.vrchat.com)}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the indexer host." >&2
  exit 1
fi

VENV_DIR="${VENV_DIR:-/opt/feedback-canny-wake/venv}"
REQS="${REPO_ROOT}/scripts/requirements-canny-wake.txt"
CANNY_ENV="/etc/feedback-search/canny.env"
UNIT_SRC="${REPO_ROOT}/deploy/systemd"

export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq python3-venv curl

install -d "$(dirname "${VENV_DIR}")"
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  python3 -m venv "${VENV_DIR}"
fi
"${VENV_DIR}/bin/pip" install --quiet --upgrade pip
"${VENV_DIR}/bin/pip" install --quiet -r "${REQS}"

install -d /etc/feedback-search
install -d -m 0755 /var/lib/feedback-search

if [[ ! -f "${CANNY_ENV}" ]]; then
  umask 077
  cat >"${CANNY_ENV}" <<'EOF'
# VRChat SSO for feedback-canny-wake.timer (Canny /api/notifications/get).
# Same values as GitHub Actions secrets VRCHAT_*.
VRCHAT_USERNAME=
VRCHAT_PASSWORD=
VRCHAT_TOTP_SECRET=
# Optional: twoFactorAuth cookie to skip new-location email OTP.
# VRCHAT_TWO_FACTOR_AUTH=
# Optional override; otherwise GH_ISSUE_TOKEN from github.env is used.
# GH_DISPATCH_TOKEN=
# GH_DISPATCH_REPO=Hackebein/feedback.vrchat.com
EOF
  chmod 0600 "${CANNY_ENV}"
  echo "Created ${CANNY_ENV} — fill VRCHAT_* before the timer can wake Actions." >&2
fi
chmod 0600 "${CANNY_ENV}" || true

install -m 0644 "${UNIT_SRC}/feedback-canny-wake.service" /etc/systemd/system/feedback-canny-wake.service
install -m 0644 "${UNIT_SRC}/feedback-canny-wake.timer" /etc/systemd/system/feedback-canny-wake.timer

sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_ROOT}|" /etc/systemd/system/feedback-canny-wake.service
sed -i "s|^ExecStart=.*|ExecStart=${VENV_DIR}/bin/python deploy/scripts/canny_wake_poll.py|" \
  /etc/systemd/system/feedback-canny-wake.service

systemctl daemon-reload
systemctl enable --now feedback-canny-wake.timer

echo "Enabled feedback-canny-wake.timer." >&2
echo "Check: systemctl status feedback-canny-wake.timer" >&2
echo "Logs:  journalctl -u feedback-canny-wake.service -n 50" >&2
