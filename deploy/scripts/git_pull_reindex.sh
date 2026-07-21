#!/usr/bin/env bash
set -euo pipefail
# Locked merge + runtime deployment (Compose, nginx, gateway) + indexer when advancing main.

REPO="${FEEDBACK_REPO_ROOT:?export FEEDBACK_REPO_ROOT=/srv/feedback.vrchat.com first}"
LOCK="${GIT_REINDEX_LOCK:-/run/lock/feedback-git-reindex.lock}"

PYTHON="${PYTHON:-python3}"

exec flock -w 10 "${LOCK}" "${PYTHON}" "${REPO}/scripts/run_reindex_maybe.py"
