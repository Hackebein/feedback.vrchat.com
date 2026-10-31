"""Sticky proxy for the Canny board update."""

from __future__ import annotations

import io
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
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

    def test_default_session_ignores_run_id(self) -> None:
        with patch.dict(
            "os.environ",
            _env(CANNY_PROXY_PASSWORD=PASSWORD, GITHUB_RUN_ID="41040527302"),
            clear=False,
        ):
            first = canny_proxy.curl_args()
            canny_proxy.reset_state()
            os_run = "999999"
            with patch.dict("os.environ", {"GITHUB_RUN_ID": os_run}, clear=False):
                second = canny_proxy.curl_args()
        self.assertEqual(first, second)
        self.assertEqual(
            first,
            [
                "--socks5-hostname",
                "proxyproxy.arpa.li:1088",
                "--proxy-user",
                f"hackebein.feedbackvrchat:{PASSWORD}",
            ],
        )
        self.assertNotIn("41040527302", first[3])
        self.assertNotIn(os_run, second[3])

    def test_session_string_is_sanitized(self) -> None:
        with patch.dict(
            "os.environ",
            _env(CANNY_PROXY_PASSWORD=PASSWORD, CANNY_PROXY_SESSION="../Run 99!"),
            clear=False,
        ):
            args = canny_proxy.curl_args()
        self.assertEqual(args[3], f"hackebein.Run99:{PASSWORD}")

    def test_default_session_stays_constant_across_resets(self) -> None:
        with patch.dict("os.environ", _env(CANNY_PROXY_PASSWORD=PASSWORD), clear=False):
            first = canny_proxy.curl_args()[3]
            second = canny_proxy.curl_args()[3]
            canny_proxy.reset_state()
            third = canny_proxy.curl_args()[3]
        self.assertEqual(first, f"hackebein.feedbackvrchat:{PASSWORD}")
        self.assertEqual(first, second)
        self.assertEqual(first, third)

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
                f"hackebein.feedbackvrchat:{PASSWORD}",
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
        self.assertNotIn("hackebein.feedbackvrchat", text)
        self.assertNotIn("203.0.113.9", text)
        self.assertIn(b"hackebein.feedbackvrchat", bytes(sock.sent))
        self.assertNotIn(b"hackebein.99", bytes(sock.sent))
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
            raw = f"auth failed for hackebein.feedbackvrchat:{PASSWORD}"
            cleaned = canny_proxy.redact(raw)
        self.assertNotIn(PASSWORD, cleaned)
        self.assertNotIn("hackebein.feedbackvrchat", cleaned)


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
            patch.object(canny_auth.subprocess, "run", side_effect=run),
        ):
            update._curl_get("https://feedback.vrchat.com/bug-reports/p/slug")
            update._curl_post_json("https://feedback.vrchat.com/api/posts/get", {"a": 1})
            canny_auth._curl("https://api.vrchat.cloud/api/1/auth/user")
            canny_auth._curl(canny_auth.SSO_URL)
        sticky = f"hackebein.feedbackvrchat:{PASSWORD}"
        for cmd in cmds[:2]:
            self.assertIn("--socks5-hostname", cmd)
            self.assertIn("proxyproxy.arpa.li:1088", cmd)
            self.assertEqual(cmd[cmd.index("--proxy-user") + 1], sticky)
            self.assertNotIn("41040527302", cmd[cmd.index("--proxy-user") + 1])
        for cmd in cmds[2:]:
            self.assertNotIn("--socks5-hostname", cmd)
            self.assertNotIn("--proxy", cmd)
            self.assertNotIn("--proxy-user", cmd)
            self.assertFalse(any(PASSWORD in part for part in cmd))
        self.assertIn("https://api.vrchat.cloud/api/1/auth/user", cmds[2])
        self.assertIn(canny_auth.SSO_URL, cmds[3])
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


