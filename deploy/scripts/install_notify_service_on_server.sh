#!/usr/bin/env bash
#
# Installs Go (if needed), builds the feedback-notify dispatcher, and registers
# the feedback-notify systemd unit (Web Push + webhook notifications).
#
# Prerequisites: bootstrap_security.sh (writes /etc/feedback-search/notify.env),
# repo checkout at FEEDBACK_REPO_ROOT.
#

set -euo pipefail

REPO_ROOT="${FEEDBACK_REPO_ROOT:?Set FEEDBACK_REPO_ROOT}"
GO_VERSION="${GO_VERSION:-1.26.4}"
BIN_DIR="/opt/feedback-notify"
BIN_PATH="${BIN_DIR}/feedback-notify"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the indexer host." >&2
  exit 1
fi

if [[ ! -f /etc/feedback-search/notify.env ]]; then
  echo "Missing /etc/feedback-search/notify.env — run deploy/scripts/bootstrap_security.sh first." >&2
  exit 1
fi

go_meets_floor() {
  command -v go >/dev/null 2>&1 || return 1
  go version | grep -qE "go1\.(2[6-9]|[3-9][0-9])" || {
    # Accept the pinned version or newer; fall back to a full build attempt.
    return 1
  }
}

ensure_go() {
  if go_meets_floor; then
    return 0
  fi
  if command -v go >/dev/null 2>&1; then
    echo "[install_notify] existing go is older than required; installing go${GO_VERSION}" >&2
  fi
  local tarball="go${GO_VERSION}.linux-amd64.tar.gz"
  curl -fsSL "https://go.dev/dl/${tarball}" -o "/tmp/${tarball}"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "/tmp/${tarball}"
  rm -f "/tmp/${tarball}"
  export PATH="/usr/local/go/bin:${PATH}"
}

ensure_go
export PATH="/usr/local/go/bin:${PATH}"

# systemd runs this with a minimal environment (no $HOME), so Go cannot derive
# GOPATH/GOMODCACHE/GOCACHE and `go build` aborts with "module cache not found".
# Pin them to persistent, writable locations.
export HOME="${HOME:-/root}"
export GOPATH="${GOPATH:-${BIN_DIR}/go}"
export GOMODCACHE="${GOPATH}/pkg/mod"
export GOCACHE="${GOCACHE:-${BIN_DIR}/go-build}"
install -d "${GOPATH}" "${GOCACHE}"

install -d "${BIN_DIR}"
(cd "${REPO_ROOT}/notify" && GOFLAGS=-mod=mod go build -o "${BIN_PATH}" .)

install -m 0644 "${REPO_ROOT}/deploy/systemd/feedback-notify.service" /etc/systemd/system/feedback-notify.service

systemctl daemon-reload
systemctl enable feedback-notify.service
systemctl restart feedback-notify.service

echo "[install_notify] unit=feedback-notify bin=${BIN_PATH} (curl -fsS http://127.0.0.1:3334/api/notify/health)" >&2
