#!/usr/bin/env bash
# Run as root on the OpenSearch VPS. Installs nginx and issues a Cloudflare
# Origin CA cert, then publishes the HTTPS vhost.
#
# Env (optional):
#   DOMAIN          default vrchat-canny.hackebein.dev
#   CF_API_TOKEN    sourced from /etc/feedback-search/cf.env if not in env.
#                   Needs Zone:SSL and Certificates:Edit on the zone.

set -euo pipefail

DOMAIN="${DOMAIN:-vrchat-canny.hackebein.dev}"

DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_SRC="${DEPLOY_ROOT}/nginx"

if [[ -z "${CF_API_TOKEN:-}" && -f /etc/feedback-search/cf.env ]]; then
  # shellcheck disable=SC1091
  . /etc/feedback-search/cf.env
fi
[[ -n "${CF_API_TOKEN:-}" ]] || { echo "CF_API_TOKEN must be set (Zone:SSL and Certificates:Edit)." >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx jq openssl ca-certificates curl

install -d /etc/nginx/conf.d
install -m 0644 "${NGINX_SRC}/conf.d/opensearch-limits.conf" /etc/nginx/conf.d/opensearch-limits.conf
install -m 0644 "${NGINX_SRC}/conf.d/vrchat-feedback-search-cors.inc" /etc/nginx/conf.d/vrchat-feedback-search-cors.inc
install -m 0644 "${NGINX_SRC}/conf.d/vrchat-feedback-search-proxy-extra.inc" /etc/nginx/conf.d/vrchat-feedback-search-proxy-extra.inc

bash "${DEPLOY_ROOT}/scripts/install_cloudflare_real_ip.sh"

if [[ ! -f /etc/nginx/conf.d/feedback-search-upstream-auth.inc ]]; then
  echo "Missing /etc/nginx/conf.d/feedback-search-upstream-auth.inc — run deploy/scripts/bootstrap_security.sh first." >&2
  exit 1
fi

# Issue (or refresh) the Cloudflare Origin CA cert. Idempotent.
DOMAIN="${DOMAIN}" CF_API_TOKEN="${CF_API_TOKEN}" \
  bash "${DEPLOY_ROOT}/scripts/install_origin_ca_cert.sh"

install -d /var/www/vrchat-feedback-search
install -m 0644 "${NGINX_SRC}/vrchat-feedback-search-openapi.json" /var/www/vrchat-feedback-search/openapi.json

rm -f /etc/nginx/sites-enabled/default

sed "s/@FEEDBACK_PUBLIC_DOMAIN@/${DOMAIN}/g" "${NGINX_SRC}/sites/https-public.conf.template" >"/etc/nginx/sites-available/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

systemctl enable --now nginx
nginx -t
systemctl reload nginx

echo "HTTPS ready: https://${DOMAIN}" >&2
