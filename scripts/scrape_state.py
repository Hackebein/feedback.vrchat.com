#!/usr/bin/env python3
"""Load/save scrape bookkeeping from the scrape-state worktree/branch."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STATE_DIR = ROOT / ".scrape-state"
STATE_FILENAME = "scrape-state.json"
SCRAPER_USER_ID_FILE = ROOT / "scraper_user_id"


def state_dir() -> Path:
    raw = (os.environ.get("SCRAPE_STATE_DIR") or "").strip()
    return Path(raw) if raw else DEFAULT_STATE_DIR


def state_path() -> Path:
    return state_dir() / STATE_FILENAME


def empty_state() -> dict[str, Any]:
    return {
        "scrapedAt": {},
        "votedPostIds": [],
        "scraperUserId": None,
        "seenNotificationIds": [],
    }


def load_state() -> dict[str, Any]:
    path = state_path()
    if not path.is_file():
        return empty_state()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty_state()
    if not isinstance(data, dict):
        return empty_state()
    out = empty_state()
    scraped = data.get("scrapedAt") or {}
    if isinstance(scraped, dict):
        out["scrapedAt"] = {str(k): str(v) for k, v in scraped.items() if k and v}
    voted = data.get("votedPostIds") or []
    if isinstance(voted, list):
        out["votedPostIds"] = [str(x) for x in voted if x]
    uid = data.get("scraperUserId")
    if isinstance(uid, str) and uid.strip():
        out["scraperUserId"] = uid.strip()
    seen = data.get("seenNotificationIds") or []
    if isinstance(seen, list):
        out["seenNotificationIds"] = [str(x) for x in seen if x][-5000:]
    return out


def save_state(state: dict[str, Any]) -> None:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "scrapedAt": state.get("scrapedAt") or {},
        "votedPostIds": sorted(set(state.get("votedPostIds") or [])),
        "scraperUserId": state.get("scraperUserId"),
        "seenNotificationIds": list(state.get("seenNotificationIds") or [])[-5000:],
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
    uid = payload.get("scraperUserId")
    if isinstance(uid, str) and uid.strip():
        SCRAPER_USER_ID_FILE.write_text(uid.strip() + "\n", encoding="utf-8")


def read_scraper_user_id() -> str | None:
    """Prefer scrape-state, then committed one-line file for ingest/notify."""
    st = load_state()
    uid = st.get("scraperUserId")
    if isinstance(uid, str) and uid.strip():
        return uid.strip()
    if SCRAPER_USER_ID_FILE.is_file():
        line = SCRAPER_USER_ID_FILE.read_text(encoding="utf-8").strip().splitlines()
        if line and line[0].strip():
            return line[0].strip()
    env = (os.environ.get("SCRAPER_CANNY_USER_ID") or "").strip()
    return env or None


def ensure_worktree() -> Path:
    """Ensure .scrape-state worktree exists tracking origin/scrape-state (or local)."""
    dest = state_dir()
    if (dest / STATE_FILENAME).is_file() or (dest / ".git").exists():
        return dest
    dest.mkdir(parents=True, exist_ok=True)
    # Try attach existing branch; ignore failures (caller may seed).
    subprocess.run(
        ["git", "-C", str(ROOT), "worktree", "add", "-f", str(dest), "scrape-state"],
        capture_output=True,
        text=True,
        check=False,
    )
    return dest


def migrate_scraped_at_from_boards(boards_root: Path | None = None) -> dict[str, Any]:
    """Seed scrapedAt from board JSON updatedAt fields."""
    import board_store  # local

    state = load_state()
    scraped = dict(state.get("scrapedAt") or {})
    root = boards_root or board_store.BOARD_DIR
    for slug in sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")):
        for path in sorted(root.joinpath(slug).glob("*.json")):
            if path.name.endswith(".json.tmp"):
                continue
            try:
                post = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            pid = post.get("_id")
            ua = post.get("updatedAt")
            if pid and ua and str(pid) not in scraped:
                scraped[str(pid)] = str(ua)
    state["scrapedAt"] = scraped
    return state
