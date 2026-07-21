#!/usr/bin/env bash
# Apply the recommended Cloudflare zone settings for an origin sitting only
# behind Cloudflare. Idempotent — safe to rerun.
#
# Settings applied:
#   * ssl                         → "strict"   (Full (Strict): origin cert MUST be valid)
#   * always_use_https            → "on"       (CF redirects http:// to https://)
#   * automatic_https_rewrites    → "on"       (rewrites mixed-content links in HTML)
#   * min_tls_version             → "1.2"
#   * tls_1_3                     → "on"
#   * opportunistic_encryption    → "on"
#   * security_header             → enable HSTS for the zone (1 year, includeSubdomains)
#
# Requires: CF_API_TOKEN with **Zone:Zone Settings:Edit** on the zone, jq, curl.
# Usage:
#   CF_API_TOKEN=… ./cloudflare_apply_zone_settings.sh
# Optional:
#   ZONE_NAME=hackebein.dev
#   HSTS_MAX_AGE=31536000           # default 1 year; set to 0 to disable HSTS toggle
#   HSTS_INCLUDE_SUBDOMAINS=true    # default true; set false if other subs aren't HTTPS-only

set -euo pipefail

CF_API_TOKEN="${CF_API_TOKEN:?Set CF_API_TOKEN with Zone:Zone Settings:Edit}"
ZONE_NAME="${ZONE_NAME:-hackebein.dev}"
HSTS_MAX_AGE="${HSTS_MAX_AGE:-31536000}"
HSTS_INCLUDE_SUBDOMAINS="${HSTS_INCLUDE_SUBDOMAINS:-true}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need curl
need jq

ZONE_JSON="$(curl -fsS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}")"
ZONE_ID="$(echo "${ZONE_JSON}" | jq -r '.result[0].id // empty')"
if [[ -z "${ZONE_ID}" ]]; then
  echo "Zone not found or token cannot list it: ${ZONE_NAME}" >&2
  echo "${ZONE_JSON}" | jq . >&2
  exit 1
fi
echo "[zone-settings] zone ${ZONE_NAME} -> ${ZONE_ID}" >&2

patch_setting() {
  local key="$1"
  local body="$2"
  local cur new code resp
  cur="$(curl -fsS -H "Authorization: Bearer ${CF_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/settings/${key}" \
    | jq -c '.result.value // empty')"
  new="$(echo "${body}" | jq -c '.value')"
  if [[ "${cur}" == "${new}" ]]; then
    printf '[zone-settings] %-30s already %s\n' "${key}" "${cur}" >&2
    return 0
  fi
  resp="$(curl -sS -o /tmp/_zs_resp.$$ -w '%{http_code}' \
    -X PATCH \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "${body}" \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/settings/${key}")"
  code="${resp}"
  if [[ "${code}" != "200" ]]; then
    echo "[zone-settings] PATCH ${key} -> HTTP ${code}" >&2
    cat /tmp/_zs_resp.$$ >&2
    rm -f /tmp/_zs_resp.$$
    exit 1
  fi
  printf '[zone-settings] %-30s %s -> %s\n' "${key}" "${cur:-null}" "${new}" >&2
  rm -f /tmp/_zs_resp.$$
}

patch_setting ssl                        '{"value":"strict"}'
patch_setting always_use_https           '{"value":"on"}'
patch_setting automatic_https_rewrites   '{"value":"on"}'
patch_setting min_tls_version            '{"value":"1.2"}'
patch_setting tls_1_3                    '{"value":"on"}'
patch_setting opportunistic_encryption   '{"value":"on"}'

if [[ "${HSTS_MAX_AGE}" -gt 0 ]]; then
  HSTS_BODY="$(jq -nc \
    --argjson max "${HSTS_MAX_AGE}" \
    --argjson sub "${HSTS_INCLUDE_SUBDOMAINS}" \
    '{value:{strict_transport_security:{enabled:true, max_age:$max, include_subdomains:$sub, preload:false, nosniff:true}}}')"
  patch_setting security_header "${HSTS_BODY}"
else
  echo "[zone-settings] HSTS_MAX_AGE=0 — skipping security_header toggle" >&2
fi

echo "[zone-settings] done." >&2