class ProxyHostTest(unittest.TestCase):
    def setUp(self) -> None:
        canny_proxy.reset_state()

    def tearDown(self) -> None:
        canny_proxy.reset_state()

    def test_only_canny_hosts_are_proxied(self) -> None:
        sticky = f"hackebein.feedbackvrchat:{PASSWORD}"
        proxied = [
            "https://feedback.vrchat.com/",
            "https://Feedback.VRChat.com/p/slug",
            "https://canny.io/api/redirects/sso?companyID=1",
            "https://status.canny.io/x",
        ]
        direct = [
            "https://api.vrchat.cloud/api/1/auth/user",
            "https://api.vrchat.cloud/api/1/sso/canny",
            canny_auth.SSO_URL,
            "https://www.vrchat.com/",
            "https://notcanny.io/",
            "https://feedback.vrchat.com.evil.example/",
            "https://canny.io.evil.example/",
        ]
        with patch.dict(
            "os.environ",
            _env(CANNY_PROXY_PASSWORD=PASSWORD, GITHUB_RUN_ID="41040527302"),
            clear=False,
        ):
            for url in proxied:
                args = canny_proxy.curl_args_for(url)
                self.assertEqual(args[0], "--socks5-hostname", url)
                self.assertEqual(args[3], sticky, url)
            for url in direct:
                self.assertEqual(canny_proxy.curl_args_for(url), [], url)
        with patch.dict("os.environ", _env(), clear=False):
            self.assertEqual(canny_proxy.curl_args_for("https://canny.io/"), [])

    def test_blank_session_override_keeps_the_fixed_default(self) -> None:
        with patch.dict(
            "os.environ",
            _env(
                CANNY_PROXY_PASSWORD=PASSWORD,
                CANNY_PROXY_SESSION="!!!",
                GITHUB_RUN_ID="12",
            ),
            clear=False,
        ):
            user = canny_proxy.curl_args()[3]
        self.assertEqual(user, f"hackebein.feedbackvrchat:{PASSWORD}")

    def test_direct_vrchat_cookie_reaches_proxied_canny_sso(self) -> None:
        auth_cookie = "vrchat-auth-cookie"
        token = "sso-token-value"
        viewer_html = 'window.__data = {"viewer":{"_id":"usr_1","csrfToken":"csrf_1"}}'
        with tempfile.TemporaryDirectory() as td:
            jar = Path(td) / "cookies.jar"
            jar.write_text(
                "# Netscape HTTP Cookie File\n"
                f"api.vrchat.cloud\tFALSE\t/\tTRUE\t0\tauth\t{auth_cookie}\n",
                encoding="utf-8",
            )
            seen: list[list[str]] = []

            def run(cmd, **kwargs):
                cmd = list(cmd)
                seen.append(cmd)
                url = next(part for part in cmd if part.startswith("http"))
                Path(cmd[cmd.index("-D") + 1]).write_text("HTTP/1.1 200\n", encoding="utf-8")
                baked = Path(cmd[cmd.index("-b") + 1]).read_text(encoding="utf-8")
                body = Path(cmd[cmd.index("-o") + 1])
                ua = cmd[cmd.index("-H") + 1]
                if "api.vrchat.cloud" in url:
                    self.assertIn("/sso/canny", url)
                    self.assertNotIn("--socks5-hostname", cmd)
                    self.assertNotIn("--proxy-user", cmd)
                    self.assertFalse(any(PASSWORD in part for part in cmd))
                    self.assertIn(canny_auth.USER_AGENT, ua)
                    self.assertNotIn(canny_auth.CANNY_USER_AGENT, ua)
                    self.assertIn(auth_cookie, baked)
                    body.write_text(f'{{"token":"{token}"}}', encoding="utf-8")
                else:
                    self.assertTrue(url.startswith("https://feedback.vrchat.com/?"))
                    self.assertIn("ssoToken=" + token, url)
                    self.assertIn("--socks5-hostname", cmd)
                    self.assertEqual(
                        cmd[cmd.index("--proxy-user") + 1],
                        f"hackebein.feedbackvrchat:{PASSWORD}",
                    )
                    self.assertIn(canny_auth.CANNY_USER_AGENT, ua)
                    self.assertNotIn("VRChatFeedbackArchiver", ua)
                    self.assertNotIn(auth_cookie, baked)
                    trace = cmd[cmd.index("--trace-ascii") + 1]
                    Path(trace).write_text(
                        "SOCKS5 request granted.\n203.0.113.9\n"
                        f"ssoToken={token}\n",
                        encoding="utf-8",
                    )
                    body.write_text(viewer_html, encoding="utf-8")
                return subprocess.CompletedProcess(cmd, 0, stdout="200", stderr="")

            out = io.StringIO()
            with (
                patch.dict(
                    "os.environ",
                    _env(CANNY_PROXY_PASSWORD=PASSWORD, GITHUB_RUN_ID="41040527302"),
                    clear=False,
                ),
                patch.object(canny_auth.subprocess, "run", side_effect=run),
                redirect_stdout(out),
            ):
                viewer = canny_auth.sso_to_canny(jar)
            logged = out.getvalue()
            self.assertEqual(viewer["_id"], "usr_1")
            self.assertEqual(viewer["csrfToken"], "csrf_1")
            self.assertEqual(len(seen), 2)
            self.assertIn(auth_cookie, jar.read_text(encoding="utf-8"))
            self.assertNotIn("41040527302", seen[1][seen[1].index("--proxy-user") + 1])
            self.assertIn("[proxy] sso-board via=socks5h http=200", logged)
            self.assertNotIn(token, logged)
            self.assertNotIn(auth_cookie, logged)
            self.assertNotIn(PASSWORD, logged)
            self.assertNotIn("203.0.113.9", logged)


