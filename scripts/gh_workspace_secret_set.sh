#!/usr/bin/env bash
# Set a Codespaces secret on the GitHub repo for this checkout (same repo only).
#
# Depends: gh (authenticated: gh auth login), run inside the repo clone.
#
# Typical (same-repo Codespaces secrets):
#   scripts/gh_workspace_secret_set.sh HCLOUD_TOKEN --body-env HCLOUD_TOKEN
#   scripts/gh_workspace_secret_set.sh CF_API_TOKEN --body-env CF_API_TOKEN
# PEM in env is awkward; prefer: scripts/gh_workspace_secret_set.sh HETZNER_SSH_PRIVATE_KEY --body-file path/to/id_ed25519
#
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  gh_workspace_secret_set.sh <SECRET_NAME> [--body-env VAR | --body-file PATH]

  Always updates the repository Codespaces secret for the current gh repo (--app codespaces).

Secret value (pick one):
  --body-env VAR    Read value from exported shell variable VAR (recommended).
  --body-file PATH  Read entire file contents as the secret value.
  If stdin is not a TTY, stdin is the value (no other secret flags).
  If stdin is a TTY and neither flag above, gh prompts interactively.

Examples:
  scripts/gh_workspace_secret_set.sh HCLOUD_TOKEN --body-env HCLOUD_TOKEN
  scripts/gh_workspace_secret_set.sh CF_API_TOKEN --body-env CF_API_TOKEN
  scripts/gh_workspace_secret_set.sh HETZNER_SSH_PRIVATE_KEY --body-file ~/.ssh/id_ed25519
EOF
}

die() {
  printf '%s\n' "error: $*" >&2
  exit 1
}

if [[ "$#" -lt 1 ]] || [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then
  usage
  [[ "$#" -lt 1 ]] && exit 1 || exit 0
fi

SECRET_NAME="$1"
shift
[[ -n "$SECRET_NAME" ]] || die "secret name must be non-empty"

BODY_ENV_NAME=""
BODY_FILE=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --body-env)
      [[ "${2-}" ]] || die "--body-env requires VAR"
      BODY_ENV_NAME="$2"
      shift 2
      ;;
    --body-file)
      [[ "${2-}" ]] || die "--body-file requires PATH"
      BODY_FILE="$2"
      shift 2
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

BODY_SOURCES=0
[[ -n "$BODY_ENV_NAME" ]] && BODY_SOURCES=$((BODY_SOURCES + 1))
[[ -n "$BODY_FILE" ]] && BODY_SOURCES=$((BODY_SOURCES + 1))
stdin_used=0
# Stdin as body only when neither explicit flag was passed (non-TTY alone must not conflict with --body-env).
if [[ -z "$BODY_ENV_NAME" ]] && [[ -z "$BODY_FILE" ]] && [[ ! -t 0 ]]; then
  stdin_used=1
fi
[[ "$stdin_used" -eq 1 ]] && BODY_SOURCES=$((BODY_SOURCES + 1))
[[ "$BODY_SOURCES" -gt 1 ]] && die "pick only one value source (--body-env / --body-file / stdin)"

if [[ -n "$BODY_ENV_NAME" ]]; then
  if [[ ! "$BODY_ENV_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    die "--body-env name must match ^[A-Za-z_][A-Za-z0-9_]*$"
  fi
  v="${!BODY_ENV_NAME}"
  [[ -n "$v" ]] || die "environment variable ${BODY_ENV_NAME} is unset or empty"
  exec gh secret set "$SECRET_NAME" --app codespaces --body "$v"
fi

if [[ -n "$BODY_FILE" ]]; then
  [[ -f "$BODY_FILE" ]] || die "--body-file does not exist: $BODY_FILE"
  exec gh secret set "$SECRET_NAME" --app codespaces <"$BODY_FILE"
fi

if [[ "$stdin_used" -eq 1 ]]; then
  exec gh secret set "$SECRET_NAME" --app codespaces
fi

exec gh secret set "$SECRET_NAME" --app codespaces
