#!/usr/bin/env bash
# Tear down Postfix Canny-email wake-up (replaced by feedback-canny-wake.timer).
# Idempotent. Safe if mail was never installed.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the indexer host." >&2
  exit 1
fi

HOOK_BIN="/usr/local/bin/canny-mail-hook"
MAIL_ENV="/etc/feedback-search/mail.env"

if systemctl list-unit-files postfix.service >/dev/null 2>&1; then
  systemctl disable --now postfix.service 2>/dev/null || true
fi

rm -f "${HOOK_BIN}"
rm -f "${MAIL_ENV}"
rm -f /var/lib/feedback-search/canny-mail-dispatch.ts

# Drop canny-hook pipe transport lines if present (best-effort).
if [[ -f /etc/postfix/master.cf ]] && grep -q '^canny-hook[[:space:]]' /etc/postfix/master.cf; then
  tmp="$(mktemp)"
  awk '
    BEGIN { skip=0 }
    /^canny-hook[[:space:]]/ { skip=1; next }
    skip && /^[[:space:]]/ { next }
    { skip=0; print }
  ' /etc/postfix/master.cf >"${tmp}"
  mv "${tmp}" /etc/postfix/master.cf
fi

echo "Postfix Canny mail wake-up removed (if it was present)." >&2
