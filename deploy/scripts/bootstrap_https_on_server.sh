#!/usr/bin/env bash
#
# Feedback search HTTPS edge — run as root once (or after cert rotation).
#
# Prerequisites: deploy/scripts/bootstrap_security.sh (writes gateway.env)
#
# Installs nginx, publishes static UI + openapi under /var/www/feedback-search,
# wires TLS via Cloudflare Origin CA, delegates /api/** to localhost SearchKit gateway.
#

set -euo pipefail

DOMAIN="${DOMAIN:-vrchat-canny.hackebein.dev}"

DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_SRC="${DEPLOY_ROOT}/nginx"
REPO_ROOT="$(cd "${DEPLOY_ROOT}/.." && pwd)"
WWW_ROOT="/var/www/feedback-search"

if [[ -z "${CF_API_TOKEN:-}" && -f /etc/feedback-search/cf.env ]]; then
  # shellcheck disable=SC1091
  . /etc/feedback-search/cf.env
fi
[[ -n "${CF_API_TOKEN:-}" ]] || { echo "CF_API_TOKEN must be set (Zone:SSL + Origin CA issuance)." >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx jq openssl ca-certificates curl

install -d /etc/nginx/conf.d

install -m 0644 "${NGINX_SRC}/conf.d/feedback-search-public-cors.inc" /etc/nginx/conf.d/feedback-search-public-cors.inc
install -m 0644 "${NGINX_SRC}/conf.d/feedback-search-http-proxy-defaults.inc" /etc/nginx/conf.d/feedback-search-http-proxy-defaults.inc
install -m 0644 "${NGINX_SRC}/conf.d/feedback-search-gateway-upstream.conf" /etc/nginx/conf.d/feedback-search-gateway-upstream.conf

bash "${DEPLOY_ROOT}/scripts/install_cloudflare_real_ip.sh"

if [[ ! -f /etc/feedback-search/gateway.env ]]; then
  echo "Missing /etc/feedback-search/gateway.env — run deploy/scripts/bootstrap_security.sh first." >&2
  exit 1
fi

DOMAIN="${DOMAIN}" CF_API_TOKEN="${CF_API_TOKEN}" \
  bash "${DEPLOY_ROOT}/scripts/install_origin_ca_cert.sh"

install -d "${WWW_ROOT}"
install -m 0644 "${NGINX_SRC}/search-gateway-openapi.json" "${WWW_ROOT}/openapi.json"

rm -f /etc/nginx/sites-enabled/default

sed "s/@FEEDBACK_PUBLIC_DOMAIN@/${DOMAIN}/g" "${NGINX_SRC}/sites/https-public.conf.template" >"/etc/nginx/sites-available/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

systemctl enable --now nginx
nginx -t
systemctl reload nginx

echo "Listening: https://${DOMAIN}" >&2

FEEDBACK_REPO_ROOT="${REPO_ROOT}" WWW_ROOT="${WWW_ROOT}" \
  bash "${DEPLOY_ROOT}/scripts/install_search_gateway_on_server.sh"
