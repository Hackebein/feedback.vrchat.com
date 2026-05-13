#!/usr/bin/env python3
"""Helper used by git_pull_reindex.sh: merge --ff-only when remote advanced, refresh runtime stack, then ingest."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(os.environ.get("FEEDBACK_REPO_ROOT", Path(__file__).resolve().parents[1]))
REMOTE = os.environ.get("GIT_REMOTE_ORIGIN", "origin")
BRANCH = os.environ.get("FEEDBACK_GIT_BRANCH", "main")


def apply_runtime_stack(repo_root: Path) -> None:
    script = repo_root / "deploy/scripts/sync_runtime_stack.sh"
    subprocess.run(["/bin/bash", str(script)], check=True)


def git(args: list[str]) -> str:
    p = subprocess.run(
        ["git", "-C", str(REPO_ROOT), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    sys.stdout.write(p.stdout)
    if p.returncode != 0:
        sys.exit(p.returncode)
    return p.stdout.strip()


def main() -> int:
    git(["fetch", REMOTE, f"+refs/heads/{BRANCH}:refs/remotes/{REMOTE}/{BRANCH}", "--depth", "4096", "--prune", "--no-tags", "--quiet"])
    cur = git(["rev-parse", "HEAD"]).splitlines()[0]
    subprocess.run(["git", "-C", str(REPO_ROOT), "merge", "--ff-only", f"{REMOTE}/{BRANCH}"], check=True)
    new = git(["rev-parse", "HEAD"]).splitlines()[0]
    force = os.environ.get("FORCE_REINDEX") == "1"
    if cur == new and not force:
        print(f"No advance on {REMOTE}/{BRANCH}; skipping ingest.", flush=True)
        return 0
    apply_runtime_stack(REPO_ROOT)
    print(f"Ingest via opensearch_bulk.py (@{new[:12]})", flush=True)
    return subprocess.call([sys.executable, str(REPO_ROOT / "scripts/opensearch_bulk.py"), *sys.argv[1:]])


if __name__ == "__main__":
    sys.exit(main())
