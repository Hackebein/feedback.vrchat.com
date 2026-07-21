#!/usr/bin/env bash
# Install/configure Postfix inbound for canny@vrchat-canny.hackebein.dev.
# Idempotent. Expects FEEDBACK_REPO_ROOT. Secrets in /etc/feedback-search/mail.env.
set -euo pipefail

REPO="${FEEDBACK_REPO_ROOT:?export FEEDBACK_REPO_ROOT first}"
MAIL_SRC="${REPO}/deploy/mail"
HOOK_SRC="${REPO}/deploy/scripts/canny_mail_hook.py"
MAIL_ENV="/etc/feedback-search/mail.env"
HOOK_BIN="/usr/local/bin/canny-mail-hook"

if [[ ! -d "${MAIL_SRC}" ]]; then
  echo "mail config missing at ${MAIL_SRC}" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if ! command -v postfix >/dev/null 2>&1; then
  apt-get update -qq
  debconf-set-selections <<EOF
postfix postfix/main_mailer_type select No configuration
postfix postfix/mailname string mx.vrchat-canny.hackebein.dev
EOF
  apt-get install -y -qq postfix python3
fi
if [[ ! -f /etc/postfix/main.cf ]]; then
  cp /usr/share/postfix/main.cf.debian /etc/postfix/main.cf
fi
if [[ ! -f /etc/postfix/master.cf ]]; then
  cp /usr/share/postfix/master.cf.debian /etc/postfix/master.cf
fi

id -u cannymail >/dev/null 2>&1 || useradd --system --home /var/lib/feedback-search --shell /usr/sbin/nologin cannymail
install -d -o cannymail -g cannymail -m 0750 /var/lib/feedback-search
install -d -o cannymail -g cannymail -m 0750 /var/lib/feedback-search/mail-drop

install -m 0755 "${HOOK_SRC}" "${HOOK_BIN}"

install -d /etc/feedback-search
# cannymail must traverse this dir to read mail.env from the pipe hook.
chmod 0751 /etc/feedback-search
# Prefer explicit GH_DISPATCH_TOKEN; otherwise reuse GH_ISSUE_TOKEN from github.env.
DISPATCH_TOKEN="${GH_DISPATCH_TOKEN:-}"
if [[ -z "${DISPATCH_TOKEN}" && -f /etc/feedback-search/github.env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck disable=SC1091
  source /etc/feedback-search/github.env
  set +a
  DISPATCH_TOKEN="${GH_ISSUE_TOKEN:-}"
fi
if [[ -f "${MAIL_ENV}" ]]; then
  EXISTING="$(grep -E '^GH_DISPATCH_TOKEN=.' "${MAIL_ENV}" | head -1 | cut -d= -f2- || true)"
  [[ -n "${EXISTING}" && -z "${DISPATCH_TOKEN}" ]] && DISPATCH_TOKEN="${EXISTING}"
  # Drop legacy Gmail-forward keys if present.
  tmp="$(mktemp)"
  grep -vE '^(GMAIL_|FORWARD_TO=)' "${MAIL_ENV}" >"${tmp}" || true
  mv "${tmp}" "${MAIL_ENV}"
fi
umask 027
cat >"${MAIL_ENV}" <<EOF
# Inbound mail secrets for canny@vrchat-canny.hackebein.dev
# GH_DISPATCH_TOKEN may be the same fine-grained PAT as GH_ISSUE_TOKEN.
GH_DISPATCH_TOKEN=${DISPATCH_TOKEN}
GH_DISPATCH_REPO=Hackebein/feedback.vrchat.com
EOF
if [[ -z "${DISPATCH_TOKEN}" ]]; then
  echo "Created ${MAIL_ENV} — GH_DISPATCH_TOKEN empty (set GH_ISSUE_TOKEN or GH_DISPATCH_TOKEN)" >&2
fi
chown root:cannymail "${MAIL_ENV}"
chmod 0640 "${MAIL_ENV}"

install -m 0644 "${MAIL_SRC}/transport_canny" /etc/postfix/transport_canny
install -m 0644 "${MAIL_SRC}/recipient_access" /etc/postfix/recipient_access
postmap /etc/postfix/transport_canny
postmap /etc/postfix/recipient_access

while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue
  postconf -e "${line}"
done <"${MAIL_SRC}/main.cf.snippet"

if ! grep -q '^canny-hook[[:space:]]' /etc/postfix/master.cf; then
  cat "${MAIL_SRC}/master.cf.snippet" >>/etc/postfix/master.cf
fi

systemctl enable postfix
systemctl restart postfix
postfix check
echo "Postfix inbound ready for canny@vrchat-canny.hackebein.dev" >&2
