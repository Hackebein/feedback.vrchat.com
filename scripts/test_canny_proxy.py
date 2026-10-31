"""Sticky proxy for the Canny board update."""

from __future__ import annotations

import io
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import canny_auth
import canny_proxy
import update

PASSWORD = "s3cret-password"
BOUND_IP = bytes([203, 0, 113, 9])


def _env(**overrides: str) -> dict[str, str]:
    base = {
        "CANNY_PROXY_PASSWORD": "",
        "CANNY_PROXY_SESSION": "",
        "GITHUB_RUN_ID": "",
        "CANNY_PROXY_HOST": "",
        "CANNY_PROXY_PORT": "",
        "CANNY_PROXY_SCHEME": "",
        "CANNY_PROXY_USER_PREFIX": "",
    }
    base.update(overrides)
    return base


class _FakeSock:
    def __init__(self, incoming: bytes):
        self.incoming = bytearray(incoming)
        self.sent = bytearray()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def settimeout(self, _timeout: float) -> None:
        return None

    def sendall(self, data: bytes) -> None:
        self.sent += data

    def recv(self, n: int) -> bytes:
        if not self.incoming:
            return b""
        take = bytes(self.incoming[:n])
        del self.incoming[:n]
        return take

    def close(self) -> None:
        return None


def _socks_ok() -> bytes:
    return b"\x05\x02" + b"\x01\x00" + b"\x05\x00\x00\x01" + BOUND_IP + b"\x01\xbb"


class ProxyConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        canny_proxy.reset_state()

    def tearDown(self) -> None:
        canny_proxy.reset_state()

    def test_unset_password_stays_direct(self) -> None:
        with patch.dict("os.environ", _env(), clear=False):
            self.assertIsNone(canny_proxy.load_config())
            self.assertEqual(canny_proxy.curl_args(), [])
            with patch.object(canny_proxy.socket, "create_connection") as connect:
                canny_proxy.require_proxy()
        connect.assert_not_called()

    def test_sticky_session_from_run_id(self) -> None:
        with patch.dict(
            "os.environ",
            _env(CANNY_PROXY_PASSWORD=PASSWORD, GITHUB_RUN_ID="41040527302"),
            clear=False,
        ):
            first = canny_proxy.curl_args()
            second = canny_proxy.curl_args()
        self.assertEqual(first, second)
        self.assertEqual(
            first,
            [
                "--socks5-hostname",
                "proxyproxy.arpa.li:1088",
                "--proxy-user",
                f"hackebein.41040527302:{PASSWORD}",
            ],
        )

    def test_session_string_is_sanitized(self) -> None:
        with patch.dict(
            "os.environ",
            _env(CANNY_PROXY_PASSWORD=PASSWORD, CANNY_PROXY_SESSION="../Run 99!"),
            clear=False,
        ):
            args = canny_proxy.curl_args()
        self.assertEqual(args[3], f"hackebein.Run99:{PASSWORD}")

    def test_generated_session_stays_constant(self) -> None:
        with patch.dict("os.environ", _env(CANNY_PROXY_PASSWORD=PASSWORD), clear=False):
            first = canny_proxy.curl_args()[3]
            second = canny_proxy.curl_args()[3]
        user = first.split(":", 1)[0]
        self.assertEqual(first, second)
        self.assertTrue(user.startswith("hackebein."))
        self.assertRegex(user.removeprefix("hackebein."), r"[0-9a-f]{16}")

    def test_http_scheme_curl_args(self) -> None:
        with patch.dict(
            "os.environ",
            _env(
                CANNY_PROXY_PASSWORD=PASSWORD,
                CANNY_PROXY_SCHEME="http",
                GITHUB_RUN_ID="42",
                CANNY_PROXY_HOST="proxy.example",
                CANNY_PROXY_PORT="1080",
                CANNY_PROXY_USER_PREFIX="hackebein",
            ),
            clear=False,
        ):
            args = canny_proxy.curl_args()
        self.assertEqual(
            args,
            [
                "--proxy",
                "http://proxy.example:1080",
                "--proxy-user",
                f"hackebein.42:{PASSWORD}",
            ],
        )

    def test_socks5h_uses_socks5_hostname(self) -> None:
        with patch.dict(
            "os.environ",
            _env(
                CANNY_PROXY_PASSWORD=PASSWORD,
                CANNY_PROXY_SCHEME="socks5h",
                GITHUB_RUN_ID="7",
            ),
            clear=False,
        ):
            args = canny_proxy.curl_args()
        self.assertEqual(args[0], "--socks5-hostname")

    def test_unsupported_scheme_and_bad_port(self) -> None:
        with patch.dict(
            "os.environ",
            _env(CANNY_PROXY_PASSWORD=PASSWORD, CANNY_PROXY_SCHEME="ftp"),
            clear=False,
        ):
            with self.assertRaises(canny_proxy.CannyProxyError) as ctx:
                canny_proxy.curl_args()
        self.assertNotIn(PASSWORD, str(ctx.exception))
        canny_proxy.reset_state()
        with patch.dict(
            "os.environ",
            _env(CANNY_PROXY_PASSWORD=PASSWORD, CANNY_PROXY_PORT="nope"),
            clear=False,
        ):
            with self.assertRaises(canny_proxy.CannyProxyError) as ctx:
                canny_proxy.load_config()
        self.assertNotIn(PASSWORD, str(ctx.exception))

    def test_require_proxy_logs_scheme_without_secrets_or_bound_address(self) -> None:
        sock = _FakeSock(_socks_ok())
        out = io.StringIO()
        with (
            patch.dict(
                "os.environ",
                _env(CANNY_PROXY_PASSWORD=PASSWORD, GITHUB_RUN_ID="99"),
                clear=False,
            ),
            patch.object(canny_proxy.socket, "create_connection", return_value=sock),
            redirect_stdout(out),
        ):
            canny_proxy.require_proxy()
        text = out.getvalue()
        self.assertIn("[proxy] socks5 connected", text)
        self.assertNotIn(PASSWORD, text)
        self.assertNotIn("hackebein.99", text)
        self.assertNotIn("203.0.113.9", text)
        self.assertIn(b"hackebein.99", bytes(sock.sent))
        self.assertIn(PASSWORD.encode(), bytes(sock.sent))
        self.assertIn(b"feedback.vrchat.com", bytes(sock.sent))

    def test_socks_auth_failure_aborts_without_leaking_password(self) -> None:
        sock = _FakeSock(b"\x05\x02\x01\x01")
        with (
            patch.dict(
                "os.environ",
                _env(CANNY_PROXY_PASSWORD=PASSWORD, GITHUB_RUN_ID="99"),
                clear=False,
            ),
            patch.object(canny_proxy.socket, "create_connection", return_value=sock),
        ):
            with self.assertRaises(canny_proxy.CannyProxyError) as ctx:
                canny_proxy.require_proxy()
        self.assertIn("authentication failed", str(ctx.exception))
        self.assertNotIn(PASSWORD, str(ctx.exception))

    def test_http_proxy_check(self) -> None:
        sock = _FakeSock(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        out = io.StringIO()
        with (
            patch.dict(
                "os.environ",
                _env(
                    CANNY_PROXY_PASSWORD=PASSWORD,
                    CANNY_PROXY_SCHEME="http",
                    GITHUB_RUN_ID="5",
                ),
                clear=False,
            ),
            patch.object(canny_proxy.socket, "create_connection", return_value=sock),
            redirect_stdout(out),
        ):
            canny_proxy.require_proxy()
        self.assertIn("[proxy] http connected", out.getvalue())
        self.assertNotIn(PASSWORD, out.getvalue())
        self.assertIn(b"CONNECT feedback.vrchat.com:443", bytes(sock.sent))
        self.assertNotIn(PASSWORD.encode(), out.getvalue().encode())

    def test_http_407_is_auth_failure(self) -> None:
        sock = _FakeSock(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
        with (
            patch.dict(
                "os.environ",
                _env(CANNY_PROXY_PASSWORD=PASSWORD, CANNY_PROXY_SCHEME="http", GITHUB_RUN_ID="5"),
                clear=False,
            ),
            patch.object(canny_proxy.socket, "create_connection", return_value=sock),
        ):
            with self.assertRaises(canny_proxy.CannyProxyError) as ctx:
                canny_proxy.require_proxy()
        self.assertIn("authentication failed", str(ctx.exception))
        self.assertNotIn(PASSWORD, str(ctx.exception))

    def test_redact_strips_password_and_username(self) -> None:
        with patch.dict(
            "os.environ",
            _env(CANNY_PROXY_PASSWORD=PASSWORD, GITHUB_RUN_ID="15"),
            clear=False,
        ):
            raw = f"auth failed for hackebein.15:{PASSWORD}"
            cleaned = canny_proxy.redact(raw)
        self.assertNotIn(PASSWORD, cleaned)
        self.assertNotIn("hackebein.15", cleaned)


class ProxyCurlTest(unittest.TestCase):
    def setUp(self) -> None:
        canny_proxy.reset_state()
        update.reset_http_stats()

    def tearDown(self) -> None:
        canny_proxy.reset_state()
        update.reset_http_stats()

    def test_scrape_curls_share_one_sticky_user(self) -> None:
        cmds: list[list[str]] = []

        def run(cmd, **kwargs):
            cmds.append(list(cmd))
            if cmd[1:3] == ["-sS", "-L"] or "--data-binary" in cmd:
                body = "\n__HTTP_CODE__:200"
            else:
                body = "200"
            return subprocess.CompletedProcess(cmd, 0, stdout=body, stderr="")

        env = _env(CANNY_PROXY_PASSWORD=PASSWORD, GITHUB_RUN_ID="41040527302")
        with (
            patch.dict("os.environ", env, clear=False),
            patch.object(update.subprocess, "run", side_effect=run),
            patch.object(update.time, "sleep"),
        ):
            update._curl_get("https://feedback.vrchat.com/bug-reports/p/slug")
            update._curl_post_json("https://feedback.vrchat.com/api/posts/get", {"a": 1})
            canny_auth._curl("https://api.vrchat.cloud/api/1/auth/user")
        users = []
        for cmd in cmds:
            self.assertIn("--socks5-hostname", cmd)
            self.assertIn("proxyproxy.arpa.li:1088", cmd)
            users.append(cmd[cmd.index("--proxy-user") + 1])
        self.assertEqual(users, [f"hackebein.41040527302:{PASSWORD}"] * 3)
        self.assertIn("https://api.vrchat.cloud/api/1/auth/user", cmds[2])
        self.assertIn("https://feedback.vrchat.com/api/posts/get", cmds[1])

    def test_proxy_failure_stops_before_login(self) -> None:
        buf = io.StringIO()
        with (
            patch.object(sys, "argv", ["update.py", "--refresh-oldest", "0", "--refresh-newest", "0"]),
            patch.object(
                update.canny_proxy,
                "require_proxy",
                side_effect=canny_proxy.CannyProxyError("socks5 authentication failed"),
            ),
            patch.object(update.canny_auth, "login_canny_session") as login,
            patch.object(update, "fetch_newest_all") as newest,
            patch.object(update, "fetch_all_pages") as pages,
            redirect_stderr(buf),
        ):
            with self.assertRaises(SystemExit) as ctx:
                update.main()
        self.assertEqual(ctx.exception.code, 1)
        err = buf.getvalue()
        self.assertIn("Canny proxy failed: socks5 authentication failed", err)
        self.assertIn("no further Canny requests", err)
        self.assertNotIn(PASSWORD, err)
        login.assert_not_called()
        newest.assert_not_called()
        pages.assert_not_called()


if __name__ == "__main__":
    unittest.main()
