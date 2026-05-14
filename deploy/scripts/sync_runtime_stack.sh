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
