#!/usr/bin/env bash
set -euo pipefail
#
# Applies host runtime from this repository: indexer container, secrets refresh,
# search UI assets, nginx vhost/conf.d snippets, gateway restart when present.
#
# Env: DOMAIN (default vrchat-canny.hackebein.dev) — must match bootstrap_https / TLS cert hostname.
#

REPO="${FEEDBACK_REPO_ROOT:?export FEEDBACK_REPO_ROOT first}"
cd "${REPO}"

WWW_ROOT="/var/www/feedback-search"

if [[ -f /etc/feedback-search/admin.env ]]; then
  docker compose -f deploy/docker-compose.yml up -d --pull always
fi

FEEDBACK_REPO_ROOT="${REPO}" /bin/bash "${REPO}/deploy/scripts/bootstrap_security.sh"

# Redeploy often refreshes the stack without a new git commit; scheduled ingest then
# never runs (see scripts/run_reindex_maybe.py). If the OpenSearch alias is missing
# (empty volume, first boot), populate it from boards/ so /api/search stops returning 500.
ensure_search_index_if_missing() {
  local ingest_env="/etc/feedback-search/ingest.env"
  [[ -f "${ingest_env}" ]] || return 0

  local boards_dir="${REPO}/boards"
  if [[ ! -d "${boards_dir}" ]]; then
    echo "Search auto-index skipped: no boards dir at ${boards_dir}" >&2
    return 0
  fi

  set -a
  # shellcheck disable=SC1090
  source "${ingest_env}"
  set +a
  export FEEDBACK_REPO_ROOT="${REPO}"

  local alias="${OPENSEARCH_ALIAS:-feedback-posts}"
  local os_url="${OPENSEARCH_URL:-http://127.0.0.1:9200}"
  os_url="${os_url%/}"

  local code
  if ! code="$(
    curl -sS -o /dev/null -w '%{http_code}' -m 15 \
      -u "${OPENSEARCH_USER}:${OPENSEARCH_PASSWORD}" \
      -X HEAD "${os_url}/${alias}"
  )"; then
    echo "Search auto-index skipped: cannot reach ${os_url} (curl failed)." >&2
    return 0
  fi

  if [[ "${code}" == "200" ]]; then
    return 0
  fi
  if [[ "${code}" != "404" ]]; then
    echo "Search auto-index skipped: HEAD ${os_url}/${alias} -> HTTP ${code} (auto-ingest only on 404)." >&2
    return 0
  fi

  echo "OpenSearch alias ${alias} missing; running scripts/opensearch_bulk.py" >&2
  local py="/opt/feedback-ingest/venv/bin/python"
  [[ -x "${py}" ]] || py="python3"
  "${py}" "${REPO}/scripts/opensearch_bulk.py"
}

ensure_search_index_if_missing

install -d "${WWW_ROOT}"
install -m 0644 "${REPO}/deploy/nginx/search-gateway-openapi.json" "${WWW_ROOT}/openapi.json"

DOMAIN="${DOMAIN:-vrchat-canny.hackebein.dev}"

if ! command -v nginx >/dev/null 2>&1; then
  chmod -R a+rX "${WWW_ROOT}"
  exit 0
fi

if [[ ! -f /etc/ssl/cloudflare/origin/cert.pem ]]; then
  echo "No Origin CA cert yet — skipping nginx refresh." >&2
  chmod -R a+rX "${WWW_ROOT}"
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required when nginx TLS is configured (sync builds search-ui)." >&2
  exit 1
fi

(cd "${REPO}/search-ui" && npm ci && npm run build)
rm -rf "${WWW_ROOT}/assets"
cp -a "${REPO}/search-ui/dist/web/"* "${WWW_ROOT}/"

chmod -R a+rX "${WWW_ROOT}"

NGINX_SRC="${REPO}/deploy/nginx"
install -d /etc/nginx/conf.d

install -m 0644 "${NGINX_SRC}/conf.d/feedback-search-limit-zones.conf" /etc/nginx/conf.d/feedback-search-limit-zones.conf
install -m 0644 "${NGINX_SRC}/conf.d/feedback-search-public-cors.inc" /etc/nginx/conf.d/feedback-search-public-cors.inc
install -m 0644 "${NGINX_SRC}/conf.d/feedback-search-http-proxy-defaults.inc" /etc/nginx/conf.d/feedback-search-http-proxy-defaults.inc
install -m 0644 "${NGINX_SRC}/conf.d/feedback-search-gateway-upstream.conf" /etc/nginx/conf.d/feedback-search-gateway-upstream.conf

bash "${REPO}/deploy/scripts/install_cloudflare_real_ip.sh"

if [[ ! -f /etc/feedback-search/gateway.env ]]; then
  echo "Missing /etc/feedback-search/gateway.env." >&2
  exit 1
fi

sed "s/@FEEDBACK_PUBLIC_DOMAIN@/${DOMAIN}/g" "${NGINX_SRC}/sites/https-public.conf.template" >"/etc/nginx/sites-available/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

nginx -t
systemctl reload nginx

if systemctl cat feedback-search-gateway.service >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl restart feedback-search-gateway.service
fi
