"""Run-scoped, per-worker libcurl connections for unauthenticated Canny reads.

Authentication deliberately keeps its separate cookie-aware curl transport.
Set CANNY_HTTP_TRANSPORT=curl to use the temporary subprocess rollback path.
"""

from __future__ import annotations

import atexit
import io
import os
import re
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import canny_proxy

_context = threading.local()
_default_lock = threading.Lock()
_default_pool = None
_stats_lock = threading.Lock()
_new_connections = 0


def reset_stats():
    global _new_connections
    with _stats_lock:
        _new_connections = 0


def new_connections():
    """Successful new connections, including any created for redirects."""
    with _stats_lock:
        return _new_connections


def _record_connections(count):
    global _new_connections
    with _stats_lock:
        _new_connections += count


class ClientPool:
    """Own one connection-cache handle per thread and proxy configuration.

    The owner must join workers before closing the pool. FetchExecutor handles
    that ordering for the scraper's worker stages; client_scope owns main-thread
    calls. Handles and their connection caches never cross an auth boundary.
    """

    def __init__(self, backend=None):
        self.backend = backend or os.environ.get("CANNY_HTTP_TRANSPORT", "pooled")
        if self.backend not in ("pooled", "curl"):
            raise ValueError("CANNY_HTTP_TRANSPORT must be pooled or curl")
        self._local = threading.local()
        self._handles = []
        self._lock = threading.Lock()
        self._closed = False
        if self.backend == "pooled":
            # Lazy imports keep the rollback path usable without PycURL.
            import certifi
            import pycurl

            self._curl = pycurl
            self._ca_file = certifi.where()

    def close(self):
        with self._lock:
            self._closed = True
            for handle in self._handles:
                handle.close()
            self._handles.clear()

    def request(self, method, url, *, data=None, timeout=15, user_agent):
        if self._closed:
            raise RuntimeError("Canny HTTP pool is closed")
        # Resolve routing on every request, never from a previous handle's options.
        cfg = canny_proxy.load_config() if canny_proxy.proxied_url(url) else None
        if self.backend == "curl":
            return _subprocess_request(method, url, data, timeout, user_agent, cfg)
        curl = self._curl
        clients = getattr(self._local, "clients", None)
        if clients is None:
            clients = self._local.clients = {}
        handle = clients.get(cfg)
        if handle is None:
            handle = curl.Curl()
            clients[cfg] = handle
            with self._lock:
                self._handles.append(handle)

        # reset() clears request options, but retains live connections and DNS/TLS
        # caches. In particular a GET must not inherit the previous POST's body.
        handle.reset()
        body = io.BytesIO()
        handle.setopt(curl.URL, url)
        handle.setopt(curl.WRITEDATA, body)
        handle.setopt(curl.USERAGENT, user_agent)
        handle.setopt(curl.NOSIGNAL, 1)
        handle.setopt(curl.TIMEOUT_MS, max(1, int(timeout * 1000)))
        handle.setopt(curl.MAXCONNECTS, 4)
        handle.setopt(curl.TCP_KEEPALIVE, 1)
        handle.setopt(curl.TCP_KEEPIDLE, 60)
        handle.setopt(curl.TCP_KEEPINTVL, 60)
        handle.setopt(curl.CAINFO, self._ca_file)
        handle.setopt(curl.SSL_VERIFYPEER, 1)
        handle.setopt(curl.SSL_VERIFYHOST, 2)
        handle.setopt(curl.PROTOCOLS, curl.PROTO_HTTP | curl.PROTO_HTTPS)
        handle.setopt(curl.REDIR_PROTOCOLS, curl.PROTO_HTTP | curl.PROTO_HTTPS)
        # Neither ambient HTTP_PROXY nor NO_PROXY may override host routing.
        handle.setopt(curl.PROXY, cfg.host if cfg else "")
        handle.setopt(curl.NOPROXY, "")
        if cfg:
            handle.setopt(curl.PROXYPORT, cfg.port)
            handle.setopt(curl.PROXYTYPE, curl.PROXYTYPE_SOCKS5_HOSTNAME
                          if cfg.scheme == "socks5" else curl.PROXYTYPE_HTTP)
            handle.setopt(curl.PROXYUSERNAME, cfg.username)
            handle.setopt(curl.PROXYPASSWORD, cfg.password)
            handle.setopt(curl.PROXYAUTH, curl.HTTPAUTH_BASIC)
        if method == "GET":
            handle.setopt(curl.HTTPGET, 1)
            handle.setopt(curl.FOLLOWLOCATION, 1)
            handle.setopt(curl.MAXREDIRS, 50)
        else:
            handle.setopt(curl.POSTFIELDS, data)
            handle.setopt(curl.HTTPHEADER, ["Content-Type: application/json"])
        try:
            handle.perform()
            return handle.getinfo(curl.RESPONSE_CODE), body.getvalue().decode("utf-8", "replace")
        except curl.error:
            # Never log curl's URL/credentials or automatically bypass the proxy.
            # Caller-level retries and status accounting own the error policy.
            return 0, ""
        finally:
            _record_connections(handle.getinfo(curl.NUM_CONNECTS))
            # Drop the response callback/buffer now, keeping only connection state.
            handle.reset()


