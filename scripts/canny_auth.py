#!/usr/bin/env python3
"""VRChat login + SSO into feedback.vrchat.com (Canny)."""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import pyotp
except ImportError:  # pragma: no cover
    pyotp = None  # type: ignore

VRCHAT_API = "https://api.vrchat.cloud/api/1"
CANNY_HOST = "feedback.vrchat.com"
SSO_URL = (
    "https://vrchat.com/home/sso/canny"
    "?companyID=58c62e995865713647a7115d"
    "&redirect=https://feedback.vrchat.com/"
)
# VRChat WAF rejects generic bots without app/contact identity.
USER_AGENT = (
    "VRChatFeedbackArchiver/1.0 "
    "(+https://github.com/Hackebein/feedback.vrchat.com; canny-scraper@hackebein.dev)"
)


class CannyAuthError(RuntimeError):
    pass


@dataclass
class CannySession:
    cookie_jar: Path
    scraper_user_id: str | None
    viewer: dict[str, Any] | None
    csrf_token: str | None = None


def _require_env(name: str) -> str:
    val = (os.environ.get(name) or "").strip()
    if not val:
        raise CannyAuthError(f"missing required env {name}")
    return val


def _totp_code(secret: str) -> str:
    if pyotp is None:
        raise CannyAuthError("pyotp is required for VRCHAT_TOTP_SECRET")
    secret = secret.strip().replace(" ", "").upper()
    if "OTPAUTH://" in secret or secret.startswith("OTPAUTH:"):
        raise CannyAuthError(
            "VRCHAT_TOTP_SECRET must be the raw base32 secret, not an otpauth URI"
        )
    return pyotp.TOTP(secret).now()


def _curl(
    url: str,
    *,
    method: str = "GET",
    headers: list[str] | None = None,
    data: str | None = None,
    cookie_jar: Path | None = None,
    follow: bool = False,
    timeout: int = 30,
) -> tuple[int, str, str]:
    """Run curl; return (http_code, body, response_headers)."""
    with tempfile.NamedTemporaryFile(prefix="curl-body-", delete=False) as bf:
        body_path = Path(bf.name)
    with tempfile.NamedTemporaryFile(prefix="curl-hdr-", delete=False) as hf:
        hdr_path = Path(hf.name)
    try:
        cmd = [
            "curl", "-sS", "-X", method, url,
            "-D", str(hdr_path),
            "-o", str(body_path),
            "-w", "%{http_code}",
            "-H", f"User-Agent: {USER_AGENT}",
            "-m", str(timeout),
        ]
        if follow:
            cmd.append("-L")
        if cookie_jar is not None:
            cookie_jar.parent.mkdir(parents=True, exist_ok=True)
            if not cookie_jar.is_file():
                cookie_jar.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
            cmd.extend(["-c", str(cookie_jar), "-b", str(cookie_jar)])
        for h in headers or []:
            cmd.extend(["-H", h])
        if data is not None:
            cmd.extend(["--data-binary", data])
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 15)
        if r.returncode != 0 and not (r.stdout or "").strip().isdigit():
            raise CannyAuthError(f"curl failed for {url}: {r.stderr or r.stdout}")
        try:
            code = int((r.stdout or "0").strip() or "0")
        except ValueError:
            code = 0
        body = body_path.read_text(encoding="utf-8", errors="replace")
        hdr = hdr_path.read_text(encoding="utf-8", errors="replace")
        return code, body, hdr
    finally:
        body_path.unlink(missing_ok=True)
        hdr_path.unlink(missing_ok=True)


def _parse_json(body: str) -> dict[str, Any]:
    try:
        data = json.loads(body) if body.strip() else {}
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def read_cookie(cookie_jar: Path, name: str, *, domain_substr: str | None = None) -> str | None:
    if not cookie_jar.is_file():
        return None
    for line in cookie_jar.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip() or line.startswith("#"):
            # HttpOnly lines are "#HttpOnly_domain\t..."
            if not line.startswith("#HttpOnly_"):
                continue
            line = line[len("#HttpOnly_") :]
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _, _, _, _, cname, cvalue = parts[:7]
        if cname != name:
            continue
        if domain_substr and domain_substr not in domain:
            continue
        return cvalue
    return None


