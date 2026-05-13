#!/usr/bin/env bash
# Point vrchat-canny.hackebein.dev (DNS only) at the current Terraform server IPv4.
# Requires: HCLOUD_TOKEN, CF_API_TOKEN; terraform state in deploy/terraform.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="${ROOT}/deploy/terraform"

if [[ -z "${HCLOUD_TOKEN:-}" ]] || [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "Set HCLOUD_TOKEN and CF_API_TOKEN (see deploy/credentials.local.md)." >&2
  exit 1
fi

cd "${TF_DIR}"
IP="$(terraform output -raw server_ipv4)"

exec "${ROOT}/deploy/scripts/cloudflare_set_subdomain_a.sh" "${IP}"
