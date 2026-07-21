#!/usr/bin/env python3
"""Postfix pipe hook for canny@vrchat-canny.hackebein.dev.

- Canny mail (From/Sender @canny.io) → debounced repository_dispatch canny-email
- Everything else → save under /var/lib/feedback-search/mail-drop/
"""

from __future__ import annotations

import email
import email.policy
import json
import os
import sys
import time
import urllib.error
import urllib.request
from email.utils import parseaddr
from pathlib import Path

MAIL_ENV = Path("/etc/feedback-search/mail.env")
DEBOUNCE_PATH = Path("/var/lib/feedback-search/canny-mail-dispatch.ts")
MAIL_DROP = Path("/var/lib/feedback-search/mail-drop")
DEBOUNCE_SECS = 60
DEFAULT_REPO = "Hackebein/feedback.vrchat.com"


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def addr_domain(header_val: str | None) -> str:
    if not header_val:
        return ""
    _, addr = parseaddr(header_val)
    if "@" not in addr:
        return ""
    return addr.rsplit("@", 1)[-1].lower()


def is_canny_mail(msg: email.message.Message) -> bool:
    for key in ("From", "Sender"):
        dom = addr_domain(msg.get(key))
        if dom == "canny.io" or dom.endswith(".canny.io"):
            return True
    return False


def debounced_ok(path: Path, window: int) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    now = time.time()
    try:
        prev = float(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        prev = 0.0
    if now - prev < window:
        return False
    path.write_text(f"{now:.3f}\n", encoding="utf-8")
    return True


def dispatch_canny_email(token: str, repo: str) -> None:
    url = f"https://api.github.com/repos/{repo}/dispatches"
    body = json.dumps({"event_type": "canny-email"}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "feedback-canny-mail-hook",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status not in (204, 200):
                raise RuntimeError(f"dispatch HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"dispatch HTTP {e.code}: {detail}") from e


def save_mail_drop(raw: bytes) -> Path:
    MAIL_DROP.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    path = MAIL_DROP / f"{stamp}.eml"
    path.write_bytes(raw)
    return path


def main() -> int:
    env = load_env(MAIL_ENV)
    for k, v in os.environ.items():
        if k.startswith(("GH_", "MAIL_", "GITHUB_")) and v:
            env.setdefault(k, v)

    raw = sys.stdin.buffer.read()
    if not raw:
        print("canny-mail-hook: empty message", file=sys.stderr)
        return 0

    msg = email.message_from_bytes(raw, policy=email.policy.default)

    if is_canny_mail(msg):
        token = (env.get("GH_DISPATCH_TOKEN") or "").strip()
        repo = (env.get("GH_DISPATCH_REPO") or DEFAULT_REPO).strip()
        if not token:
            print("canny-mail-hook: GH_DISPATCH_TOKEN missing; skip dispatch", file=sys.stderr)
            return 0
        if not debounced_ok(DEBOUNCE_PATH, DEBOUNCE_SECS):
            print("canny-mail-hook: dispatch debounced", file=sys.stderr)
            return 0
        dispatch_canny_email(token, repo)
        print("canny-mail-hook: dispatched canny-email", file=sys.stderr)
        return 0

    path = save_mail_drop(raw)
    print(f"canny-mail-hook: saved non-Canny mail to {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"canny-mail-hook: {e}", file=sys.stderr)
        # Exit 0 so Postfix does not bounce/retry forever on app bugs;
        # ops can inspect journal/mail-drop.
        raise SystemExit(0)
