#!/usr/bin/env bash
# Create/update DNS-only (grey cloud) A for mx.<domain> and MX for the apex subdomain.
# Requires: CF_API_TOKEN with Zone:DNS:Edit, jq, curl.
# Usage: CF_API_TOKEN=... ./cloudflare_set_mx.sh SERVER_IPV4
# Optional: ZONE_NAME=hackebein.dev RECORD_NAME=vrchat-canny MX_HOST=mx.vrchat-canny.hackebein.dev

set -euo pipefail

IP="${1:?Usage: $0 SERVER_IPV4}"

CF_API_TOKEN="${CF_API_TOKEN:?Set CF_API_TOKEN (see deploy/credentials.local.md)}"
ZONE_NAME="${ZONE_NAME:-hackebein.dev}"
RECORD_NAME="${RECORD_NAME:-vrchat-canny}"
MAIL_DOMAIN="${RECORD_NAME}.${ZONE_NAME}"
MX_HOST="${MX_HOST:-mx.${MAIL_DOMAIN}}"

ZONE_JSON="$(curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}")"

if [[ "$(echo "${ZONE_JSON}" | jq -r '.success')" != "true" ]]; then
  echo "${ZONE_JSON}" | jq .
  exit 1
fi

ZONE_ID="$(echo "${ZONE_JSON}" | jq -r '.result[0].id // empty')"
if [[ -z "${ZONE_ID}" ]]; then
  echo "Zone not found: ${ZONE_NAME}" >&2
  exit 1
fi

upsert_a() {
  local name="$1" content="$2"
  local list id payload res
  list="$(curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=${name}")"
  id="$(echo "${list}" | jq -r '.result[0].id // empty')"
  # DNS only — SMTP must not go through Cloudflare proxy.
  payload="$(jq -n --arg ip "${content}" --arg name "${name}" \
    '{type:"A", name:$name, content:$ip, ttl:300, proxied:false}')"
  if [[ -n "${id}" ]]; then
    res="$(curl -sS -X PATCH \
      "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${id}" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${payload}")"
  else
    res="$(curl -sS -X POST \
      "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${payload}")"
  fi
  echo "${res}" | jq .
  [[ "$(echo "${res}" | jq -r '.success')" == "true" ]]
}

upsert_mx() {
  local name="$1" content="$2" priority="${3:-10}"
  local list id payload res
  list="$(curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=MX&name=${name}")"
  id="$(echo "${list}" | jq -r '.result[0].id // empty')"
  payload="$(jq -n --arg content "${content}" --arg name "${name}" --argjson priority "${priority}" \
    '{type:"MX", name:$name, content:$content, priority:$priority, ttl:300}')"
  if [[ -n "${id}" ]]; then
    res="$(curl -sS -X PATCH \
      "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${id}" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${payload}")"
  else
    res="$(curl -sS -X POST \
      "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${payload}")"
  fi
  echo "${res}" | jq .
  [[ "$(echo "${res}" | jq -r '.success')" == "true" ]]
}

upsert_a "${MX_HOST}" "${IP}"
upsert_mx "${MAIL_DOMAIN}" "${MX_HOST}" 10

echo "OK: ${MX_HOST} A -> ${IP} (DNS only); ${MAIL_DOMAIN} MX -> ${MX_HOST}" >&2
