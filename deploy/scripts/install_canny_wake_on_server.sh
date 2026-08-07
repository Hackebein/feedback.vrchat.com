#!/usr/bin/env bash
# Install long-running Canny host daemon (notifications + newest posts + upvotes).
# Wakes GitHub Actions via repository_dispatch (canny-wake); votes on-host.
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
STATE_PATH="/var/lib/feedback-search/canny-wake-state.json"
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
# VRChat SSO for feedback-canny-wake (notifications + paced upvotes).
# Same values as GitHub Actions secrets VRCHAT_*.
VRCHAT_USERNAME=
VRCHAT_PASSWORD=
VRCHAT_TOTP_SECRET=
# Persisted Netscape cookie jar (reused across ticks; mode 0600).
# CANNY_COOKIE_JAR=/var/lib/feedback-search/canny-cookies.jar
# Optional pacing overrides:
# CANNY_WAKE_POLL_SECS=30
# CANNY_WAKE_VOTE_SECS=65
# CANNY_WAKE_VOTE_BATCH=10
# Optional override; otherwise GH_ISSUE_TOKEN from github.env is used.
# GH_DISPATCH_TOKEN=
# GH_DISPATCH_REPO=Hackebein/feedback.vrchat.com
EOF
  chmod 0600 "${CANNY_ENV}"
  echo "Created ${CANNY_ENV} — fill VRCHAT_* before the daemon can run." >&2
fi
chmod 0600 "${CANNY_ENV}" || true

# Live session credential reused across ticks (avoids VRChat session exhaustion).
touch /var/lib/feedback-search/canny-cookies.jar
chmod 0600 /var/lib/feedback-search/canny-cookies.jar

# Seed votedPostIds from CI scrape-state branch once if host state has none.
if [[ ! -f "${STATE_PATH}" ]] || ! grep -q '"votedPostIds": \[' "${STATE_PATH}" 2>/dev/null \
  || grep -q '"votedPostIds": \[\]' "${STATE_PATH}" 2>/dev/null; then
  if git -C "${REPO_ROOT}" fetch -q origin scrape-state 2>/dev/null \
    && git -C "${REPO_ROOT}" show origin/scrape-state:scrape-state.json >/tmp/scrape-state-seed.json 2>/dev/null; then
    "${VENV_DIR}/bin/python" - <<'PY'
import json
from pathlib import Path

state_path = Path("/var/lib/feedback-search/canny-wake-state.json")
seed = json.loads(Path("/tmp/scrape-state-seed.json").read_text(encoding="utf-8"))
voted = [str(x) for x in (seed.get("votedPostIds") or []) if x]
if state_path.is_file():
    try:
        cur = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        cur = {}
else:
    cur = {}
if not isinstance(cur, dict):
    cur = {}
existing = [str(x) for x in (cur.get("votedPostIds") or []) if x]
if existing:
    raise SystemExit(0)
cur.setdefault("seenNotificationIds", [])
cur.setdefault("dispatchedPostIds", [])
cur.setdefault("lastDispatchAt", 0.0)
cur["votedPostIds"] = sorted(set(voted))
state_path.parent.mkdir(parents=True, exist_ok=True)
tmp = state_path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(cur, indent=2, sort_keys=True) + "\n", encoding="utf-8")
tmp.replace(state_path)
print(f"Seeded {len(voted)} votedPostIds into {state_path}", flush=True)
PY
    rm -f /tmp/scrape-state-seed.json
  fi
fi
chmod 0600 "${STATE_PATH}" 2>/dev/null || true

install -m 0644 "${UNIT_SRC}/feedback-canny-wake.service" /etc/systemd/system/feedback-canny-wake.service

sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_ROOT}|" /etc/systemd/system/feedback-canny-wake.service
sed -i "s|^ExecStart=.*|ExecStart=${VENV_DIR}/bin/python deploy/scripts/canny_wake_poll.py|" \
  /etc/systemd/system/feedback-canny-wake.service

systemctl daemon-reload
# Retire oneshot timer; run as a persistent daemon instead.
systemctl disable --now feedback-canny-wake.timer 2>/dev/null || true
rm -f /etc/systemd/system/feedback-canny-wake.timer
systemctl enable feedback-canny-wake.service
systemctl restart feedback-canny-wake.service

echo "Restarted feedback-canny-wake.service (daemon)." >&2
echo "Check: systemctl status feedback-canny-wake.service" >&2
echo "Logs:  journalctl -u feedback-canny-wake.service -f" >&2
