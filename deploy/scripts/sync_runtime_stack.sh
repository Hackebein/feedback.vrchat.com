#!/usr/bin/env bash
set -euo pipefail
# Refresh Docker/OpenSearch, security plugin config, published OpenAPI JSON,
# and nginx from the repo checkout. Intended after git fast-forward
# (see scripts/run_reindex_maybe.py). Requires root.

REPO="${FEEDBACK_REPO_ROOT:?export FEEDBACK_REPO_ROOT first}"
cd "${REPO}"

if [[ -f /etc/feedback-search/admin.env ]]; then
  docker compose -f deploy/docker-compose.yml up -d --pull always
fi
FEEDBACK_REPO_ROOT="${REPO}" /bin/bash "${REPO}/deploy/scripts/bootstrap_security.sh"

install -d /var/www/vrchat-feedback-search
install -m 0644 "${REPO}/deploy/nginx/vrchat-feedback-search-openapi.json" /var/www/vrchat-feedback-search/openapi.json

DOMAIN="vrchat-canny.hackebein.dev"
if ! command -v nginx >/dev/null 2>&1; then
  exit 0
fi

if [[ ! -f /etc/ssl/cloudflare/origin/cert.pem ]]; then
  echo "No origin TLS cert at /etc/ssl/cloudflare/origin/cert.pem — run deploy/scripts/bootstrap_https_on_server.sh first. Skipping nginx refresh." >&2
  exit 0
fi

NGINX_SRC="${REPO}/deploy/nginx"
install -d /etc/nginx/conf.d
install -m 0644 "${NGINX_SRC}/conf.d/opensearch-limits.conf" /etc/nginx/conf.d/opensearch-limits.conf
install -m 0644 "${NGINX_SRC}/conf.d/vrchat-feedback-search-cors.inc" /etc/nginx/conf.d/vrchat-feedback-search-cors.inc
install -m 0644 "${NGINX_SRC}/conf.d/vrchat-feedback-search-proxy-extra.inc" /etc/nginx/conf.d/vrchat-feedback-search-proxy-extra.inc

# Refresh Cloudflare IP ranges (cf publishes ~24h ahead of changes).
bash "${REPO}/deploy/scripts/install_cloudflare_real_ip.sh"

if [[ ! -f /etc/nginx/conf.d/feedback-search-upstream-auth.inc ]]; then
  echo "Missing /etc/nginx/conf.d/feedback-search-upstream-auth.inc — bootstrap_security.sh did not run cleanly. Aborting nginx refresh to avoid unauth'd upstream." >&2
  exit 1
fi

sed "s/@FEEDBACK_PUBLIC_DOMAIN@/${DOMAIN}/g" "${NGINX_SRC}/sites/https-public.conf.template" >"/etc/nginx/sites-available/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

nginx -t
systemctl reload nginx
