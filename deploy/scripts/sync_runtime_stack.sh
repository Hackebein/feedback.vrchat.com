#!/usr/bin/env bash
set -euo pipefail
# Refresh Docker/OpenSearch, published OpenAPI JSON, and nginx from the repo checkout.
# Intended after git fast-forward (see scripts/run_reindex_maybe.py). Requires root.

REPO="${FEEDBACK_REPO_ROOT:?export FEEDBACK_REPO_ROOT first}"
cd "${REPO}"

docker compose -f deploy/docker-compose.yml up -d --pull always

install -d /var/www/vrchat-feedback-search
install -m 0644 "${REPO}/deploy/nginx/vrchat-feedback-search-openapi.json" /var/www/vrchat-feedback-search/openapi.json

DOMAIN="vrchat-canny.hackebein.dev"
if ! command -v nginx >/dev/null 2>&1; then
  exit 0
fi

if [[ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  echo "No TLS cert under /etc/letsencrypt/live/${DOMAIN}/ yet; skipping nginx refresh." >&2
  exit 0
fi

NGINX_SRC="${REPO}/deploy/nginx"
install -d /etc/nginx/conf.d
install -m 0644 "${NGINX_SRC}/conf.d/opensearch-limits.conf" /etc/nginx/conf.d/opensearch-limits.conf
install -m 0644 "${NGINX_SRC}/conf.d/vrchat-feedback-search-cors.inc" /etc/nginx/conf.d/vrchat-feedback-search-cors.inc

sed "s/@FEEDBACK_PUBLIC_DOMAIN@/${DOMAIN}/g" "${NGINX_SRC}/sites/https-public.conf.template" >"/etc/nginx/sites-available/${DOMAIN}"

rm -f "/etc/nginx/sites-enabled/${DOMAIN}-acme"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

nginx -t
systemctl reload nginx
