#!/usr/bin/env bash
# First-time provision: Hetzner (Terraform) + Cloudflare DNS A record at server IPv4.
# Expects HCLOUD_TOKEN, CF_API_TOKEN in the environment.
# Optionally pass -y to use terraform apply -auto-approve.
#
# Repo root (parent of deploy/):
#   export HCLOUD_TOKEN='...'
#   export CF_API_TOKEN='...'
#   deploy/scripts/provision.sh [-y]
#
# Uses deploy/terraform/terraform.auto.tfvars if present (gitignored).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="${ROOT}/deploy/terraform"
AUTO_APPROVE=()

if [[ "${1:-}" == "-y" ]] || [[ "${1:-}" == "--yes" ]]; then
  AUTO_APPROVE=("-auto-approve")
fi

if [[ -z "${HCLOUD_TOKEN:-}" ]]; then
  echo "Set HCLOUD_TOKEN (see deploy/credentials.local.md export block)." >&2
  exit 1
fi

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "Set CF_API_TOKEN (see deploy/credentials.local.md)." >&2
  exit 1
fi

# Cloud-init on first boot reads CF_API_TOKEN from /etc/feedback-search/cf.env
# (written by the cloud-init template), then deploy/scripts/install_origin_ca_cert.sh
# uses it to mint a Cloudflare Origin CA certificate. Same scope as the local
# token: Zone:DNS:Edit + Zone:SSL and Certificates:Edit.
export TF_VAR_CF_API_TOKEN="${CF_API_TOKEN}"

cd "${TF_DIR}"
terraform init -input=false
terraform apply -input=false "${AUTO_APPROVE[@]}"

IP="$(terraform output -raw server_ipv4)"
"${ROOT}/deploy/scripts/cloudflare_set_subdomain_a.sh" "${IP}"

echo >&2
echo "SSH:" >&2
if KEY_OUT="$("${ROOT}/deploy/scripts/hetzner_ssh_identity.sh" 2>/dev/null)"; then
  echo "  ssh -i ${KEY_OUT} root@${IP}" >&2
else
  echo "  ssh root@${IP}" >&2
fi
