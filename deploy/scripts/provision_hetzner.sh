#!/usr/bin/env bash
# First-time Hetzner provision (Terraform). Expects HCLOUD_TOKEN in the environment.
# Optionally pass -y to use terraform apply -auto-approve.
#
# Repo root (parent of deploy/):
#   export HCLOUD_TOKEN='...'
#   deploy/scripts/provision_hetzner.sh
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

cd "${TF_DIR}"
terraform init -input=false
terraform apply -input=false "${AUTO_APPROVE[@]}"

IP="$(terraform output -raw server_ipv4)"
echo >&2
echo "SSH:" >&2
if KEY_OUT="$("${ROOT}/deploy/scripts/hetzner_ssh_identity.sh" 2>/dev/null)"; then
  echo "  ssh -i ${KEY_OUT} root@${IP}" >&2
else
  echo "  ssh root@${IP}  # use -i path after setting HETZNER_SSH_PRIVATE_KEY or ${TF_DIR}/.ssh/hetzner_admin" >&2
fi
