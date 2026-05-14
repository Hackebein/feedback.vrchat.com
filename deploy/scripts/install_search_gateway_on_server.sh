#!/usr/bin/env bash
#
# Installs Node (if needed), builds search-ui, registers feedback-search-gateway,
# publishes static bundles to WWW_ROOT (/var/www/feedback-search by default).
#
# Prerequisites: bootstrap_security.sh, repo checkout at FEEDBACK_REPO_ROOT
#

set -euo pipefail

REPO_ROOT="${FEEDBACK_REPO_ROOT:?Set FEEDBACK_REPO_ROOT}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the indexer host." >&2
  exit 1
fi

WWW_ROOT="${WWW_ROOT:-/var/www/feedback-search}"

if [[ ! -f /etc/feedback-search/gateway.env ]]; then
  echo "Missing /etc/feedback-search/gateway.env — run deploy/scripts/bootstrap_security.sh first." >&2
  exit 1
fi

node_meets_floor() {
  command -v node >/dev/null 2>&1 || return 1
  local mj
  mj="$(node -p "parseInt(process.versions.node.split('.')[0], 10)")"
  [[ "${mj}" -ge 20 ]]
}

if ! node_meets_floor; then
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

SERVICE_TEMPLATE="${REPO_ROOT}/deploy/systemd/feedback-search-gateway.service"

install -m 0644 "${SERVICE_TEMPLATE}" /etc/systemd/system/feedback-search-gateway.service

TMP_UNIT="$(mktemp)"
trap 'rm -f "${TMP_UNIT}"' EXIT

sed -e "s|FEEDBACK_REPO_ROOT_STUB|${REPO_ROOT}|g" \
  "${SERVICE_TEMPLATE}" >"${TMP_UNIT}"
install -m 0644 "${TMP_UNIT}" /etc/systemd/system/feedback-search-gateway.service

(cd "${REPO_ROOT}/search-ui" && npm ci && npm run build)

install -d "${WWW_ROOT}"
cp -a "${REPO_ROOT}/search-ui/dist/web/"* "${WWW_ROOT}/"

chmod -R a+rX "${WWW_ROOT}"

systemctl daemon-reload
systemctl enable feedback-search-gateway.service
systemctl restart feedback-search-gateway.service

echo "[install_search_gateway] unit=feedback-search-gateway www=${WWW_ROOT} (journalctl -u feedback-search-gateway -n 50)" >&2