class CannyFingerprintTest(unittest.TestCase):
    def setUp(self) -> None:
        canny_proxy.reset_state()

    def tearDown(self) -> None:
        canny_proxy.reset_state()

    def test_diag_line_reports_socks_without_trace_secrets(self) -> None:
        trace = (
            "SOCKS5 connect to canny.io:443 (remotely resolved)\n"
            "SOCKS5 request granted.\n"
            "Connected to 203.0.113.50 port 443\n"
            "GET /api/redirects/sso?ssoToken=SECRETTOKEN HTTP/1.1\n"
            "Proxy-Authorization: Basic c2VjcmV0\n"
        )
        line = canny_proxy.proxy_diag_line(
            "sso-redirect", trace, configured=True, http_code=403,
        )
        self.assertEqual(line, "[proxy] sso-redirect via=socks5h http=403")
        self.assertNotIn("203.0.113.50", line)
        self.assertNotIn("SECRETTOKEN", line)
        self.assertNotIn("c2VjcmV0", line)

    def test_diag_line_unconfirmed_when_proxy_configured_but_trace_is_direct(self) -> None:
        line = canny_proxy.proxy_diag_line(
            "sso-board", "Connected to example port 443\n", configured=True, http_code=200,
        )
        self.assertEqual(line, "[proxy] sso-board via=unconfirmed http=200")

    def test_diag_line_direct_without_proxy(self) -> None:
        line = canny_proxy.proxy_diag_line("sso-home", "", configured=False, http_code=200)
        self.assertEqual(line, "[proxy] sso-home via=direct http=200")

    def test_poisoned_label_is_not_logged(self) -> None:
        line = canny_proxy.proxy_diag_line(
            "sso-redirect\n203.0.113.50 SECRETTOKEN", "", configured=False, http_code=0,
        )
        self.assertEqual(line, "[proxy] request via=direct http=0")

    def _curl_headers(self, url: str, diag: str | None = None) -> tuple[list[str], str]:
        seen: dict[str, list[str]] = {}

        def run(cmd, **kwargs):
            seen["cmd"] = list(cmd)
            if "--trace-ascii" in cmd:
                path = cmd[cmd.index("--trace-ascii") + 1]
                seen["trace"] = path
                Path(path).write_text(
                    "SOCKS5 request granted.\n203.0.113.9\nssoToken=SECRETTOKEN\n",
                    encoding="utf-8",
                )
            return subprocess.CompletedProcess(cmd, 0, stdout="200", stderr="")

        buf = io.StringIO()
        kwargs = {"diag_label": diag} if diag else {}
        with patch.object(canny_auth.subprocess, "run", side_effect=run), redirect_stdout(buf):
            canny_auth._curl(url, **kwargs)
        trace = seen.get("trace")
        if trace is not None:
            self.assertFalse(Path(trace).exists())
        return seen["cmd"], buf.getvalue()

    def test_canny_requests_use_browser_ua_and_vrchat_keeps_archiver(self) -> None:
        canny_cmd, _ = self._curl_headers("https://canny.io/api/redirects/sso?ssoToken=SECRET")
        board_cmd, _ = self._curl_headers("https://feedback.vrchat.com/?ssoToken=SECRET")
        vrchat_cmd, _ = self._curl_headers("https://api.vrchat.cloud/api/1/auth/user")
        for cmd in (canny_cmd, board_cmd):
            ua = cmd[cmd.index("-H") + 1]
            self.assertIn(canny_auth.CANNY_USER_AGENT, ua)
            self.assertNotIn("VRChatFeedbackArchiver", ua)
            self.assertNotIn("SECRET", ua)
        vr_ua = vrchat_cmd[vrchat_cmd.index("-H") + 1]
        self.assertIn("VRChatFeedbackArchiver", vr_ua)
        self.assertEqual(update.USER_AGENT, canny_auth.CANNY_USER_AGENT)

    def test_sso_curl_logs_proxied_without_token_or_ip(self) -> None:
        _cmd, out = self._curl_headers(
            "https://canny.io/api/redirects/sso?ssoToken=SECRETTOKEN",
            diag="sso-redirect",
        )
        self.assertIn("[proxy] sso-redirect via=socks5h http=200", out)
        self.assertNotIn("SECRETTOKEN", out)
        self.assertNotIn("203.0.113.9", out)

    def test_scrape_curl_uses_browser_ua(self) -> None:
        seen: dict[str, list[str]] = {}

        def run(cmd, **kwargs):
            seen["cmd"] = list(cmd)
            return subprocess.CompletedProcess(cmd, 0, stdout="\n__HTTP_CODE__:200", stderr="")

        with patch.object(update.subprocess, "run", side_effect=run), patch.object(update.time, "sleep"):
            update._curl_get("https://feedback.vrchat.com/bug-reports/p/slug")
        ua = seen["cmd"][seen["cmd"].index("-H") + 1]
        self.assertIn(canny_auth.CANNY_USER_AGENT, ua)
        self.assertNotIn("VRChatFeedbackArchiver", ua)


if __name__ == "__main__":
    unittest.main()