def _mirror_vrchat_web_cookies(cookie_jar: Path) -> None:
    """Copy api.vrchat.cloud auth cookies onto vrchat.com for the web SSO page."""
    auth = read_cookie(cookie_jar, "auth")
    tfa = read_cookie(cookie_jar, "twoFactorAuth")
    if not auth and not tfa:
        return
    existing = cookie_jar.read_text(encoding="utf-8", errors="replace")
    lines = []
    if auth and f"\tauth\t{auth}" not in existing.replace("#HttpOnly_", ""):
        pass
    # Always append domain mirrors (curl merges/overwrites by domain+name).
    with cookie_jar.open("a", encoding="utf-8") as f:
        for domain, flag in ((".vrchat.com", "TRUE"), ("vrchat.com", "FALSE")):
            if auth:
                f.write(f"{domain}\t{flag}\t/\tTRUE\t0\tauth\t{auth}\n")
            if tfa:
                f.write(f"{domain}\t{flag}\t/\tTRUE\t0\ttwoFactorAuth\t{tfa}\n")
            lines.append(domain)
    if lines:
        print(f"[auth] mirrored VRChat cookies to {', '.join(lines)}")


def _cookie_jar_path() -> Path | None:
    raw = (os.environ.get("CANNY_COOKIE_JAR") or "").strip()
    return Path(raw) if raw else None


def _error_message(data: dict[str, Any], raw: str = "") -> str:
    err = data.get("error")
    if isinstance(err, dict):
        return str(err.get("message") or "")
    if isinstance(err, str):
        return err
    return raw


def _is_too_many_sessions(code: int, data: dict[str, Any], raw: str = "") -> bool:
    if code != 429:
        return False
    msg = _error_message(data, raw).lower()
    return "too many sessions" in msg


def _auth_user_ok(data: dict[str, Any]) -> bool:
    return bool(
        (data.get("id") or data.get("username")) and not data.get("requiresTwoFactorAuth")
    )


