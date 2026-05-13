#!/usr/bin/env bash
# Run as root on the OpenSearch VPS after DNS points here and ports 80/443 are open.
# Obtains Let's Encrypt cert (webroot), installs nginx, proxies an allowlisted API to 127.0.0.1:9200.
#
# Env (optional):
#   DOMAIN           (default: vrchat-canny.hackebein.dev)
#   CERTBOT_EMAIL    (default: admin@hackebein.dev)

set -euo pipefail

DOMAIN="${DOMAIN:-vrchat-canny.hackebein.dev}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@hackebein.dev}"

DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_SRC="${DEPLOY_ROOT}/nginx"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx
systemctl enable --now certbot.timer

install -d /var/www/certbot
install -d /etc/nginx/conf.d
install -m 0644 "${NGINX_SRC}/conf.d/opensearch-limits.conf" /etc/nginx/conf.d/opensearch-limits.conf
install -m 0644 "${NGINX_SRC}/conf.d/vrchat-feedback-search-cors.inc" /etc/nginx/conf.d/vrchat-feedback-search-cors.inc

# Phase 1 — HTTP only for ACME
sed "s/@FEEDBACK_PUBLIC_DOMAIN@/${DOMAIN}/g" "${NGINX_SRC}/sites/acme-http.conf.template" >"/etc/nginx/sites-available/${DOMAIN}-acme"

rm -f /etc/nginx/sites-enabled/default
# Avoid nginx -t failing on a stale HTTPS vhost left from a prior run (bootstrap replaces it after certs).
rm -f "/etc/nginx/sites-enabled/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}-acme" "/etc/nginx/sites-enabled/${DOMAIN}-acme"

nginx -t
systemctl reload nginx

MY_IP="$(curl -fsS --connect-timeout 2 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || curl -4fsS --connect-timeout 5 https://ifconfig.io/ip)"
echo "Server public IPv4: ${MY_IP}"
R=""
for i in $(seq 1 90); do
  R="$(dig +short "${DOMAIN}" @8.8.8.8 | tail -n1)"
  if [[ "${R}" == "${MY_IP}" ]]; then
    echo "DNS OK: ${DOMAIN} -> ${MY_IP}"
    break
  fi
  echo "Waiting for DNS (got ${R:-empty}, want ${MY_IP}) attempt ${i}..."
  sleep 10
done
[[ "${R}" == "${MY_IP}" ]] || { echo "DNS for ${DOMAIN} does not point to this server (${MY_IP}); aborting." >&2; exit 1; }

certbot certonly --webroot -w /var/www/certbot \
  -d "${DOMAIN}" \
  --email "${CERTBOT_EMAIL}" \
  --agree-tos \
  --non-interactive \
  --keep-until-expiring \
  --deploy-hook "systemctl reload nginx"

install -d /var/www/vrchat-feedback-search
install -m 0644 "${NGINX_SRC}/vrchat-feedback-search-openapi.json" /var/www/vrchat-feedback-search/openapi.json

sed "s/@FEEDBACK_PUBLIC_DOMAIN@/${DOMAIN}/g" "${NGINX_SRC}/sites/https-public.conf.template" >"/etc/nginx/sites-available/${DOMAIN}"

rm -f "/etc/nginx/sites-enabled/${DOMAIN}-acme"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

nginx -t
systemctl reload nginx

echo "HTTPS frontdoor OK for https://${DOMAIN}"