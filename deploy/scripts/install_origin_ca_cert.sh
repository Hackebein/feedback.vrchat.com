#!/usr/bin/env bash
# Issue (or refresh) a Cloudflare Origin CA certificate for ${DOMAIN} and
# install it under ${OUT_DIR}. Idempotent — does nothing if the existing
# cert still has more than ${RENEW_THRESHOLD_DAYS} days of validity.
#
# Requires CF_API_TOKEN with Zone:SSL and Certificates:Edit on the zone.
# Reads it from the environment or /etc/feedback-search/cf.env.
#
# Env (all optional):
#   DOMAIN                 default vrchat-canny.hackebein.dev
#   DAYS_VALID             default 5475   (15 years; max is 5475)
#   RENEW_THRESHOLD_DAYS   default 90
#   OUT_DIR                default /etc/ssl/cloudflare/origin
#   CF_API                 default https://api.cloudflare.com/client/v4

set -euo pipefail

DOMAIN="${DOMAIN:-vrchat-canny.hackebein.dev}"
DAYS_VALID="${DAYS_VALID:-5475}"
RENEW_THRESHOLD_DAYS="${RENEW_THRESHOLD_DAYS:-90}"
OUT_DIR="${OUT_DIR:-/etc/ssl/cloudflare/origin}"
CF_API="${CF_API:-https://api.cloudflare.com/client/v4}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

if [[ -z "${CF_API_TOKEN:-}" && -f /etc/feedback-search/cf.env ]]; then
  # shellcheck disable=SC1091
  . /etc/feedback-search/cf.env
fi
[[ -n "${CF_API_TOKEN:-}" ]] || { echo "CF_API_TOKEN must be set (Zone:SSL and Certificates:Edit)." >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need openssl
need jq
need curl

install -d -m 0755 "${OUT_DIR}"
CERT="${OUT_DIR}/cert.pem"
KEY="${OUT_DIR}/key.pem"

if [[ -s "${CERT}" && -s "${KEY}" ]]; then
  if openssl x509 -in "${CERT}" -checkend "$((RENEW_THRESHOLD_DAYS * 86400))" -noout >/dev/null 2>&1; then
    cur_subj_cn="$(openssl x509 -in "${CERT}" -noout -subject 2>/dev/null | sed -E 's/.*CN[[:space:]]*=[[:space:]]*//;s/,.*//')"
    if [[ "${cur_subj_cn}" == "${DOMAIN}" ]]; then
      echo "[origin-ca] ${CERT} valid for >${RENEW_THRESHOLD_DAYS} days and matches ${DOMAIN}; nothing to do." >&2
      exit 0
    fi
    echo "[origin-ca] cert subject CN=${cur_subj_cn} != ${DOMAIN}; reissuing." >&2
  else
    echo "[origin-ca] cert near expiry (<${RENEW_THRESHOLD_DAYS} days); reissuing." >&2
  fi
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
KEY_TMP="${WORK}/key.pem"
CSR_TMP="${WORK}/req.csr"
CERT_TMP="${WORK}/cert.pem"

echo "[origin-ca] generating RSA-4096 key + CSR for ${DOMAIN}…" >&2
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "${KEY_TMP}" 2>/dev/null
chmod 0600 "${KEY_TMP}"
openssl req -new -key "${KEY_TMP}" -out "${CSR_TMP}" -subj "/CN=${DOMAIN}" 2>/dev/null

CSR_TEXT="$(cat "${CSR_TMP}")"
PAYLOAD="$(jq -nc \
  --arg csr "${CSR_TEXT}" \
  --arg dom "${DOMAIN}" \
  --argjson days "${DAYS_VALID}" \
  '{hostnames:[$dom], requested_validity:$days, request_type:"origin-rsa", csr:$csr}')"

echo "[origin-ca] requesting cert from Cloudflare (validity=${DAYS_VALID}d)…" >&2
RES_FILE="${WORK}/api.json"
HTTP_CODE="$(curl -sS -o "${RES_FILE}" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "${PAYLOAD}" \
  "${CF_API}/certificates")"

if [[ "${HTTP_CODE}" != "200" && "${HTTP_CODE}" != "201" ]]; then
  echo "[origin-ca] CF API HTTP ${HTTP_CODE}:" >&2
  jq . < "${RES_FILE}" >&2 || cat "${RES_FILE}" >&2
  exit 1
fi
if [[ "$(jq -r '.success' < "${RES_FILE}")" != "true" ]]; then
  echo "[origin-ca] CF API returned success=false:" >&2
  jq . < "${RES_FILE}" >&2
  exit 1
fi

jq -r '.result.certificate' < "${RES_FILE}" > "${CERT_TMP}"
if ! grep -q 'BEGIN CERTIFICATE' "${CERT_TMP}"; then
  echo "[origin-ca] CF response missing certificate field." >&2
  jq . < "${RES_FILE}" >&2
  exit 1
fi

# Atomic install: write to *.new then mv into place. Both files become
# consistent in the same step.
install -m 0644 "${CERT_TMP}" "${CERT}.new"
install -m 0600 "${KEY_TMP}" "${KEY}.new"
mv -f "${CERT}.new" "${CERT}"
mv -f "${KEY}.new" "${KEY}"

echo "[origin-ca] installed:" >&2
openssl x509 -in "${CERT}" -noout -subject -issuer -enddate >&2

if command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    echo "[origin-ca] nginx reloaded." >&2
  else
    echo "[origin-ca] nginx -t failed after cert install; not reloading." >&2
  fi
fi
