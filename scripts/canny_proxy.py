"""Optional sticky proxy for Canny hosts."""

from __future__ import annotations

import base64
import os
import re
import socket
import urllib.parse
from dataclasses import dataclass

DEFAULT_HOST = "proxyproxy.arpa.li"
DEFAULT_PORT = 1088
DEFAULT_SCHEME = "socks5"
DEFAULT_USER_PREFIX = "hackebein"
DEFAULT_SESSION = "feedbackvrchat"
_CHECK_HOST = "feedback.vrchat.com"
_CHECK_PORT = 443
_SESSION_RE = re.compile(r"[^A-Za-z0-9_-]")
_session_id: str | None = None


class CannyProxyError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProxyConfig:
    scheme: str
    host: str
    port: int
    username: str
    password: str

    def __repr__(self) -> str:
        return (
            f"ProxyConfig(scheme={self.scheme!r}, host={self.host!r}, "
            f"port={self.port})"
        )


def reset_state() -> None:
    global _session_id
    _session_id = None


def session_id() -> str:
    global _session_id
    if _session_id is None:
        _session_id = _session_from_env()
    return _session_id


def load_config() -> ProxyConfig | None:
    password = os.environ.get("CANNY_PROXY_PASSWORD") or ""
    password = password.strip()
    if not password:
        return None
    scheme = _scheme()
    host = (os.environ.get("CANNY_PROXY_HOST") or DEFAULT_HOST).strip() or DEFAULT_HOST
    if any(ch in host for ch in " \t\r\n/@"):
        raise CannyProxyError("invalid proxy host")
    port = _port()
    prefix = _SESSION_RE.sub("", os.environ.get("CANNY_PROXY_USER_PREFIX") or "")[:64]
    if not prefix:
        prefix = DEFAULT_USER_PREFIX
    username = f"{prefix}.{session_id()}"
    if len(username.encode()) > 255 or len(password.encode()) > 255:
        raise CannyProxyError("proxy credentials are too long")
    return ProxyConfig(
        scheme=scheme,
        host=host,
        port=port,
        username=username,
        password=password,
    )


def curl_args() -> list[str]:
    cfg = load_config()
    if cfg is None:
        return []
    user = f"{cfg.username}:{cfg.password}"
    if cfg.scheme == "socks5":
        return [
            "--socks5-hostname",
            f"{cfg.host}:{cfg.port}",
            "--proxy-user",
            user,
        ]
    if cfg.scheme == "http":
        return [
            "--proxy",
            f"http://{cfg.host}:{cfg.port}",
            "--proxy-user",
            user,
        ]
    raise CannyProxyError("unsupported proxy scheme")


def proxied_url(url: str) -> bool:
    host = (urllib.parse.urlparse(url).hostname or "").lower().rstrip(".")
    return host == _CHECK_HOST or host == "canny.io" or host.endswith(".canny.io")


def curl_args_for(url: str) -> list[str]:
    if not proxied_url(url):
        return []
    return curl_args()


def require_proxy() -> None:
    cfg = load_config()
    if cfg is None:
        return
    try:
        if cfg.scheme == "socks5":
            _socks5_check(cfg)
        elif cfg.scheme == "http":
            _http_check(cfg)
        else:
            raise CannyProxyError("unsupported proxy scheme")
    except CannyProxyError:
        raise
    except OSError:
        raise CannyProxyError(f"{cfg.scheme} connection failed") from None
    print(f"[proxy] {cfg.scheme} connected")


def transport_from_trace(trace: str) -> str:
    if "SOCKS5 request granted" in trace:
        return "socks5h"
    if "CONNECT tunnel established" in trace:
        return "http"
    return "direct"


def proxy_diag_line(label: str, trace: str, *, configured: bool, http_code: int) -> str:
    via = transport_from_trace(trace)
    if configured and via == "direct":
        via = "unconfirmed"
    if not re.fullmatch(r"[a-z0-9-]{1,32}", label or ""):
        label = "request"
    return f"[proxy] {label} via={via} http={int(http_code)}"


def redact(text: str) -> str:
    if not text:
        return text
    password = (os.environ.get("CANNY_PROXY_PASSWORD") or "").strip()
    if password:
        text = text.replace(password, "***")
    try:
        cfg = load_config()
    except CannyProxyError:
        cfg = None
    if cfg is not None and cfg.username:
        text = text.replace(cfg.username, "***")
    return text


def _scheme() -> str:
    raw = (os.environ.get("CANNY_PROXY_SCHEME") or DEFAULT_SCHEME).strip().lower()
    if raw in ("socks5", "socks5h"):
        return "socks5"
    if raw == "http":
        return "http"
    raise CannyProxyError("unsupported proxy scheme")


def _port() -> int:
    raw = (os.environ.get("CANNY_PROXY_PORT") or str(DEFAULT_PORT)).strip()
    try:
        port = int(raw)
    except ValueError:
        raise CannyProxyError("invalid proxy port") from None
    if port < 1 or port > 65535:
        raise CannyProxyError("invalid proxy port")
    return port


def _session_from_env() -> str:
    safe = _SESSION_RE.sub("", os.environ.get("CANNY_PROXY_SESSION") or "")[:64]
    return safe or DEFAULT_SESSION


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise CannyProxyError("proxy closed the connection")
        buf += chunk
    return buf


def _socks5_check(cfg: ProxyConfig, timeout: float = 15) -> None:
    with socket.create_connection((cfg.host, cfg.port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(b"\x05\x01\x02")
        ver, method = _recv_exact(sock, 2)
        if ver != 5 or method != 2:
            raise CannyProxyError("socks5 connection failed")
        user = cfg.username.encode()
        password = cfg.password.encode()
        sock.sendall(bytes([1, len(user)]) + user + bytes([len(password)]) + password)
        aver, status = _recv_exact(sock, 2)
        if aver != 1 or status != 0:
            raise CannyProxyError("socks5 authentication failed")
        host = _CHECK_HOST.encode()
        sock.sendall(
            bytes([5, 1, 0, 3, len(host)]) + host + _CHECK_PORT.to_bytes(2, "big")
        )
        reply = _recv_exact(sock, 4)
        if reply[0] != 5 or reply[1] != 0:
            raise CannyProxyError("socks5 connection failed")
        atyp = reply[3]
        if atyp == 1:
            _recv_exact(sock, 6)
        elif atyp == 3:
            length = _recv_exact(sock, 1)[0]
            _recv_exact(sock, length + 2)
        elif atyp == 4:
            _recv_exact(sock, 18)
        else:
            raise CannyProxyError("socks5 connection failed")


def _http_check(cfg: ProxyConfig, timeout: float = 15) -> None:
    token = base64.b64encode(f"{cfg.username}:{cfg.password}".encode()).decode("ascii")
    req = (
        f"CONNECT {_CHECK_HOST}:{_CHECK_PORT} HTTP/1.1\r\n"
        f"Host: {_CHECK_HOST}:{_CHECK_PORT}\r\n"
        f"Proxy-Authorization: Basic {token}\r\n"
        "\r\n"
    ).encode()
    with socket.create_connection((cfg.host, cfg.port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(req)
        data = b""
        while b"\r\n" not in data and len(data) < 128:
            chunk = sock.recv(128 - len(data))
            if not chunk:
                break
            data += chunk
    line = data.split(b"\r\n", 1)[0].decode("latin1", errors="replace")
    parts = line.split(" ")
    code = parts[1] if len(parts) > 1 and parts[1].isdigit() else ""
    if code == "200":
        return
    if code == "407":
        raise CannyProxyError("http authentication failed")
    raise CannyProxyError("http connection failed")
