#!/usr/bin/env bash
# Idempotent swap setup for memory-heavy npm builds on small VMs.
set -euo pipefail

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-4G}"

if swapon --show 2>/dev/null | awk 'NR > 1 { exit 0 } END { exit 1 }'; then
  exit 0
fi

if [[ ! -f "${SWAP_FILE}" ]]; then
  fallocate -l "${SWAP_SIZE}" "${SWAP_FILE}"
  chmod 600 "${SWAP_FILE}"
  mkswap "${SWAP_FILE}"
fi

swapon "${SWAP_FILE}"

if ! grep -q "^${SWAP_FILE} " /etc/fstab 2>/dev/null; then
  echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
fi
