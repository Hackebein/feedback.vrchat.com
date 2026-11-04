"""Exercise real persistent HTTP connections through loopback proxy fixtures."""

from __future__ import annotations

import base64
import io
import json
import os
import select
import shutil
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

import canny_auth
import canny_http
import canny_proxy
import update


class EchoHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        with self.server.condition:
            self.server.accepted += 1

    def finish(self):
        try:
            super().finish()
        finally:
            with self.server.condition:
                self.server.closed += 1
                self.server.condition.notify_all()

    def log_message(self, *args):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError):
            pass  # Closing a pooled socket can produce a reset on Windows.

    def do_GET(self):
        self.echo()

    def do_POST(self):
        self.echo()

    def echo(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
        path = urlsplit(self.path).path
        if path == "/barrier":
            self.server.barrier.wait(timeout=3)
        if path == "/slow":
            time.sleep(0.3)
        if path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/echo")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        result = {"method": self.command, "body": data,
                  "content_type": self.headers.get("Content-Type"),
                  "user_agent": self.headers.get("User-Agent"),
                  "cookie": self.headers.get("Cookie"),
                  "proxy_auth": self.headers.get("Proxy-Authorization")}
        self.server.requests.append(result)
        body = json.dumps(result).encode()
        self.send_response(int(path.rsplit("/", 1)[-1]) if path.startswith("/status/") else 200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", "test=must-not-be-retained; Path=/")
        if path == "/close":
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # A deadline test deliberately disconnects before the response.


def _read(sock, count):
    data = bytearray()
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise EOFError
        data.extend(chunk)
    return bytes(data)


class SocksHandler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        client.settimeout(3)
        try:
            version, count = _read(client, 2)
            methods = _read(client, count)
            if version != 5 or 2 not in methods:
                return
            client.sendall(b"\x05\x02")
            version, count = _read(client, 2)
            username = _read(client, count).decode()
            password = _read(client, _read(client, 1)[0]).decode()
            self.server.auth.append((username, password))
            client.sendall(b"\x01\x01" if self.server.reject else b"\x01\x00")
            if self.server.reject:
                return
            version, command, _, kind = _read(client, 4)
            if kind == 3:
                host = _read(client, _read(client, 1)[0]).decode()
            else:
                host = socket.inet_ntoa(_read(client, 4))
            port = int.from_bytes(_read(client, 2), "big")
            self.server.destinations.append((host, port, kind))
            # Resolve the Canny test hostname at the proxy, never on the client.
            with socket.create_connection(("127.0.0.1", self.server.origin_port), timeout=3) as upstream:
                client.sendall(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x01")
                while True:
                    ready, _, _ = select.select([client, upstream], [], [], 3)
                    if not ready:
                        return
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is client else client).sendall(data)
        except (EOFError, OSError):
            return


class SocksServer(socketserver.ThreadingTCPServer):
    daemon_threads = True


@contextmanager
def server_fixture(handler=EchoHandler, tls_context=None):
    if handler is SocksHandler:
        server = SocksServer(("127.0.0.1", 0), handler)
        server.auth, server.destinations, server.reject = [], [], False
    else:
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.condition = threading.Condition()
        server.accepted = server.closed = 0
        server.requests = []
        if tls_context is not None:
            server.socket = tls_context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


class PersistentHttpTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"CANNY_PROXY_PASSWORD": "", "CANNY_HTTP_TRANSPORT": "pooled"})
        self.env.start()
        canny_proxy.reset_state()
        canny_http.close_default_pool()
        update.reset_http_stats()

    def tearDown(self):
        canny_http.close_default_pool()
        canny_proxy.reset_state()
        self.env.stop()

    def request(self, url, method="GET", data=None, timeout=2):
        return canny_http.request(method, url, data=data, timeout=timeout,
                                  user_agent=canny_auth.CANNY_USER_AGENT)

    def proxy_env(self, proxy, **extra):
        return patch.dict(os.environ, {"CANNY_PROXY_HOST": "127.0.0.1",
                          "CANNY_PROXY_PORT": str(proxy.server_address[1]),
                          "CANNY_PROXY_PASSWORD": "fixture-password", "CANNY_PROXY_SCHEME": "socks5",
                          "CANNY_PROXY_SESSION": "feedbackvrchat", "CANNY_PROXY_USER_PREFIX": "hackebein",
                          "NO_PROXY": "*", **extra})

    def test_socks_reuses_tunnel_for_get_post_get_without_request_or_cookie_leaks(self):
        with server_fixture() as origin, server_fixture(SocksHandler) as proxy:
            proxy.origin_port = origin.server_port
            url = f"http://feedback.vrchat.com:{origin.server_port}/echo"
            with self.proxy_env(proxy), canny_http.client_scope() as pool:
                for method, payload in (("GET", None), ("POST", b'{"a":1}'), ("GET", None)):
                    code, raw = self.request(url, method, payload)
                    self.assertEqual(code, 200)
                    body = json.loads(raw)
                    self.assertEqual(body["method"], method)
                    self.assertEqual(body["body"], payload.decode() if payload else "")
                    self.assertEqual(body["content_type"], "application/json" if payload else None)
                    self.assertIsNone(body["cookie"])
                    self.assertIsNone(body["proxy_auth"])
                    self.assertEqual(body["user_agent"], canny_auth.CANNY_USER_AGENT)
                self.assertEqual(len(pool._handles), 1)
            self.assertEqual(proxy.auth, [("hackebein.feedbackvrchat", "fixture-password")])
            self.assertEqual(proxy.destinations, [("feedback.vrchat.com", origin.server_port, 3)])
            self.assertEqual(origin.accepted, 1)
            self.assertEqual(canny_http.new_connections(), 1)
            with origin.condition:
                self.assertTrue(origin.condition.wait_for(lambda: origin.closed == 1, timeout=2))

    def test_legacy_and_pooled_results_match_with_fewer_connections(self):
        with server_fixture() as origin, server_fixture(SocksHandler) as proxy:
            proxy.origin_port = origin.server_port
            url = f"http://feedback.vrchat.com:{origin.server_port}/echo"
            results = {}
            for backend in ("curl", "pooled"):
                canny_http.reset_stats()
                with self.proxy_env(proxy), canny_http.client_scope(backend):
                    results[backend] = [self.request(url), self.request(url, "POST", b'{"a":1}'), self.request(url)]
                self.assertEqual(canny_http.new_connections(), 3 if backend == "curl" else 1)
            self.assertEqual(results["curl"], results["pooled"])

    def test_direct_routing_ignores_ambient_proxy_and_keeps_proxy_credentials_separate(self):
        with server_fixture() as origin, server_fixture(SocksHandler) as proxy:
            proxy.origin_port = origin.server_port
            with self.proxy_env(proxy, ALL_PROXY="http://127.0.0.1:1", HTTP_PROXY="http://127.0.0.1:1"), canny_http.client_scope() as pool:
                self.assertEqual(self.request(f"http://feedback.vrchat.com:{origin.server_port}/echo")[0], 200)
                self.assertEqual(self.request(f"http://127.0.0.1:{origin.server_port}/echo")[0], 200)
                self.assertEqual(len(pool._handles), 2)
            self.assertEqual(len(proxy.auth), 1)
            self.assertTrue(all(r["proxy_auth"] is None for r in origin.requests))

    def test_http_proxy_receives_absolute_url_and_proxy_auth(self):
        with server_fixture() as proxy:
            for backend in ("pooled", "curl"):
                with self.proxy_env(proxy, CANNY_PROXY_SCHEME="http"), canny_http.client_scope(backend):
                    code, raw = self.request("http://feedback.vrchat.com/echo")
                    self.assertEqual(code, 200)
                    expected = base64.b64encode(b"hackebein.feedbackvrchat:fixture-password").decode()
                    self.assertEqual(json.loads(raw)["proxy_auth"], f"Basic {expected}")

    def test_closed_connection_reconnects(self):
        with server_fixture() as origin, canny_http.client_scope():
            self.assertEqual(self.request(f"http://127.0.0.1:{origin.server_port}/close")[0], 200)
            self.assertEqual(self.request(f"http://127.0.0.1:{origin.server_port}/echo")[0], 200)
            self.assertEqual(canny_http.new_connections(), 2)

    def test_get_follows_redirect_and_post_does_not(self):
        with server_fixture() as origin:
            for backend in ("pooled", "curl"):
                with canny_http.client_scope(backend):
                    url = f"http://127.0.0.1:{origin.server_port}/redirect"
                    self.assertEqual(self.request(url)[0], 200)
                    self.assertEqual(self.request(url, "POST", b"{}")[0], 302)

    def test_deadline_returns_transport_error_and_next_request_recovers(self):
        with server_fixture() as origin, canny_http.client_scope():
            start = time.monotonic()
            self.assertEqual(self.request(f"http://127.0.0.1:{origin.server_port}/slow", timeout=0.08), (0, ""))
            self.assertLess(time.monotonic() - start, 0.6)
            self.assertEqual(self.request(f"http://127.0.0.1:{origin.server_port}/echo")[0], 200)

    def test_https_certificate_validation_and_tls_reuse_through_socks(self):
        openssl = shutil.which("openssl")
        if not openssl:
            candidate = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/usr/bin/openssl.exe"
            if candidate.is_file():
                openssl = str(candidate)
        if not openssl:
            self.skipTest("openssl is required to generate the loopback TLS fixture")
        with tempfile.TemporaryDirectory() as temp:
            cert, key = Path(temp) / "cert.pem", Path(temp) / "key.pem"
            subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-keyout", str(key), "-out", str(cert), "-subj", "/CN=feedback.vrchat.com",
                            "-addext", "subjectAltName=DNS:feedback.vrchat.com"],
                           check=True, capture_output=True, timeout=10)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            with server_fixture(tls_context=tls) as origin, server_fixture(SocksHandler) as proxy:
                proxy.origin_port = origin.server_port
                url = f"https://feedback.vrchat.com:{origin.server_port}/echo"
                with self.proxy_env(proxy), canny_http.client_scope() as pool:
                    self.assertEqual(self.request(url), (0, ""))  # Untrusted self-signed cert.
                    pool._ca_file = str(cert)  # Trust this test certificate only.
                    before = canny_http.new_connections()
                    self.assertEqual(self.request(url)[0], 200)
                    self.assertEqual(self.request(url)[0], 200)
                    self.assertEqual(canny_http.new_connections() - before, 1)
                    # Trusting the CA still must not bypass hostname checks.
                    self.assertEqual(self.request(f"https://127.0.0.1:{origin.server_port}/echo"), (0, ""))

    def test_proxy_failure_does_not_fall_back_or_log_secrets(self):
        with server_fixture() as origin, server_fixture(SocksHandler) as proxy:
            proxy.origin_port, proxy.reject = origin.server_port, True
            for backend in ("pooled", "curl"):
                output = io.StringIO()
                with self.proxy_env(proxy), canny_http.client_scope(backend), redirect_stdout(output), redirect_stderr(output):
                    self.assertEqual(self.request(f"http://feedback.vrchat.com:{origin.server_port}/echo?token=private"), (0, ""))
                self.assertEqual(output.getvalue(), "")
            self.assertEqual(origin.accepted, 0)

    def test_each_worker_owns_handle_and_stage_closes_after_join(self):
        with server_fixture() as origin, canny_http.client_scope():
            origin.barrier = threading.Barrier(2)
            ex = canny_http.FetchExecutor(max_workers=2)
            try:
                futures = [ex.submit(self.request, f"http://127.0.0.1:{origin.server_port}/barrier") for _ in range(2)]
                self.assertEqual([f.result()[0] for f in futures], [200, 200])
                self.assertEqual(len(ex.http_pool._handles), 2)
            finally:
                ex.shutdown(wait=True, cancel_futures=True)
            self.assertTrue(ex.http_pool._closed)
            self.assertEqual(ex.http_pool._handles, [])
            with origin.condition:
                self.assertTrue(origin.condition.wait_for(lambda: origin.closed == 2, timeout=2))

    def test_abort_closes_worker_and_main_thread_connections(self):
        with server_fixture() as origin:
            pool = None
            with self.assertRaises(update.CannyBlocked):
                with canny_http.client_scope() as pool:
                    self.request(f"http://127.0.0.1:{origin.server_port}/echo")
                    with canny_http.FetchExecutor(max_workers=1) as ex:
                        for _ in range(3):
                            ex.submit(update._curl_get, f"http://127.0.0.1:{origin.server_port}/status/403").result()
            self.assertTrue(pool._closed)
            self.assertTrue(ex.http_pool._closed)
            with origin.condition:
                self.assertTrue(origin.condition.wait_for(lambda: origin.closed == origin.accepted, timeout=2))

    def test_main_closes_transport_on_success_and_early_exit(self):
        for error in (None, SystemExit(1), update.CannyBlocked("blocked")):
            with self.subTest(error=error), patch.object(update, "_main", side_effect=error):
                pools = []
                original = canny_http.ClientPool

                def create(backend=None):
                    pool = original(backend)
                    pools.append(pool)
                    return pool

                with patch.object(canny_http, "ClientPool", side_effect=create):
                    if error:
                        with self.assertRaises(type(error)):
                            update.main()
                    else:
                        update.main()
                self.assertTrue(pools[0]._closed)

    def test_backend_selected_once_and_inherited_by_workers(self):
        with canny_http.client_scope("curl"):
            with patch.dict(os.environ, {"CANNY_HTTP_TRANSPORT": "pooled"}):
                with canny_http.FetchExecutor(max_workers=1) as ex:
                    self.assertEqual(ex.submit(lambda: canny_http.current_pool().backend).result(), "curl")

    def test_invalid_backend_fails_before_requests(self):
        with self.assertRaisesRegex(ValueError, "must be pooled or curl"):
            canny_http.ClientPool("invalid")

    def test_rollback_works_without_importing_pycurl(self):
        with patch.dict("sys.modules", {"pycurl": None}), canny_http.client_scope("curl"):
            with patch.object(canny_http.subprocess, "run", side_effect=OSError("private details")):
                self.assertEqual(self.request("http://feedback.vrchat.com/"), (0, ""))


if __name__ == "__main__":
    unittest.main()
