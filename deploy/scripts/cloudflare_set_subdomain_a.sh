#!/usr/bin/env bash
# Create or update a Cloudflare DNS-only (grey cloud) A record for a subdomain.
# Requires: CF_API_TOKEN, jq, curl.
# Usage: CF_API_TOKEN=... ./cloudflare_set_subdomain_a.sh 203.0.113.10
# Optional: ZONE_NAME=hackebein.dev RECORD_NAME=vrchat-canny

set -euo pipefail

IP="${1:?Usage: $0 SERVER_IPV4}"

CF_API_TOKEN="${CF_API_TOKEN:?Set CF_API_TOKEN (see deploy/credentials.local.md)}"
ZONE_NAME="${ZONE_NAME:-hackebein.dev}"
RECORD_NAME="${RECORD_NAME:-vrchat-canny}"
FQDN="${RECORD_NAME}.${ZONE_NAME}"

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

LIST_JSON="$(curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=${FQDN}")"

ID="$(echo "${LIST_JSON}" | jq -r '.result[0].id // empty')"

PAYLOAD="$(jq -n --arg ip "${IP}" --arg name "${FQDN}" \
  '{type:"A", name:$name, content:$ip, ttl:300, proxied:false}')"

if [[ -n "${ID}" ]]; then
  RES="$(curl -sS -X PATCH \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${ID}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}")"
else
  RES="$(curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}")"
fi

echo "${RES}" | jq .
if [[ "$(echo "${RES}" | jq -r '.success')" != "true" ]]; then
  exit 1
fi

echo "OK: ${FQDN} -> ${IP} (DNS only, proxied=false)" >&2