def _copy_jar(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(src.read_bytes())
    try:
        os.chmod(dest, 0o600)
    except OSError:
        pass


def _persist_cookie_jar(jar: Path) -> None:
    dest = _cookie_jar_path()
    if dest is None or dest.resolve() == jar.resolve():
        if dest is not None:
            try:
                os.chmod(dest, 0o600)
            except OSError:
                pass
            print(f"[auth] persisted cookie jar → {dest}")
        return
    _copy_jar(jar, dest)
    print(f"[auth] persisted cookie jar → {dest}")


def _session_from_jar(
    jar: Path,
    *,
    viewer: dict[str, Any] | None = None,
) -> CannySession | None:
    """Build a CannySession if the jar already has a working Canny login."""
    csrf = extract_csrf_token(viewer) if viewer else None
    uid = extract_user_id(viewer) if viewer else None
    if not csrf:
        # Reload home to recover csrf when cookies exist but viewer was incomplete.
        code, html, _ = _curl(
            f"https://{CANNY_HOST}/",
            cookie_jar=jar,
            follow=True,
            timeout=30,
            headers=["Accept: text/html,application/xhtml+xml"],
        )
        if code == 200:
            viewer = _parse_viewer(html)
            csrf = extract_csrf_token(viewer)
            uid = extract_user_id(viewer) or uid
    if not csrf:
        return None
    sess = CannySession(
        cookie_jar=jar,
        scraper_user_id=uid,
        viewer=viewer,
        csrf_token=csrf,
    )
    code, data = canny_post_json(sess, "/api/notifications/get", {"pages": 1})
    if code in (401, 403):
        return None
    if isinstance(data, str) and "<html" in data.lower():
        return None
    if code != 200 or not (isinstance(data, dict) and "notifications" in data):
        return None
    if not sess.scraper_user_id:
        sess.scraper_user_id = (
            read_cookie(jar, "__canny__userID", domain_substr="feedback.vrchat")
            or _discover_canny_user_id(sess)
        )
    return sess


def _try_reuse_vrchat(cookie_jar: Path) -> dict[str, Any] | None:
    """Validate existing auth cookie without Basic (does not create a session)."""
    if not read_cookie(cookie_jar, "auth"):
        return None
    code, data, _raw = _auth_user(cookie_jar, basic=None)
    if code == 200 and _auth_user_ok(data):
        _mirror_vrchat_web_cookies(cookie_jar)
        return data
    return None


def _finish_canny_session(jar: Path, *, vrchat_user: dict[str, Any] | None) -> CannySession:
    if vrchat_user:
        print(
            f"[auth] VRChat user={vrchat_user.get('displayName') or vrchat_user.get('username')} "
            f"id={vrchat_user.get('id')}"
        )
    tfa = read_cookie(jar, "twoFactorAuth")
    if tfa:
        print(f"[auth] twoFactorAuth cookie present (len={len(tfa)})")

    viewer = sso_to_canny(jar)
    uid = extract_user_id(viewer)
    csrf = extract_csrf_token(viewer)
    if not csrf:
        raise CannyAuthError(
            "Canny SSO succeeded without csrfToken in viewer; "
            "API calls would fail with invalid csrf token"
        )
    sess = CannySession(
        cookie_jar=jar,
        scraper_user_id=uid,
        viewer=viewer,
        csrf_token=csrf,
    )

    code, data = canny_post_json(sess, "/api/notifications/get", {"pages": 1})
    if code in (401, 403):
        raise CannyAuthError(
            f"Canny session not authenticated (HTTP {code}): {str(data)[:200]}"
        )
    if isinstance(data, str) and "<html" in data.lower():
        raise CannyAuthError("Canny API returned HTML — SSO cookie missing")
    if code != 200 or not (isinstance(data, dict) and "notifications" in data):
        raise CannyAuthError(
            f"Canny /api/notifications/get failed HTTP {code}: {str(data)[:200]}"
        )

    if not sess.scraper_user_id:
        sess.scraper_user_id = (
            read_cookie(jar, "__canny__userID", domain_substr="feedback.vrchat")
            or _discover_canny_user_id(sess)
        )
    if sess.scraper_user_id:
        print(f"[auth] Canny scraper user id: {sess.scraper_user_id}")
    else:
        print("[auth] warning: Canny user id not detected yet")
    _persist_cookie_jar(jar)
    return sess


def _verify_email_otp(cookie_jar: Path, code: str) -> None:
    code = code.strip()
    if not code:
        raise CannyAuthError("empty VRCHAT_EMAIL_OTP")
    http, body, _ = _curl(
        f"{VRCHAT_API}/auth/twofactorauth/emailotp/verify",
        method="POST",
        headers=["Content-Type: application/json"],
        data=json.dumps({"code": code}),
        cookie_jar=cookie_jar,
        follow=False,
    )
    if http != 200:
        raise CannyAuthError(f"VRChat email OTP verify failed HTTP {http}: {body[:300]}")


def _verify_totp(cookie_jar: Path, totp_secret: str) -> None:
    last_body = ""
    for attempt in range(4):
        otp = _totp_code(totp_secret)
        code, body, _ = _curl(
            f"{VRCHAT_API}/auth/twofactorauth/totp/verify",
            method="POST",
            headers=["Content-Type: application/json"],
            data=json.dumps({"code": otp}),
            cookie_jar=cookie_jar,
            follow=False,
        )
        last_body = body
        if code == 429:
            wait = 30 * (attempt + 1)
            print(f"[auth] TOTP rate-limited; sleeping {wait}s")
            time.sleep(wait)
            continue
        if code != 200:
            raise CannyAuthError(f"VRChat TOTP verify failed HTTP {code}: {body[:300]}")
        verified = _parse_json(body)
        if verified and verified.get("verified") is False:
            raise CannyAuthError(f"VRChat TOTP not verified: {body[:300]}")
        return
    raise CannyAuthError(f"VRChat TOTP verify failed HTTP 429: {last_body[:300]}")


def _auth_user(cookie_jar: Path, *, basic: str | None = None) -> tuple[int, dict[str, Any], str]:
    headers = ["Content-Type: application/json"]
    if basic:
        headers.append(f"Authorization: Basic {basic}")
    code, body, _ = _curl(
        f"{VRCHAT_API}/auth/user",
        headers=headers,
        cookie_jar=cookie_jar,
        follow=False,
    )
    return code, _parse_json(body), body


def _login_usernames() -> list[str]:
    """Ordered login identifiers. After an email change, VRCHAT_USERNAME must be the new email."""
    primary = _require_env("VRCHAT_USERNAME")
    extras = (os.environ.get("VRCHAT_USERNAME_FALLBACKS") or "").strip()
    out: list[str] = []
    for u in [primary, *re.split(r"[\s,;]+", extras)]:
        u = u.strip()
        if u and u not in out:
            out.append(u)
    return out


def _complete_2fa(
    cookie_jar: Path,
    *,
    basic: str,
    totp_secret: str,
    code: int,
    data: dict[str, Any],
    raw: str,
) -> dict[str, Any]:
    msg = ""
    err = data.get("error")
    if isinstance(err, dict):
        msg = str(err.get("message") or "")
    elif isinstance(err, str):
        msg = err
    msg_l = msg.lower()

    requires = data.get("requiresTwoFactorAuth") or []
    if isinstance(requires, str):
        requires = [requires]
    requires_l = [str(x).lower() for x in requires]

    email_needed = (
        "emailotp" in "".join(requires_l)
        or "check your email" in msg_l
        or "logging in from somewhere new" in msg_l
    )
    if email_needed:
        email_otp = (os.environ.get("VRCHAT_EMAIL_OTP") or "").strip()
        if not email_otp:
            raise CannyAuthError(
                "VRChat requires email OTP for this location. "
                "Check the account inbox, set VRCHAT_EMAIL_OTP, and retry."
            )
        _verify_email_otp(cookie_jar, email_otp)
        code, data, raw = _auth_user(cookie_jar, basic=basic)
        if code == 200 and (data.get("id") or data.get("username")) and not data.get(
            "requiresTwoFactorAuth"
        ):
            return data
        requires = data.get("requiresTwoFactorAuth") or []
        if isinstance(requires, str):
            requires = [requires]
        requires_l = [str(x).lower() for x in requires]

    if code not in (200, 401) and not requires_l:
        raise CannyAuthError(f"VRChat login failed HTTP {code}: {raw[:300]}")

    if not read_cookie(cookie_jar, "auth"):
        raise CannyAuthError(
            "VRChat login did not set auth cookie before TOTP "
            f"(HTTP {code}): {raw[:300]}"
        )
    _verify_totp(cookie_jar, totp_secret)

    code, data, raw = _auth_user(cookie_jar, basic=None)
    if code != 200 or not (data.get("id") or data.get("username")):
        code, data, raw = _auth_user(cookie_jar, basic=basic)
    if code == 200 and (data.get("id") or data.get("username")) and not data.get(
        "requiresTwoFactorAuth"
    ):
        return data
    raise CannyAuthError(f"VRChat login incomplete HTTP {code}: {raw[:300]}")


def _vrchat_basic_auth(username: str, password: str) -> str:
    """VRChat Basic token: base64(urlencode(username):urlencode(password)).

    Raw ``user:pass`` is valid HTTP Basic, but the VRChat API documents (and
    enforces) percent-encoding first. An email username therefore 401s until
    ``@`` becomes ``%40``; the website login form does not use this scheme.
    """
    token = f"{urllib.parse.quote(username, safe='')}:{urllib.parse.quote(password, safe='')}"
    return base64.b64encode(token.encode("utf-8")).decode("ascii")


def _vrchat_email_registered(email: str) -> bool | None:
    """True/False from GET /auth/exists, or None if the probe did not return a verdict."""
    url = f"{VRCHAT_API}/auth/exists?" + urllib.parse.urlencode({"email": email})
    code, body, _ = _curl(url, follow=False, timeout=15)
    data = _parse_json(body)
    if code != 200 or "userExists" not in data:
        return None
    return bool(data["userExists"])


def _commit_login_jar(attempt: Path, dest: Path) -> None:
    _copy_jar(attempt, dest)
    _mirror_vrchat_web_cookies(dest)


def _logged_in_label(user: dict[str, Any]) -> str:
    return str(user.get("displayName") or user.get("username") or "ok")


def _vrchat_login_basic_once(cookie_jar: Path) -> dict[str, Any]:
    """One Basic+2FA login attempt. Raises CannyAuthError (including too-many-sessions).

    Uses a temp jar so a failed Basic attempt cannot wipe a still-valid auth cookie.
    """
    password = _require_env("VRCHAT_PASSWORD")
    totp_secret = _require_env("VRCHAT_TOTP_SECRET")

    last_invalid = ""
    for username in _login_usernames():
        basic = _vrchat_basic_auth(username, password)
        with tempfile.TemporaryDirectory(prefix="vrc-login-") as td:
            attempt = Path(td) / "cookies.jar"
            attempt.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")

            code, data, raw = _auth_user(attempt, basic=basic)
            if code == 200 and _auth_user_ok(data):
                _commit_login_jar(attempt, cookie_jar)
                print(f"[auth] logged in as {_logged_in_label(data)}")
                return data

            if _is_too_many_sessions(code, data, raw):
                raise CannyAuthError(f"VRChat login failed HTTP {code}: {raw[:300]}")

            msg = _error_message(data, raw)
            msg_l = msg.lower()
            requires = data.get("requiresTwoFactorAuth") or []
            if isinstance(requires, str):
                requires = [requires]

            if requires or "check your email" in msg_l or "somewhere new" in msg_l:
                print("[auth] 2FA challenge")
                user = _complete_2fa(
                    attempt,
                    basic=basic,
                    totp_secret=totp_secret,
                    code=code,
                    data=data,
                    raw=raw,
                )
                _commit_login_jar(attempt, cookie_jar)
                print(f"[auth] logged in as {_logged_in_label(user)}")
                return user

            if code == 401 and "invalid username" in msg_l:
                last_invalid = raw[:300]
                print("[auth] login rejected for configured identifier; trying next if any")
                if "@" in username and _vrchat_email_registered(username) is False:
                    raise CannyAuthError(
                        "VRCHAT_USERNAME is an email VRChat does not have as an account. "
                        "Use the original username or the email shown on "
                        "vrchat.com/home/profile — a mailbox that was never attached "
                        "to the account will 401 even when the password is right."
                    )
                continue

            raise CannyAuthError(f"VRChat login failed HTTP {code}: {raw[:300]}")

    raise CannyAuthError(
        "VRChat login failed for all configured identifiers. "
        "VRCHAT_USERNAME must be the account's current login username or the email "
        "shown on vrchat.com/home/profile. "
        f"Last error: {last_invalid or 'unknown'}"
    )


def vrchat_login(cookie_jar: Path) -> dict[str, Any]:
    """Log into VRChat API. Returns the current-user JSON. Raises on failure.

    On "too many sessions", backs off without spamming Basic login and retries
    cookie-only auth between waits (in case a persisted jar becomes usable).
    """
    reused = _try_reuse_vrchat(cookie_jar)
    if reused is not None:
        print("[auth] reusing VRChat auth cookie")
        return reused

    # Snapshot before Basic wipes the jar — restore for cookie-only probes after 429.
    preload = cookie_jar.read_bytes() if cookie_jar.is_file() else None
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            return _vrchat_login_basic_once(cookie_jar)
        except CannyAuthError as e:
            last_err = e
            if "too many sessions" not in str(e).lower():
                raise
            if attempt >= 3:
                break
            wait = 300 * (attempt + 1)  # 5m, 10m, 15m
            print(
                f"[auth] too many VRChat sessions; sleeping {wait}s "
                f"(attempt {attempt + 1}/4) before retry"
            )
            time.sleep(wait)
            if preload:
                cookie_jar.write_bytes(preload)
            reused = _try_reuse_vrchat(cookie_jar)
            if reused is not None:
                print("[auth] reusing VRChat auth cookie after backoff")
                return reused

    assert last_err is not None
    raise last_err


COMPANY_ID = "58c62e995865713647a7115d"


def _fetch_canny_sso_token(cookie_jar: Path) -> str:
    last_body = ""
    for attempt in range(4):
        code, body, _ = _curl(
            f"{VRCHAT_API}/sso/canny",
            cookie_jar=cookie_jar,
            follow=False,
            timeout=30,
        )
        last_body = body
        if code == 429:
            wait = 30 * (attempt + 1)
            print(f"[auth] SSO token rate-limited; sleeping {wait}s")
            time.sleep(wait)
            continue
        if code != 200:
            raise CannyAuthError(f"GET /api/1/sso/canny failed HTTP {code}: {body[:300]}")
        data = _parse_json(body)
        token = data.get("token") or data.get("ssoToken")
        if not isinstance(token, str) or not token.strip():
            raise CannyAuthError(f"GET /api/1/sso/canny missing token: {body[:300]}")
        return token.strip()
    raise CannyAuthError(f"GET /api/1/sso/canny failed HTTP 429: {last_body[:300]}")


def sso_to_canny(cookie_jar: Path) -> dict[str, Any] | None:
    """Exchange VRChat session for Canny cookies via SSO token redirect."""
    _mirror_vrchat_web_cookies(cookie_jar)
    token = _fetch_canny_sso_token(cookie_jar)
    # Official Canny SSO redirect (see Canny SSO redirect docs).
    sso_url = "https://canny.io/api/redirects/sso?" + urllib.parse.urlencode(
        {
            "companyID": COMPANY_ID,
            "ssoToken": token,
            "redirect": f"https://{CANNY_HOST}/",
        }
    )
    code, html, _ = _curl(
        sso_url,
        cookie_jar=cookie_jar,
        follow=True,
        timeout=60,
        headers=["Accept: text/html,application/xhtml+xml"],
    )
    if code != 200:
        raise CannyAuthError(f"Canny SSO redirect failed HTTP {code}")

    viewer = _parse_viewer(html)
    if extract_user_id(viewer) and extract_csrf_token(viewer):
        return viewer

    # SSR after redirect can briefly show loggedOut; cookies are already set —
    # reload the board home to pick up viewer + csrfToken.
    code2, html2, _ = _curl(
        f"https://{CANNY_HOST}/",
        cookie_jar=cookie_jar,
        follow=True,
        timeout=30,
        headers=["Accept: text/html,application/xhtml+xml"],
    )
    if code2 != 200:
        raise CannyAuthError(f"Canny home after SSO HTTP {code2}")
    return _parse_viewer(html2)


def _parse_viewer(html: str) -> dict[str, Any] | None:
    try:
        from update import parse_canny_data
    except ImportError:
        import sys

        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from update import parse_canny_data  # type: ignore

    data = parse_canny_data(html)
    if not data:
        return None
    viewer = data.get("viewer")
    if isinstance(viewer, dict):
        if viewer.get("loggedOut") is True:
            return viewer
        for key in ("user", "data", "me"):
            node = viewer.get(key)
            if isinstance(node, dict) and (node.get("_id") or node.get("id")):
                return node
        if viewer.get("_id") or viewer.get("id"):
            return viewer
    for key in ("user", "currentUser"):
        node = data.get(key)
        if isinstance(node, dict) and (node.get("_id") or node.get("id")):
            return node
    return viewer if isinstance(viewer, dict) else None


def extract_user_id(viewer: dict[str, Any] | None) -> str | None:
    if not viewer:
        return None
    if viewer.get("loggedOut") is True and not (viewer.get("_id") or viewer.get("id")):
        return None
    for key in ("_id", "id", "userID", "userId"):
        val = viewer.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    user = viewer.get("user")
    if isinstance(user, dict):
        return extract_user_id(user)
    return None


def extract_csrf_token(viewer: dict[str, Any] | None) -> str | None:
    if not viewer:
        return None
    for key in ("csrfToken", "csrf_token", "csrf"):
        val = viewer.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    user = viewer.get("user")
    if isinstance(user, dict):
        return extract_csrf_token(user)
    return None


def canny_post_json(
    session: CannySession,
    path: str,
    payload: dict[str, Any],
    *,
    timeout: int = 30,
) -> tuple[int, Any]:
    url = path if path.startswith("http") else f"https://{CANNY_HOST}{path}"
    # Match Canny's SubdomainBundle AJAX.post: JSON body is payload + csrfToken only
    # (session cookies are sent separately; no __host / __canny_requestID).
    body = dict(payload)
    if session.csrf_token:
        body.setdefault("csrfToken", session.csrf_token)
    code, raw, _ = _curl(
        url,
        method="POST",
        cookie_jar=session.cookie_jar,
        follow=False,
        timeout=timeout,
        headers=[
            "Content-Type: application/json",
            f"Origin: https://{CANNY_HOST}",
            f"Referer: https://{CANNY_HOST}/",
        ],
        data=json.dumps(body),
    )
    try:
        return code, json.loads(raw) if raw.strip() else None
    except json.JSONDecodeError:
        return code, raw


def _discover_canny_user_id(session: CannySession) -> str | None:
    """Best-effort Canny user id from session APIs / cookies."""
    for path, payload in (
        ("/api/users/get", {}),
        ("/api/viewer/get", {}),
        ("/api/notifications/get", {"pages": 1}),
    ):
        code, data = canny_post_json(session, path, payload)
        if code != 200 or not isinstance(data, dict):
            continue
        for key in ("user", "viewer", "me", "currentUser"):
            node = data.get(key)
            if isinstance(node, dict):
                uid = extract_user_id(node)
                if uid:
                    return uid
        uid = extract_user_id(data)
        if uid:
            return uid
    # Cookie jar sometimes stores canny user id in a cookie value — skip.
    return session.scraper_user_id


def login_canny_session() -> CannySession:
    """VRChat + SSO login with optional cookie-jar reuse via CANNY_COOKIE_JAR.

    Order: reuse Canny cookies → reuse VRChat auth + SSO → Basic login + SSO.
    Persists the jar when CANNY_COOKIE_JAR is set.
    """
    persist = _cookie_jar_path()
    if persist is not None:
        persist.parent.mkdir(parents=True, exist_ok=True)
        jar = persist
        if not jar.is_file() or jar.stat().st_size == 0:
            jar.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
            try:
                os.chmod(jar, 0o600)
            except OSError:
                pass
        working = jar
        cleanup_temp = False
    else:
        tmp = tempfile.NamedTemporaryFile(prefix="canny-cookies-", suffix=".jar", delete=False)
        jar = Path(tmp.name)
        tmp.close()
        working = jar
        cleanup_temp = True

    try:
        # Canny home follows redirects and may Set-Cookie; snapshot so a dead
        # Canny session cannot clobber a still-valid VRChat auth cookie.
        snapshot = working.read_bytes() if working.is_file() else None
        reused = _session_from_jar(working)
        if reused is not None:
            print("[auth] reusing Canny session from cookie jar")
            if reused.scraper_user_id:
                print(f"[auth] Canny scraper user id: {reused.scraper_user_id}")
            _persist_cookie_jar(working)
            return reused
        if snapshot is not None:
            working.write_bytes(snapshot)

        # VRChat cookie reuse → SSO only (does not create a new API session).
        user = _try_reuse_vrchat(working)
        if user is not None:
            print("[auth] reusing VRChat auth cookie; SSO to Canny")
            return _finish_canny_session(working, vrchat_user=user)

        # Cold login (Basic creates a new session).
        user = vrchat_login(working)
        return _finish_canny_session(working, vrchat_user=user)
    except Exception:
        if cleanup_temp:
            try:
                working.unlink(missing_ok=True)
            except OSError:
                pass
        raise


@dataclass(frozen=True)
class VoteResult:
    ok: bool
    rate_limited: bool = False
    # Permanent denial (e.g. private board); callers should stop retrying.
    forbidden: bool = False


def classify_vote_error(code: int, err: str) -> tuple[bool, bool]:
    """Map HTTP code + error text to (rate_limited, forbidden)."""
    err_l = (err or "").lower()
    rate_limited = code == 429 or "slow down" in err_l
    if rate_limited:
        return True, False
    forbidden = (
        code in (401, 403)
        or "not authorized" in err_l
        or "unauthorized" in err_l
        or "forbidden" in err_l
    )
    return False, forbidden


def vote_post(session: CannySession, post_id: str, score: int = 1) -> VoteResult:
    code, data = canny_post_json(
        session,
        "/api/posts/vote",
        {"postID": post_id, "score": score},
    )
    if code == 200:
        return VoteResult(ok=True)
    if isinstance(data, dict) and (data.get("id") or "post" in data):
        return VoteResult(ok=True)
    err = ""
    if isinstance(data, dict):
        err = str(data.get("error") or "")
    rate_limited, forbidden = classify_vote_error(code, err)
    print(f"[vote] post {post_id} HTTP {code}: {str(data)[:200]}")
    return VoteResult(ok=False, rate_limited=rate_limited, forbidden=forbidden)


def notification_items_from_response(data: Any) -> list[dict[str, Any]]:
    """Extract notification dicts from a /api/notifications/get payload.

    Live Canny returns ``{notifications: {items: [...], unreadCount, ...}}``.
    Older shapes may put a list under ``notifications`` or top-level ``items``.
    """
    if not isinstance(data, dict):
        return []
    notes = data.get("notifications")
    if isinstance(notes, dict):
        notes = notes.get("items")
    if not isinstance(notes, list):
        notes = data.get("items")
    if not isinstance(notes, list):
        return []
    return [n for n in notes if isinstance(n, dict)]


def fetch_notifications(session: CannySession, pages: int = 10) -> list[dict[str, Any]]:
    code, data = canny_post_json(
        session,
        "/api/notifications/get",
        {"pages": pages},
    )
    if code != 200 or not isinstance(data, dict):
        print(f"[notify] /api/notifications/get HTTP {code}: {str(data)[:200]}")
        return []
    return notification_items_from_response(data)


def mark_all_notifications_read(session: CannySession) -> bool:
    """Clear the scraper's Canny notification inbox (all boards).

    Call only after notify post targets have been collected from a fetch, so a
    wake dispatch cannot wipe unread items before update.py scans them.
    """
    code, data = canny_post_json(session, "/api/notifications/markAllRead", {})
    ok = code == 200 and (
        data == "success"
        or (isinstance(data, str) and data.strip() == "success")
    )
    if not ok:
        print(f"[notify] /api/notifications/markAllRead HTTP {code}: {str(data)[:200]}")
    return ok


def notification_post_ids(notifications: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for n in notifications:
        candidates = [
            n.get("postID"),
            n.get("postId"),
            (n.get("post") or {}).get("_id") if isinstance(n.get("post"), dict) else None,
            (n.get("post") or {}).get("id") if isinstance(n.get("post"), dict) else None,
            n.get("objectID"),
        ]
        for c in candidates:
            if isinstance(c, str) and c.strip() and c not in seen:
                seen.add(c)
                out.append(c)
                break
    return out
