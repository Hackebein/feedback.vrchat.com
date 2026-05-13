#!/usr/bin/env bash
# Resolve path to the Hetzner root SSH private key. OpenSSH cannot use a key from an
# environment variable with -i; if HETZNER_SSH_PRIVATE_KEY is set, it is written (once)
# to deploy/terraform/.ssh/hetzner_admin (gitignored) and that path is printed.
#
# Exit 0 — prints absolute path to the key file (single line, no newline at end optional;
# we use printf '%s\n' for consistency with command substitution trimming).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TF="${ROOT}/deploy/terraform"
KEY="${TF}/.ssh/hetzner_admin"

mkdir -p "${TF}/.ssh"

if [[ -n "${HETZNER_SSH_PRIVATE_KEY:-}" ]]; then
  umask 0177
  printf '%s\n' "${HETZNER_SSH_PRIVATE_KEY}" >"${KEY}.tmp"
  mv -f "${KEY}.tmp" "${KEY}"
fi

if [[ ! -f "${KEY}" ]]; then
  echo "error: no SSH private key. Export HETZNER_SSH_PRIVATE_KEY or create ${KEY}" >&2
  exit 1
fi

chmod 600 "${KEY}"
printf '%s\n' "${KEY}"
