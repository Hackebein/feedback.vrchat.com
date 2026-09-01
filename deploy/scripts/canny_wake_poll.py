#!/usr/bin/env python3
"""Long-running Canny host daemon: notify/new-post wake + paced upvotes.

Intervals (env-overridable):
  - every CANNY_WAKE_POLL_SECS (default 30): notifications + newest-post check;
    repository_dispatch canny-wake when something new appears
  - every CANNY_WAKE_VOTE_SECS (default 65): upvote up to CANNY_WAKE_VOTE_BATCH
    (default 10) most-active unscored posts; stop the cycle on HTTP 429

Replaces the former oneshot systemd timer.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
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
POLL_SECS = float(os.environ.get("CANNY_WAKE_POLL_SECS") or "30")
VOTE_SECS = float(os.environ.get("CANNY_WAKE_VOTE_SECS") or "65")
VOTE_BATCH = int(os.environ.get("CANNY_WAKE_VOTE_BATCH") or "10")
VOTE_GAP_SECS = float(os.environ.get("CANNY_WAKE_VOTE_GAP_SECS") or "1")
SSO_BACKOFF_SECS = float(os.environ.get("CANNY_SSO_BACKOFF_SECS") or "900")
_sso_blocked_until = 0.0
DEFAULT_REPO = "Hackebein/feedback.vrchat.com"
CANNY_HOST = "feedback.vrchat.com"
API_URL = f"https://{CANNY_HOST}/api/posts/get"
USER_AGENT = canny_auth.USER_AGENT
NOTIFY_PAGES = int(os.environ.get("CANNY_WAKE_NOTIFY_PAGES") or "10")
NEWEST_PAGES = int(os.environ.get("CANNY_WAKE_NEWEST_PAGES") or "50")

_STOP = False


def _on_signal(signum: int, _frame: Any) -> None:
    global _STOP
    print(f"canny-wake: signal {signum}; stopping", file=sys.stderr, flush=True)
    _STOP = True


def _ensure_cookie_jar_env() -> None:
    """Persist VRChat/Canny cookies across ticks (avoids session exhaustion)."""
    if (os.environ.get("CANNY_COOKIE_JAR") or "").strip():
        return
    path = Path(DEFAULT_COOKIE_JAR)
    path.parent.mkdir(parents=True, exist_ok=True)
    os.environ["CANNY_COOKIE_JAR"] = str(path)


def load_state(path: Path) -> dict[str, Any]:
    empty = {
        "seenNotificationIds": [],
        "dispatchedPostIds": [],
        "votedPostIds": [],
        "lastDispatchAt": 0.0,
    }
    if not path.is_file():
        return dict(empty)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(empty)
    if not isinstance(data, dict):
        return dict(empty)
    seen = data.get("seenNotificationIds") or []
    dispatched = data.get("dispatchedPostIds") or []
    voted = data.get("votedPostIds") or []
    try:
        last = float(data.get("lastDispatchAt") or 0.0)
    except (TypeError, ValueError):
        last = 0.0
    return {
        "seenNotificationIds": [str(x) for x in seen if x][-5000:],
        "dispatchedPostIds": [str(x) for x in dispatched if x][-5000:],
        "votedPostIds": [str(x) for x in voted if x],
        "lastDispatchAt": last,
    }


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "seenNotificationIds": list(state.get("seenNotificationIds") or [])[-5000:],
        "dispatchedPostIds": list(state.get("dispatchedPostIds") or [])[-5000:],
        "votedPostIds": sorted(set(state.get("votedPostIds") or [])),
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


def _parse_activity_dt(v: Any) -> datetime | None:
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        return datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def _post_last_activity_dt(post: dict[str, Any]) -> datetime | None:
    candidates: list[datetime] = []
    for key in ("created", "statusChanged"):
        dt = _parse_activity_dt(post.get(key))
        if dt is not None:
            candidates.append(dt)
    for c in post.get("comments") or []:
        if not isinstance(c, dict) or c.get("deleted") is True or c.get("spam") is True:
            continue
        dt = _parse_activity_dt(c.get("created"))
        if dt is not None:
            candidates.append(dt)
    return max(candidates) if candidates else None


def _pending_vote_ids(voted: set[str], limit: int) -> list[str]:
    """Most-active unscored posts first (same signal as update.py --refresh-newest)."""
    items: list[tuple[str, dict[str, Any]]] = []
    for slug in board_store.board_slugs():
        for post in board_store.iter_board_posts(slug):
            if not isinstance(post, dict):
                continue
            pid = post.get("_id")
            if not isinstance(pid, str) or not pid or pid in voted:
                continue
            items.append((pid, post))

    def key(item: tuple[str, dict[str, Any]]) -> tuple[int, float, str]:
        pid, post = item
        dt = _post_last_activity_dt(post)
        if dt is None:
            return (1, 0.0, pid)
        return (0, -dt.timestamp(), pid)

    items.sort(key=key)
    return [pid for pid, _ in items[: max(0, limit)]]


def ensure_session(session: canny_auth.CannySession | None) -> canny_auth.CannySession:
    global _sso_blocked_until
    if session is not None:
        return session
    now = time.time()
    if now < _sso_blocked_until:
        remaining = int(_sso_blocked_until - now)
        raise canny_auth.CannyAuthError(f"SSO backoff ({remaining}s remaining)")
    try:
        return canny_auth.login_canny_session()
    except canny_auth.CannyAuthError:
        _sso_blocked_until = time.time() + SSO_BACKOFF_SECS
        raise


def poll_once(state: dict[str, Any], session: canny_auth.CannySession | None) -> canny_auth.CannySession | None:
    """Notifications + newest-post check; dispatch canny-wake when needed."""
    stored = board_store.existing_post_ids()
    pending = set(state.get("dispatchedPostIds") or [])
    pending = {pid for pid in pending if pid not in stored}
    state["dispatchedPostIds"] = sorted(pending)

    unknown_posts = find_unknown_post_ids(stored, pending)
    print(
        f"canny-wake: poll boards={len(board_store.board_slugs())} "
        f"stored={len(stored)} unknown_posts={len(unknown_posts)}",
        file=sys.stderr,
        flush=True,
    )

    try:
        session = ensure_session(session)
    except canny_auth.CannyAuthError as e:
        print(f"canny-wake: SSO failed: {e}", file=sys.stderr, flush=True)
        return None

    try:
        notes = canny_auth.fetch_notifications(session, pages=NOTIFY_PAGES)
    except Exception as e:
        print(f"canny-wake: notifications failed: {e}", file=sys.stderr, flush=True)
        return None

    note_ids = notification_ids(notes)
    seen_notes = set(state.get("seenNotificationIds") or [])
    new_notes = [nid for nid in note_ids if nid not in seen_notes]
    print(
        f"canny-wake: notifications={len(notes)} new={len(new_notes)}",
        file=sys.stderr,
        flush=True,
    )

    if not unknown_posts and not new_notes:
        save_state(STATE_PATH, state)
        return session

    now = time.time()
    last = float(state.get("lastDispatchAt") or 0.0)
    if now - last < DEBOUNCE_SECS:
        print(
            f"canny-wake: dispatch debounced ({now - last:.0f}s < {DEBOUNCE_SECS}s)",
            file=sys.stderr,
            flush=True,
        )
        return session

    token = (
        os.environ.get("GH_DISPATCH_TOKEN") or os.environ.get("GH_ISSUE_TOKEN") or ""
    ).strip()
    repo = (os.environ.get("GH_DISPATCH_REPO") or DEFAULT_REPO).strip()
    if not token:
        print("canny-wake: GH_DISPATCH_TOKEN/GH_ISSUE_TOKEN missing", file=sys.stderr, flush=True)
        return session

    try:
        dispatch_canny_wake(token, repo)
    except Exception as e:
        print(f"canny-wake: dispatch failed: {e}", file=sys.stderr, flush=True)
        return session

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
        flush=True,
    )
    return session


def vote_once(state: dict[str, Any], session: canny_auth.CannySession | None) -> canny_auth.CannySession | None:
    """Upvote up to VOTE_BATCH posts; skip rest of cycle on 429."""
    if VOTE_BATCH <= 0:
        return session

    try:
        session = ensure_session(session)
    except canny_auth.CannyAuthError as e:
        print(f"canny-wake: vote SSO failed: {e}", file=sys.stderr, flush=True)
        return None

    voted = set(state.get("votedPostIds") or [])
    batch = _pending_vote_ids(voted, VOTE_BATCH)
    if not batch:
        print("canny-wake: vote backlog empty", file=sys.stderr, flush=True)
        return session

    ok = 0
    skipped = 0
    rate_limited = False
    for i, pid in enumerate(batch):
        if _STOP:
            break
        result = canny_auth.vote_post(session, pid, score=1)
        if result.ok:
            voted.add(pid)
            ok += 1
        elif result.rate_limited:
            rate_limited = True
            print(
                f"canny-wake: vote 429; skipping rest of cycle "
                f"(ok={ok}/{len(batch)})",
                file=sys.stderr,
                flush=True,
            )
            break
        elif result.forbidden:
            # Private/restricted board — record so it does not block the backlog.
            voted.add(pid)
            skipped += 1
            print(
                f"canny-wake: vote forbidden {pid}; marking tracked",
                file=sys.stderr,
                flush=True,
            )
        else:
            print(f"canny-wake: vote failed {pid}; continuing", file=sys.stderr, flush=True)
        if i + 1 < len(batch) and not rate_limited and VOTE_GAP_SECS > 0:
            time.sleep(VOTE_GAP_SECS)

    state["votedPostIds"] = sorted(voted)
    save_state(STATE_PATH, state)
    notes = []
    if skipped:
        notes.append(f"skipped {skipped} forbidden")
    if rate_limited:
        notes.append("rate-limited")
    note = f"; {'; '.join(notes)}" if notes else ""
    print(
        f"canny-wake: upvoted {ok}/{len(batch)} "
        f"(total tracked {len(voted)}){note}",
        file=sys.stderr,
        flush=True,
    )
    return session


def run_daemon() -> int:
    _ensure_cookie_jar_env()
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    state = load_state(STATE_PATH)
    session: canny_auth.CannySession | None = None
    print(
        f"canny-wake: daemon start poll={POLL_SECS}s vote={VOTE_SECS}s "
        f"batch={VOTE_BATCH} voted={len(state.get('votedPostIds') or [])}",
        file=sys.stderr,
        flush=True,
    )

    # Run both ticks immediately, then on their intervals.
    last_poll = 0.0
    last_vote = 0.0

    while not _STOP:
        now = time.monotonic()
        if now - last_poll >= POLL_SECS:
            try:
                session = poll_once(state, session)
            except Exception as e:
                print(f"canny-wake: poll error: {e}", file=sys.stderr, flush=True)
                session = None
            last_poll = time.monotonic()
            state = load_state(STATE_PATH)

        if _STOP:
            break

        now = time.monotonic()
        if now - last_vote >= VOTE_SECS:
            try:
                # Reload state in case poll_once persisted changes.
                state = load_state(STATE_PATH)
                session = vote_once(state, session)
            except Exception as e:
                print(f"canny-wake: vote error: {e}", file=sys.stderr, flush=True)
                session = None
            last_vote = time.monotonic()

        if _STOP:
            break

        now = time.monotonic()
        next_poll = last_poll + POLL_SECS - now
        next_vote = last_vote + VOTE_SECS - now
        sleep_for = min(next_poll, next_vote, 1.0)
        if sleep_for > 0:
            time.sleep(sleep_for)

    save_state(STATE_PATH, state)
    print("canny-wake: stopped", file=sys.stderr, flush=True)
    return 0


def main() -> int:
    # One-shot mode for manual debugging: CANNY_WAKE_ONCE=1
    if (os.environ.get("CANNY_WAKE_ONCE") or "").strip() in ("1", "true", "yes"):
        _ensure_cookie_jar_env()
        state = load_state(STATE_PATH)
        session = poll_once(state, None)
        state = load_state(STATE_PATH)
        vote_once(state, session)
        return 0
    return run_daemon()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"canny-wake: {e}", file=sys.stderr)
        raise SystemExit(1)
