#!/usr/bin/env python3
"""Poll Canny notifications + newest posts; wake Actions via repository_dispatch.

Runs on the indexer host (systemd timer). Replaces the Postfix email wake-up.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import board_store  # noqa: E402
import canny_auth  # noqa: E402

STATE_PATH = Path(
    os.environ.get("CANNY_WAKE_STATE") or "/var/lib/feedback-search/canny-wake-state.json"
)
DEFAULT_COOKIE_JAR = "/var/lib/feedback-search/canny-cookies.jar"
DEBOUNCE_SECS = int(os.environ.get("CANNY_WAKE_DEBOUNCE_SECS") or "60")
DEFAULT_REPO = "Hackebein/feedback.vrchat.com"
CANNY_HOST = "feedback.vrchat.com"
API_URL = f"https://{CANNY_HOST}/api/posts/get"
USER_AGENT = canny_auth.USER_AGENT
NOTIFY_PAGES = int(os.environ.get("CANNY_WAKE_NOTIFY_PAGES") or "10")
NEWEST_PAGES = int(os.environ.get("CANNY_WAKE_NEWEST_PAGES") or "50")


def _ensure_cookie_jar_env() -> None:
    """Persist VRChat/Canny cookies across wake ticks (avoids session exhaustion)."""
    if (os.environ.get("CANNY_COOKIE_JAR") or "").strip():
        return
    path = Path(DEFAULT_COOKIE_JAR)
    path.parent.mkdir(parents=True, exist_ok=True)
    os.environ["CANNY_COOKIE_JAR"] = str(path)


def load_state(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {
            "seenNotificationIds": [],
            "dispatchedPostIds": [],
            "lastDispatchAt": 0.0,
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "seenNotificationIds": [],
            "dispatchedPostIds": [],
            "lastDispatchAt": 0.0,
        }
    if not isinstance(data, dict):
        return {
            "seenNotificationIds": [],
            "dispatchedPostIds": [],
            "lastDispatchAt": 0.0,
        }
    seen = data.get("seenNotificationIds") or []
    dispatched = data.get("dispatchedPostIds") or []
    try:
        last = float(data.get("lastDispatchAt") or 0.0)
    except (TypeError, ValueError):
        last = 0.0
    return {
        "seenNotificationIds": [str(x) for x in seen if x][-5000:],
        "dispatchedPostIds": [str(x) for x in dispatched if x][-5000:],
        "lastDispatchAt": last,
    }


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "seenNotificationIds": list(state.get("seenNotificationIds") or [])[-5000:],
        "dispatchedPostIds": list(state.get("dispatchedPostIds") or [])[-5000:],
        "lastDispatchAt": float(state.get("lastDispatchAt") or 0.0),
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def notification_ids(notes: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for n in notes:
        nid = n.get("_id") or n.get("id")
        if isinstance(nid, str) and nid.strip() and nid not in seen:
            seen.add(nid)
            out.append(nid)
    return out


def fetch_newest_post_ids(board_slug: str, pages: int = NEWEST_PAGES) -> list[str]:
    body = {
        "__canny_requestID": f"canny-wake-{board_slug}-newest",
        "__host": CANNY_HOST,
        "boardURLNames": [board_slug],
        "currentBoard": board_slug,
        "pages": pages,
        "sort": "newest",
        "status": "",
    }
    try:
        r = subprocess.run(
            [
                "curl",
                "-sS",
                "-X",
                "POST",
                API_URL,
                "-H",
                "Content-Type: application/json",
                "-H",
                f"User-Agent: {USER_AGENT}",
                "--data-binary",
                json.dumps(body),
                "-m",
                "15",
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"canny-wake: newest fetch {board_slug} failed: {e}", file=sys.stderr)
        return []
    if not (r.stdout or "").strip():
        print(f"canny-wake: newest fetch {board_slug} empty response", file=sys.stderr)
        return []
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        print(f"canny-wake: newest fetch {board_slug} parse error: {e}", file=sys.stderr)
        return []
    result = data.get("result") or {}
    posts = result.get("posts") or []
    out: list[str] = []
    seen: set[str] = set()
    for p in posts:
        if not isinstance(p, dict):
            continue
        pid = p.get("_id")
        if isinstance(pid, str) and pid and pid not in seen:
            seen.add(pid)
            out.append(pid)
    return out


def find_unknown_post_ids(stored: set[str], pending: set[str]) -> list[str]:
    unknown: list[str] = []
    seen: set[str] = set()
    for slug in board_store.board_slugs():
        for pid in fetch_newest_post_ids(slug):
            if pid in stored or pid in pending or pid in seen:
                continue
            seen.add(pid)
            unknown.append(pid)
    return unknown


def dispatch_canny_wake(token: str, repo: str) -> None:
    url = f"https://api.github.com/repos/{repo}/dispatches"
    body = json.dumps({"event_type": "canny-wake"}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "feedback-canny-wake-poll",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status not in (204, 200):
                raise RuntimeError(f"dispatch HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"dispatch HTTP {e.code}: {detail}") from e


def main() -> int:
    _ensure_cookie_jar_env()
    state = load_state(STATE_PATH)
    stored = board_store.existing_post_ids()
    pending = set(state.get("dispatchedPostIds") or [])
    # Drop post IDs that ingest has already pulled into boards/.
    pending = {pid for pid in pending if pid not in stored}
    state["dispatchedPostIds"] = sorted(pending)

    unknown_posts = find_unknown_post_ids(stored, pending)
    print(
        f"canny-wake: boards={len(board_store.board_slugs())} "
        f"stored={len(stored)} unknown_posts={len(unknown_posts)}",
        file=sys.stderr,
    )

    try:
        session = canny_auth.login_canny_session()
    except canny_auth.CannyAuthError as e:
        print(f"canny-wake: SSO failed: {e}", file=sys.stderr)
        return 2

    notes = canny_auth.fetch_notifications(session, pages=NOTIFY_PAGES)
    note_ids = notification_ids(notes)
    seen_notes = set(state.get("seenNotificationIds") or [])
    new_notes = [nid for nid in note_ids if nid not in seen_notes]
    print(
        f"canny-wake: notifications={len(notes)} new={len(new_notes)}",
        file=sys.stderr,
    )

    if not unknown_posts and not new_notes:
        save_state(STATE_PATH, state)
        print("canny-wake: no wake needed", file=sys.stderr)
        return 0

    now = time.time()
    last = float(state.get("lastDispatchAt") or 0.0)
    if now - last < DEBOUNCE_SECS:
        print(
            f"canny-wake: dispatch debounced ({now - last:.0f}s < {DEBOUNCE_SECS}s)",
            file=sys.stderr,
        )
        return 0

    token = (
        os.environ.get("GH_DISPATCH_TOKEN") or os.environ.get("GH_ISSUE_TOKEN") or ""
    ).strip()
    repo = (os.environ.get("GH_DISPATCH_REPO") or DEFAULT_REPO).strip()
    if not token:
        print("canny-wake: GH_DISPATCH_TOKEN/GH_ISSUE_TOKEN missing", file=sys.stderr)
        return 2

    dispatch_canny_wake(token, repo)
    seen_notes.update(new_notes)
    pending.update(unknown_posts)
    state["seenNotificationIds"] = list(seen_notes)[-5000:]
    state["dispatchedPostIds"] = sorted(pending)[-5000:]
    state["lastDispatchAt"] = now
    save_state(STATE_PATH, state)
    print(
        f"canny-wake: dispatched canny-wake "
        f"(new_notes={len(new_notes)} unknown_posts={len(unknown_posts)})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"canny-wake: {e}", file=sys.stderr)
        raise SystemExit(1)
