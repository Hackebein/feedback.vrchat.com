#!/usr/bin/env bash
set -euo pipefail
# systemd/cron glue: guarded `git merge --ff-only`, runtime refresh (compose/openapi/nginx), then ingest.

REPO="${FEEDBACK_REPO_ROOT:?export FEEDBACK_REPO_ROOT=/srv/feedback.vrchat.com first}"
LOCK="${GIT_REINDEX_LOCK:-/run/lock/feedback-git-reindex.lock}"

PYTHON="${PYTHON:-python3}"

exec flock -w 10 "${LOCK}" "${PYTHON}" "${REPO}/scripts/run_reindex_maybe.py"