def _subprocess_request(method, url, data, timeout, user_agent, cfg):
    proxy_args = canny_proxy.curl_args_for(url) if cfg else ["--proxy", ""]
    cmd = ["curl", "-sS", *proxy_args, "--noproxy", "",
           "-H", f"User-Agent: {user_agent}", "-m", str(timeout)]
    if method == "GET":
        cmd.append("-L")
    else:
        cmd.extend(["-X", "POST", "-H", "Content-Type: application/json",
                    "--data-binary", data.decode("utf-8")])
    cmd.extend(["-w", "\n__HTTP_CODE__:%{http_code}\n__NEW_CONNECTIONS__:%{num_connects}", url])
    try:
        result = subprocess.run(cmd, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=timeout + 5)
    except (OSError, subprocess.TimeoutExpired):
        return 0, ""
    match = re.search(r"\n__HTTP_CODE__:(\d+)\n__NEW_CONNECTIONS__:(\d+)\s*$", result.stdout)
    if match:
        _record_connections(int(match[2]))
    if result.returncode or not match:
        return 0, ""
    return int(match[1]), result.stdout[:match.start()]


def current_pool():
    pool = getattr(_context, "pool", None)
    if pool is not None:
        return pool
    global _default_pool
    with _default_lock:
        if _default_pool is None:
            _default_pool = ClientPool()
        return _default_pool


def close_default_pool():
    """Release lazy clients used outside an explicit CLI/test scope."""
    global _default_pool
    with _default_lock:
        if _default_pool is not None:
            _default_pool.close()
            _default_pool = None


@contextmanager
def client_scope(backend=None):
    pool = ClientPool(backend)
    previous = getattr(_context, "pool", None)
    _context.pool = pool
    try:
        yield pool
    finally:
        pool.close()
        _context.pool = previous


def request(method, url, *, data=None, timeout=15, user_agent):
    return current_pool().request(method, url, data=data, timeout=timeout, user_agent=user_agent)


class FetchExecutor(ThreadPoolExecutor):
    """Stage-local clients, closed only after every worker has stopped."""

    def __init__(self, max_workers):
        self.http_pool = ClientPool(current_pool().backend)
        super().__init__(max_workers=max_workers, initializer=self._initialize_worker)

    def _initialize_worker(self):
        _context.pool = self.http_pool

    def shutdown(self, wait=True, *, cancel_futures=False):
        if not wait:
            raise ValueError("FetchExecutor must join workers before closing HTTP clients")
        super().shutdown(wait=True, cancel_futures=cancel_futures)
        self.http_pool.close()


atexit.register(close_default_pool)
