#!/usr/bin/env python3
"""Helper used by git_pull_reindex.sh: sync main, optionally deploy runtime, optionally ingest."""
from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(os.environ.get("FEEDBACK_REPO_ROOT", Path(__file__).resolve().parents[1]))
REMOTE = os.environ.get("GIT_REMOTE_ORIGIN", "origin")
BRANCH = os.environ.get("FEEDBACK_GIT_BRANCH", "main")
STATE_DIR = Path(os.environ.get("FEEDBACK_STATE_DIR", "/var/lib/feedback-search"))
LAST_DEPLOYED = STATE_DIR / "last_deployed_sha"
LAST_INGESTED = STATE_DIR / "last_ingested_sha"


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


def read_state(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def write_state(path: Path, sha: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(sha + "\n", encoding="utf-8")


def sync_to_remote() -> tuple[str, str]:
    """Fetch and align the working tree with origin. Returns (previous_head, new_head)."""
    remote_ref = f"{REMOTE}/{BRANCH}"
    git(
        [
            "fetch",
            REMOTE,
            f"+refs/heads/{BRANCH}:refs/remotes/{REMOTE}/{BRANCH}",
            "--depth",
            "4096",
            "--prune",
            "--no-tags",
            "--quiet",
        ]
    )
    cur = git(["rev-parse", "HEAD"]).splitlines()[0]
    merge = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "merge", "--ff-only", remote_ref],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    if merge.returncode != 0:
        sys.stdout.write(merge.stdout)
        print(
            f"[warn] ff-only merge failed; resetting hard to {remote_ref}",
            flush=True,
            file=sys.stderr,
        )
        git(["reset", "--hard", remote_ref])
    new = git(["rev-parse", "HEAD"]).splitlines()[0]
    return cur, new


def changed_paths(base_sha: str, head_sha: str) -> list[str]:
    if not base_sha:
        return ["__initial__"]
    out = git(["diff", "--name-only", f"{base_sha}..{head_sha}"])
    return [line for line in out.splitlines() if line.strip()]


def path_requires_deploy(path: str) -> bool:
    if path == "README.md":
        return False
    if path.startswith("boards/"):
        return False
    return True


def needs_deploy(head_sha: str) -> bool:
    last = read_state(LAST_DEPLOYED)
    if not last or last != head_sha:
        for path in changed_paths(last, head_sha):
            if path_requires_deploy(path):
                return True
    return False


def needs_ingest(head_sha: str) -> bool:
    if os.environ.get("FORCE_REINDEX") == "1":
        return True
    last = read_state(LAST_INGESTED)
    return not last or last != head_sha


def apply_runtime_stack(repo_root: Path) -> None:
    script = repo_root / "deploy/scripts/sync_runtime_stack.sh"
    subprocess.run(["/bin/bash", str(script)], check=True)


def open_build_failure_issue(exc: subprocess.CalledProcessError, head_sha: str) -> None:
    script = REPO_ROOT / "deploy/scripts/open_github_issue.sh"
    if not script.is_file():
        return
    body = (
        f"UI deploy (`sync_runtime_stack.sh`) failed at {datetime.now(timezone.utc).isoformat()}\n"
        f"exit code: {exc.returncode}\n"
        f"git HEAD: {head_sha}\n"
    )
    subprocess.run(
        [
            "/bin/bash",
            str(script),
            "build-failure",
            f"sync_runtime_stack failed (exit {exc.returncode})",
            "-",
        ],
        input=body,
        text=True,
        check=False,
    )


def run_ingest(head_sha: str) -> int:
    print(f"Ingest via opensearch_bulk.py (@{head_sha[:12]})", flush=True)
    rc = subprocess.call(
        [sys.executable, str(REPO_ROOT / "scripts/opensearch_bulk.py"), *sys.argv[1:]]
    )
    if rc == 0:
        write_state(LAST_INGESTED, head_sha)
    return rc


def main() -> int:
    _cur, new = sync_to_remote()
    want_deploy = needs_deploy(new)
    want_ingest = needs_ingest(new)

    if not want_deploy and not want_ingest:
        print(f"Already deployed+ingested @{new[:12]}; skipping.", flush=True)
        return 0

    if want_deploy:
        print(f"Deploy runtime stack (@{new[:12]})", flush=True)
        try:
            apply_runtime_stack(REPO_ROOT)
            write_state(LAST_DEPLOYED, new)
        except subprocess.CalledProcessError as e:
            print(
                f"[warn] apply_runtime_stack failed (exit {e.returncode}); proceeding with ingest",
                flush=True,
                file=sys.stderr,
            )
            open_build_failure_issue(e, new)

    if not want_ingest:
        return 0

    return run_ingest(new)


if __name__ == "__main__":
    sys.exit(main())
