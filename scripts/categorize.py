#!/usr/bin/env python3
"""
MiniMax-based post categorization against feature_tree.json at repo root.

Used by update.py. Requires MINIMAX_API_KEY in the environment for live calls.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TREE_PATH = ROOT / "feature_tree.json"
DEFAULT_MINIMAX_CHAT_URL = "https://api.minimax.io/v1/chat/completions"

try:
    import in_client_report
except ImportError:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import in_client_report

# Bump when taxonomy or classifier prompts change materially (forces re-tag).
DEFAULT_TAXONOMY_VERSION = 3

MAX_DETAILS_CHARS = 12_000
MAX_COMMENT_BLOCK_CHARS = 8_000
MAX_COMMENT_LINES = 20
MAX_COMMENT_VALUE_CHARS = 1_500
MAX_CHAT_HTTP_RETRIES = 3
MAX_VALIDATION_ROUNDS = 4
MIN_RATE_LIMIT_BACKOFF = 2.0
MAX_RATE_LIMIT_BACKOFF = 30.0
MAX_RATE_LIMIT_RETRIES = 6


def _minimax_rate_limit_cooldown() -> float:
    raw = (os.environ.get("MINIMAX_RATE_LIMIT_COOLDOWN") or "").strip()
    if raw:
        try:
            return max(1.0, float(raw))
        except ValueError:
            pass
    return MAX_RATE_LIMIT_BACKOFF


class _MiniMaxRateLimiter:
    """Adaptive backoff shared across worker threads after HTTP 429.

    On 429 the shared cooldown window grows exponentially (with jitter) so all
    threads briefly pause together, then resume at safe concurrency. On clean
    responses the backoff decays back toward zero. A burst 429 is recoverable,
    so it never permanently stops AI tagging.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._cooldown_until = 0.0
        self._backoff = 0.0
        self.rate_limit_hits = 0
        self.stop_requested = False

    def wait(self):
        with self._lock:
            sleep_for = max(0.0, self._cooldown_until - time.time())
        if sleep_for > 0:
            time.sleep(sleep_for)

    def hit_429(self, body: str = ""):
        with self._lock:
            self.rate_limit_hits += 1
            cap = _minimax_rate_limit_cooldown()
            self._backoff = min(max(self._backoff * 2.0, MIN_RATE_LIMIT_BACKOFF), cap)
            jitter = self._backoff * 0.25 * (os.urandom(1)[0] / 255.0)
            self._cooldown_until = max(
                self._cooldown_until, time.time() + self._backoff + jitter,
            )

    def ok(self):
        with self._lock:
            self._backoff = max(0.0, self._backoff * 0.5)

    def reset_hits(self):
        with self._lock:
            self.rate_limit_hits = 0
            self.stop_requested = False
            self._backoff = 0.0
            self._cooldown_until = 0.0


_MINIMAX_LIMITER = _MiniMaxRateLimiter()


def _in_ci() -> bool:
    return (os.environ.get("CI") or "").strip().lower() in ("1", "true")

BOARD_LOCATION_PRIORS: dict[str, str] = {
    "website": "loc.website",
    "udon": "loc.unity-sdk",
    "sdk-bug-reports": "loc.unity-sdk",
    "ios-mobile-beta": "loc.mobile-app",
    "android": "loc.mobile-app",
    "open-beta": "loc.pc-client",
    "client-bug-reporting": "loc.pc-client",
    "creator-companion": "loc.creator-companion",
    "avatar-30": "loc.in-world",
    "impostors": "loc.in-world",
    "age-verification": "loc.website",
    "localization": "loc.main-menu",
}

BOARD_FEATURE_PRIORS: dict[str, str] = {
    "website": "web.home",
    "udon": "sdk.udon",
    "sdk-bug-reports": "sdk.vrcsdk",
    "ios-mobile-beta": "platforms.mobile.ios",
    "android": "platforms.mobile.android",
    "open-beta": "platforms.pc.steam",
    "creator-companion": "sdk.vpm",
    "avatar-30": "avatars",
    "localization": "localization",
    "age-verification": "account.age-verification",
    "persistence": "worlds.persistence",
    "vrchat-ik-20": "avatars.fbt",
    "third-person-view": "client.third-person",
}

FEW_SHOT_EXAMPLES = """
Examples (input gist -> correct JSON categories):
- "Can't reset my password on vrchat.com" -> {"categories": ["loc.website", "web.auth", "account.auth"]}
- "World search on the website shows wrong player capacity" -> {"categories": ["loc.website", "web.worlds"]}
- "Udon node missing for Vector3 distance" -> {"categories": ["loc.unity-sdk", "sdk.udon"]}
- "VRChat should hire more moderators" -> {"categories": ["vrchat-meta"]}
- "My friend blocked me, please unblock" -> {"categories": ["user-support"]}
- "Avatars fail to load for everyone after update" -> {"categories": ["loc.in-world", "loc.loading-screen", "avatars.upload-performance"]}
- "No voice audio in instances" -> {"categories": ["loc.in-world", "audio.voice"]}
- "Login loop on website Safari" -> {"categories": ["loc.website", "web.auth"]}
- "PhysBone colliders wrong in SDK" -> {"categories": ["loc.unity-sdk", "avatars.dynamics"]}
- "Quest 2 crashes on startup in VR" -> {"categories": ["loc.standalone-vr", "platforms.standalone-vr.quest", "client.settings"]}
- "Android phone push notifications broken" -> {"categories": ["loc.mobile-app", "platforms.mobile.android", "client.settings"]}
- "SteamVR avatar fails to load on PC" -> {"categories": ["loc.pc-client", "platforms.pc.steam", "avatars.upload-performance"]}
- "Pico headset audio too quiet" -> {"categories": ["loc.standalone-vr", "platforms.standalone-vr.pico", "audio.voice"]}
""".strip()


def _minimax_chat_url() -> str:
    u = (os.environ.get("MINIMAX_API_URL") or "").strip()
    return u if u else DEFAULT_MINIMAX_CHAT_URL


def _minimax_model() -> str:
    return (os.environ.get("MINIMAX_MODEL") or "MiniMax-M3").strip()


def _minimax_max_tokens() -> int:
    raw = (os.environ.get("MINIMAX_MAX_TOKENS") or "").strip()
    if raw:
        try:
            return max(64, int(raw))
        except ValueError:
            pass
    # The classifier emits a small JSON object; capping output saves quota
    # (output tokens are billed ~4x input on the Token Plan).
    return 512


USER_AGENT = "Mozilla/5.0 (compatible; VRChatFeedbackArchiver/1.0)"

_missing_key_warned = False
_missing_tree_warned = False
_minimax_401_warned = False
_warn_lock = threading.Lock()
_tree_lock = threading.Lock()
_cached_tree: dict | None = None

_TAG_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```")
_THINKING_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


def _strip_minimax_thinking(text: str) -> str:
    if not text:
        return text
    return _THINKING_RE.sub("", text).strip()


def iso_now_z():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def taxonomy_version(tree: dict | None = None) -> int:
    if tree is not None:
        raw = tree.get("raw") or {}
        v = raw.get("taxonomyVersion")
        if isinstance(v, int) and v > 0:
            return v
    if DEFAULT_TREE_PATH.exists():
        try:
            raw = json.loads(DEFAULT_TREE_PATH.read_text(encoding="utf-8"))
            v = raw.get("taxonomyVersion")
            if isinstance(v, int) and v > 0:
                return v
        except Exception:
            pass
    return DEFAULT_TAXONOMY_VERSION


def _warn_missing_key():
    global _missing_key_warned
    with _warn_lock:
        if not _missing_key_warned:
            print("[WARN] MINIMAX_API_KEY unset; AI categorization skipped for posts that need tagging")
            _missing_key_warned = True


def _warn_minimax_401_once(key_len: int) -> None:
    global _minimax_401_warned
    with _warn_lock:
        if _minimax_401_warned:
            return
        _minimax_401_warned = True
        print("[WARN] MiniMax returned HTTP 401 (login fail).")


def _warn_missing_tree(msg: str):
    global _missing_tree_warned
    with _warn_lock:
        if not _missing_tree_warned:
            print(f"[WARN] {msg}")
            _missing_tree_warned = True


def _walk_features(nodes, out_flat: set[str], parent: str | None, parent_map: dict[str, str]):
    if not isinstance(nodes, list):
        return
    for n in nodes:
        if not isinstance(n, dict):
            continue
        nid = n.get("id")
        if isinstance(nid, str) and nid.strip():
            fid = nid.strip()
            out_flat.add(fid)
            if parent:
                parent_map[fid] = parent
        ch = n.get("children")
        if isinstance(ch, list):
            _walk_features(ch, out_flat, nid.strip() if isinstance(nid, str) else parent, parent_map)


def load_tree(path: Path | None = None) -> dict | None:
    """Load taxonomy; return enriched dict or None."""
    global _cached_tree
    p = path or DEFAULT_TREE_PATH
    with _tree_lock:
        if _cached_tree is not None and (path is None or Path(path) == DEFAULT_TREE_PATH):
            return _cached_tree
        if not p.exists():
            _warn_missing_tree(f"Feature tree missing: {p}")
            return None
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            _warn_missing_tree(f"Failed to read feature tree {p}: {e}")
            return None

        bucket_ids: set[str] = set()
        for b in raw.get("buckets") or []:
            if isinstance(b, dict):
                bid = b.get("id")
                if isinstance(bid, str) and bid.strip():
                    bucket_ids.add(bid.strip())

        location_ids: set[str] = set()
        for loc in raw.get("locations") or []:
            if isinstance(loc, dict):
                lid = loc.get("id")
                if isinstance(lid, str) and lid.strip():
                    location_ids.add(lid.strip())

        feature_ids: set[str] = set()
        feature_parent: dict[str, str] = {}
        _walk_features(raw.get("features") if isinstance(raw.get("features"), list) else [], feature_ids, None, feature_parent)

        top_level_features: list[str] = []
        feats_root = raw.get("features")
        if isinstance(feats_root, list):
            for n in feats_root:
                if isinstance(n, dict):
                    fid = n.get("id")
                    if isinstance(fid, str) and fid.strip():
                        top_level_features.append(fid.strip())

        collide = (
            (feature_ids & bucket_ids)
            | (feature_ids & location_ids)
            | (bucket_ids & location_ids)
        )
        if collide:
            _warn_missing_tree(f"Feature tree ids overlap across buckets/locations/features: {sorted(collide)[:10]}")
            return None

        bad_loc = {fid for fid in feature_ids if fid.startswith("loc.")}
        if bad_loc:
            _warn_missing_tree(f"Feature tree: feature ids must not use loc.* prefix: {sorted(bad_loc)[:10]}")
            return None

        flat_ids = bucket_ids | location_ids | feature_ids
        bundle = {
            "raw": raw,
            "flat_ids": flat_ids,
            "bucket_ids": bucket_ids,
            "location_ids": location_ids,
            "feature_ids": feature_ids,
            "feature_parent": feature_parent,
            "top_level_features": top_level_features,
            "taxonomy_version": taxonomy_version({"raw": raw}),
        }
        if path is None:
            _cached_tree = bundle
        return bundle


def _is_feature_ancestor(ancestor: str, node: str, parent_map: dict[str, str]) -> bool:
    p = parent_map.get(node)
    while p:
        if p == ancestor:
            return True
        p = parent_map.get(p)
    return False


def _strip_parent_feature_ids(categories: list[str], tree: dict) -> list[str]:
    feature_ids = tree["feature_ids"]
    parent_map = tree["feature_parent"]
    feats = [c for c in categories if c in feature_ids]
    others = [c for c in categories if c not in feature_ids]
    feat_set = set(feats)
    kept = [
        f
        for f in feats
        if not any(_is_feature_ancestor(f, g, parent_map) for g in feat_set if g != f)
    ]
    return others + kept


def _normalize_categories(categories: list[str], tree: dict) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for c in categories:
        if c not in seen:
            seen.add(c)
            deduped.append(c)
    return _strip_parent_feature_ids(deduped, tree)


def _shared_rules_lines() -> list[str]:
    return [
        "If a Comments: section is provided, treat it as additional context "
        "(status changes, follow-ups, merged posts). Classify the original feedback, not the comments alone.",
        "",
        "user-support is ONLY for one-off personal help (password recovery, account recovery, "
        "\"my friend banned me\"). Reproducible bugs—even in first person—are product feedback: "
        "login failures, no audio, failed loads, crashes, connectivity, missing features.",
        "",
        "loc.in-world is ONLY for issues inside a running instance. Use loc.website for vrchat.com, "
        "loc.unity-sdk for Unity/SDK, loc.login for client login screens.",
        "",
        "Platform clients (three separate categories):",
        "  Mobile (phone): loc.mobile-app + platforms.mobile.ios or platforms.mobile.android (App Store / Google Play).",
        "  Standalone VR: loc.standalone-vr + platforms.standalone-vr.quest or platforms.standalone-vr.pico.",
        "    Meta Quest runs Android internally but is NOT the phone mobile app—never use loc.mobile-app for Quest.",
        "  PC & PCVR: loc.pc-client + platforms.pc.steam, platforms.pc.viveport, or platforms.pc.desktop.",
        "Tag a platform when the post is specific to that client; use platforms.cross-platform for parity across types.",
        "",
        "For website issues use loc.website AND a web.* feature (web.worlds, web.profiles, web.social, etc.).",
        "Never tag both a parent feature and its child—use leaf ids only.",
        "",
        FEW_SHOT_EXAMPLES,
    ]


_singlepass_prompt_cache: dict[int, str] = {}


def build_system_prompt(tree: dict | None) -> str:
    """Constant, cacheable single-pass classification prompt.

    Lists the whole taxonomy (buckets + locations + features) and asks for the
    final categories in one call. It is byte-identical across every post
    (memoized per taxonomy version) so MiniMax passive prompt caching reuses the
    system-prompt prefix; only the per-post user message is billed at full price.
    """
    if not tree:
        return ""
    ver = tree.get("taxonomy_version") or taxonomy_version(tree)
    cached = _singlepass_prompt_cache.get(ver)
    if cached is not None:
        return cached
    raw = tree["raw"]
    lines = [
        "You classify VRChat Canny feedback posts.",
        'Return ONLY valid JSON: {"categories": ["id", ...]} with no other keys.',
        "Output EITHER exactly one bucket id alone, OR at least one loc.* id plus "
        "at least one leaf feature id.",
        "Use leaf feature ids only. List every location where the issue manifests.",
        "If truly not classifiable, return {\"categories\": []}.",
        "",
        "Rules:",
        *_shared_rules_lines(),
        "",
        "Buckets (use one alone; id: description):",
    ]
    for b in raw.get("buckets") or []:
        if isinstance(b, dict) and b.get("id"):
            lines.append(f"  {b['id']}: {(b.get('description') or '').strip()}")
    lines.append("")
    lines.append("Locations (id: name — description):")

    def fmt_nodes(nodes_list, indent: int = 0):
        pad = "  " * indent
        for n in nodes_list or []:
            if not isinstance(n, dict):
                continue
            nid = n.get("id", "")
            name = (n.get("name") or "").strip()
            desc = (n.get("description") or "").strip()
            lines.append(f"{pad}{nid}: /{name}/ — {desc}")
            ch = n.get("children")
            if isinstance(ch, list) and ch:
                fmt_nodes(ch, indent + 1)

    fmt_nodes(raw.get("locations") if isinstance(raw.get("locations"), list) else [])
    lines.append("")
    lines.append("Features (id: name — description):")
    fmt_nodes(raw.get("features") if isinstance(raw.get("features"), list) else [])
    s = "\n".join(lines)
    _singlepass_prompt_cache[ver] = s
    return s


def is_stale_taxonomy(post: dict | None) -> bool:
    if not post:
        return False
    tagged_ver = post.get("aiTaxonomyVersion")
    if tagged_ver is None:
        return post.get("aiTaggedAt") is not None
    try:
        return int(tagged_ver) != taxonomy_version()
    except (TypeError, ValueError):
        return True


def needs_retag(post: dict | None) -> bool:
    """True when a stored post should be (re)classified by retag-ai."""
    if not post:
        return False
    if not post.get("aiTaggedAt"):
        return True
    return is_stale_taxonomy(post)


def clear_ai_tags_for_retag(post: dict) -> bool:
    """Clear AI tag fields so the post will be re-classified. Returns True if modified."""
    had = post.get("aiTaggedAt") is not None or post.get("aiCategories") is not None
    post.pop("aiTaggedAt", None)
    post.pop("aiTaxonomyVersion", None)
    if post.get("aiCategories") is not None:
        post["aiCategories"] = []
        return True
    return had


def sanitize_ai_tags(post: dict, tree: dict | None) -> bool:
    """Remove stale/unknown ids and normalize. Returns True if post was modified."""
    if not tree:
        return False
    modified = False
    if is_stale_taxonomy(post):
        if clear_ai_tags_for_retag(post):
            modified = True

    raw = post.get("aiCategories")
    if raw is None:
        return modified

    flat = tree["flat_ids"]

    if not isinstance(raw, list):
        post["aiCategories"] = []
        post.pop("aiTaggedAt", None)
        post.pop("aiTaxonomyVersion", None)
        return True

    malformed = any(not isinstance(x, str) for x in raw) or any(
        isinstance(x, str) and not x.strip() for x in raw
    )

    original: list[str] = []
    for x in raw:
        if isinstance(x, str) and x.strip():
            original.append(x.strip())

    cleaned: list[str] = []
    seen: set[str] = set()
    for c in original:
        if c not in flat:
            continue
        if c not in seen:
            seen.add(c)
            cleaned.append(c)

    cleaned = _normalize_categories(cleaned, tree)
    unknown_removed = any(c not in flat for c in original)

    if malformed or unknown_removed or cleaned != original:
        post["aiCategories"] = cleaned
        post.pop("aiTaggedAt", None)
        post.pop("aiTaxonomyVersion", None)
        return True

    return modified


def _comment_ids(post: dict | None) -> set[str]:
    out: set[str] = set()
    if not post:
        return out
    for c in post.get("comments") or []:
        if isinstance(c, dict):
            cid = c.get("_id")
            if isinstance(cid, str) and cid:
                out.add(cid)
    return out


def needs_ai_retag(previous_post: dict | None, current_post: dict | None) -> bool:
    if current_post is None:
        return False
    if previous_post is None:
        return True
    if is_stale_taxonomy(previous_post):
        return True
    if not previous_post.get("aiTaggedAt"):
        return True
    if (
        previous_post.get("title"),
        previous_post.get("details"),
        previous_post.get("status"),
    ) != (
        current_post.get("title"),
        current_post.get("details"),
        current_post.get("status"),
    ):
        return True
    if _comment_ids(current_post) - _comment_ids(previous_post):
        return True
    return False


def carry_over_ai_tags(target: dict, previous: dict | None) -> None:
    if not previous:
        return
    for key in ("aiCategories", "aiTaggedAt", "aiTaxonomyVersion"):
        if key in previous:
            target[key] = previous[key]


def _urllib_post_minimax(url: str, bearer: str, payload: dict, timeout: int) -> tuple[int, str]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    req.add_header("Authorization", f"Bearer {bearer}")
    req.add_header("User-Agent", USER_AGENT)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, body
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return e.code, err_text
    except urllib.error.URLError as e:
        return 0, str(e.reason if getattr(e, "reason", None) else e)
    except Exception as e:
        return 0, str(e)


def _extract_json_text(text: str) -> str | None:
    if not text or not text.strip():
        return None
    s = text.strip()
    m = _TAG_RE.search(s)
    if m:
        s = m.group(1).strip()
    try:
        json.loads(s)
        return s
    except Exception:
        pass
    i = s.find("{")
    if i < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for j in range(i, len(s)):
        ch = s[j]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    chunk = s[i : j + 1]
                    try:
                        json.loads(chunk)
                        return chunk
                    except Exception:
                        return None
    return None


def _parse_json_object(body: str) -> tuple[dict | None, str | None]:
    try:
        data = json.loads(body)
    except Exception:
        return None, "response not JSON"
    if isinstance(data, dict) and data.get("error"):
        return None, str(data.get("error"))
    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices or not isinstance(choices, list):
        return None, "no choices in response"
    msg = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
    content = msg.get("content") if isinstance(msg, dict) else None
    if not isinstance(content, str):
        return None, "no message content"
    content = _strip_minimax_thinking(content)
    chunk = _extract_json_text(content)
    if not chunk:
        return None, "assistant content not JSON"
    try:
        obj = json.loads(chunk)
    except Exception as e:
        return None, f"parse inner json: {e}"
    if not isinstance(obj, dict):
        return None, "JSON root must be object"
    return obj, None


def _parse_categories_from_response(body: str) -> tuple[list[str] | None, str | None]:
    obj, err = _parse_json_object(body)
    if err or obj is None:
        return None, err
    cats = obj.get("categories")
    if cats is None:
        return None, "missing categories key"
    if not isinstance(cats, list):
        return None, "categories must be a list"
    out: list[str] = []
    for x in cats:
        if isinstance(x, str) and x.strip():
            out.append(x.strip())
    return out, None


def _validate_categories(
    categories: list[str],
    tree: dict,
    *,
    normalize: bool = True,
) -> tuple[list[str] | None, str | None]:
    if normalize:
        categories = _normalize_categories(categories, tree)
    flat = tree["flat_ids"]
    bucket_ids = tree["bucket_ids"]
    location_ids = tree["location_ids"]
    feature_ids = tree["feature_ids"]

    for c in categories:
        if c not in flat:
            return None, f"unknown category id: {c!r}"
    if not categories:
        return [], None
    has_bucket = any(c in bucket_ids for c in categories)
    if has_bucket:
        if len(categories) != 1:
            return None, "bucket id must be alone"
        return categories, None
    has_loc = any(c in location_ids for c in categories)
    has_feat = any(c in feature_ids for c in categories)
    if not has_loc:
        return None, "product feedback needs at least one location id (loc.*)"
    if not has_feat:
        return None, "product feedback needs at least one feature id"
    return categories, None


def _fallback_categories(
    categories: list[str],
    tree: dict,
    board_slug: str,
    *,
    location_prior: str | None = None,
) -> list[str]:
    """Best-effort salvage when strict validation fails."""
    flat = tree["flat_ids"]
    bucket_ids = tree["bucket_ids"]
    location_ids = tree["location_ids"]
    feature_ids = tree["feature_ids"]

    cats = _normalize_categories([c for c in categories if c in flat], tree)
    if cats and all(c in bucket_ids for c in cats) and len(cats) == 1:
        return cats

    locs = [c for c in cats if c in location_ids]
    feats = [c for c in cats if c in feature_ids]

    if not locs:
        prior = location_prior or BOARD_LOCATION_PRIORS.get(board_slug)
        if prior and prior in location_ids:
            locs = [prior]

    if not feats:
        prior = BOARD_FEATURE_PRIORS.get(board_slug)
        if prior and prior in feature_ids:
            feats = [prior]
        elif locs:
            feats = ["client.settings"]

    if locs and feats:
        return _normalize_categories(locs + feats, tree)
    return []


_usage_lock = threading.Lock()
_usage_accum = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0}
_usage_enabled = False


def reset_usage_tracking(enable: bool = True) -> None:
    """Start/stop accumulating per-call token usage (used by the eval harness)."""
    global _usage_enabled
    with _usage_lock:
        _usage_enabled = enable
        for k in _usage_accum:
            _usage_accum[k] = 0


def get_usage() -> dict:
    with _usage_lock:
        return dict(_usage_accum)


# MiniMax-M3 Token Plan list price (USD / 1M tokens): input / cached-read / output.
_M3_PRICE_INPUT = 0.60
_M3_PRICE_CACHED = 0.12
_M3_PRICE_OUTPUT = 2.40


def usage_cost(usage: dict | None = None) -> float:
    """Estimated USD cost of accumulated usage at MiniMax-M3 Token Plan prices."""
    u = usage if usage is not None else get_usage()
    prompt = u.get("prompt_tokens", 0)
    cached = u.get("cached_tokens", 0)
    new_in = max(0, prompt - cached)
    out = u.get("completion_tokens", 0)
    return (new_in * _M3_PRICE_INPUT + cached * _M3_PRICE_CACHED + out * _M3_PRICE_OUTPUT) / 1_000_000.0


def format_usage_stats(prefix: str = "[USAGE]") -> str:
    """One-line summary of accumulated token usage, cache hit rate and est. cost."""
    u = get_usage()
    calls = u.get("calls", 0)
    prompt = u.get("prompt_tokens", 0)
    cached = u.get("cached_tokens", 0)
    out = u.get("completion_tokens", 0)
    total = prompt + out
    hit = (100.0 * cached / prompt) if prompt else 0.0
    return (
        f"{prefix} calls={calls} prompt_tokens={prompt:,} cached_tokens={cached:,} "
        f"({hit:.0f}% cache hit) completion_tokens={out:,} total_tokens={total:,} "
        f"est_cost=${usage_cost(u):.4f}"
    )


def _record_usage(body: str) -> None:
    if not _usage_enabled:
        return
    try:
        u = (json.loads(body) or {}).get("usage") or {}
    except Exception:
        return
    if not isinstance(u, dict):
        return
    cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
    with _usage_lock:
        _usage_accum["calls"] += 1
        _usage_accum["prompt_tokens"] += int(u.get("prompt_tokens") or 0)
        _usage_accum["completion_tokens"] += int(u.get("completion_tokens") or 0)
        _usage_accum["cached_tokens"] += int(cached)


def _minimax_chat(api_key: str, system_prompt: str, user_prompt: str) -> tuple[int, str]:
    env_key = (os.environ.get("MINIMAX_API_KEY") or "").strip()
    if env_key:
        api_key = env_key
    api_key = api_key.strip()
    if not api_key:
        return 0, '{"error":"missing MINIMAX_API_KEY in environment"}'
    payload = {
        "model": _minimax_model(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "max_completion_tokens": _minimax_max_tokens(),
        "thinking": {"type": "disabled"},
    }
    _MINIMAX_LIMITER.wait()
    code, body = _urllib_post_minimax(_minimax_chat_url(), api_key, payload, timeout=90)
    if code == 429:
        _MINIMAX_LIMITER.hit_429(body)
    elif code == 200:
        _MINIMAX_LIMITER.ok()
        _record_usage(body)
    return code, body


def minimax_rate_limit_hits() -> int:
    return _MINIMAX_LIMITER.rate_limit_hits


def minimax_stop_requested() -> bool:
    return _MINIMAX_LIMITER.stop_requested


def should_stop_ai_tagging(api_key: str | None = None) -> bool:
    # 429s are transient and handled by per-request backoff+retry, so we never
    # abort the whole run on a rate limit; only an explicit stop request stops.
    return _MINIMAX_LIMITER.stop_requested


def reset_minimax_rate_limit_hits() -> None:
    _MINIMAX_LIMITER.reset_hits()


def probe_minimax(api_key: str | None = None) -> bool:
    """Return True when MiniMax accepts a minimal chat request (not rate limited)."""
    eff = (os.environ.get("MINIMAX_API_KEY") or "").strip() or (api_key or "").strip()
    if not eff:
        return False
    payload = {
        "model": _minimax_model(),
        "messages": [
            {"role": "system", "content": "Reply with OK."},
            {"role": "user", "content": "OK"},
        ],
        "temperature": 0.1,
        "max_completion_tokens": 16,
        "thinking": {"type": "disabled"},
    }
    code, _ = _urllib_post_minimax(_minimax_chat_url(), eff, payload, timeout=30)
    return code == 200


def wait_for_minimax_quota(api_key: str | None = None) -> bool:
    """Wait one cooldown window, then probe. Return True if quota is available."""
    cooldown = _minimax_rate_limit_cooldown()
    print(f"[UPDATE] Waiting {cooldown:.0f}s for MiniMax quota...")
    time.sleep(cooldown)
    reset_minimax_rate_limit_hits()
    if probe_minimax(api_key):
        print("[UPDATE] MiniMax quota available again")
        return True
    print("[UPDATE] MiniMax rate limit persists after cooldown")
    return False


def _truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 20].rstrip() + "\n… [truncated]"


def _comment_row_has_content(c: dict) -> bool:
    v = c.get("value")
    if isinstance(v, str) and v.strip():
        return True
    st = c.get("statusChangeNewStatus")
    if isinstance(st, str) and st.strip():
        return True
    mt = c.get("mergedPostTitle")
    if isinstance(mt, str) and mt.strip():
        return True
    md = c.get("mergedPostDetails")
    if isinstance(md, str) and md.strip():
        return True
    return False


def _author_display_name(author) -> str:
    if not isinstance(author, dict):
        return "unknown"
    name = author.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    alias = author.get("alias")
    if isinstance(alias, str) and alias.strip():
        return alias.strip()
    return "unknown"


def _build_comments_prompt_block(post: dict) -> str:
    comments = post.get("comments") or []
    if not isinstance(comments, list):
        return ""

    rows: list[tuple[str, str]] = []
    for c in comments:
        if not isinstance(c, dict) or not _comment_row_has_content(c):
            continue
        created = c.get("created")
        created_s = created.strip() if isinstance(created, str) else ""
        who = _author_display_name(c.get("author"))
        prefix = f"[{created_s}] {who}" if created_s else who

        parts: list[str] = []
        st = c.get("statusChangeNewStatus")
        if isinstance(st, str) and st.strip():
            parts.append(f"[status -> {st.strip()}]")
        mt = c.get("mergedPostTitle")
        md = c.get("mergedPostDetails")
        m_t = mt.strip() if isinstance(mt, str) and mt.strip() else ""
        m_d = md.strip() if isinstance(md, str) and md.strip() else ""
        if m_t or m_d:
            esc_t = m_t.replace('"', '\\"')
            if m_d:
                parts.append(f'[merged from "{esc_t}": {_truncate_text(m_d, 400)}]')
            else:
                parts.append(f'[merged from "{esc_t}"]')
        v = c.get("value")
        if isinstance(v, str) and v.strip():
            parts.append(_truncate_text(v.strip(), MAX_COMMENT_VALUE_CHARS))

        rows.append((created_s, f"{prefix}: {' '.join(parts)}"))

    if not rows:
        return ""

    rows.sort(key=lambda r: r[0])
    if len(rows) > MAX_COMMENT_LINES:
        rows = rows[-MAX_COMMENT_LINES:]
        omitted = len(comments) - MAX_COMMENT_LINES
        header = f"\nComments (showing last {MAX_COMMENT_LINES} of {omitted + MAX_COMMENT_LINES}):\n"
    else:
        header = "\nComments:\n"

    block = header + "\n".join(line for _, line in rows) + "\n"
    return _truncate_text(block, MAX_COMMENT_BLOCK_CHARS)


def _post_category_name(post: dict) -> str:
    cat = post.get("category")
    if isinstance(cat, dict):
        name = cat.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return ""


def _attachment_note(post: dict) -> str:
    images = post.get("imageURLs")
    files = post.get("fileURLs")
    n_img = len(images) if isinstance(images, list) else 0
    n_file = len(files) if isinstance(files, list) else 0
    n = n_img + n_file
    if n <= 0:
        return ""
    parts = []
    if n_img:
        parts.append(f"{n_img} screenshot(s)")
    if n_file:
        parts.append(f"{n_file} file(s)")
    return f"Attachments: {', '.join(parts)} (UI details may only appear in images).\n"


def _location_prior_for_post(post: dict, board_slug: str) -> str | None:
    details = post.get("details") if isinstance(post.get("details"), str) else ""
    loc = in_client_report.client_location_prior(details)
    if loc:
        return loc
    return BOARD_LOCATION_PRIORS.get(board_slug)


def _board_guidance(board_slug: str, post: dict | None = None) -> str:
    loc = (
        _location_prior_for_post(post, board_slug)
        if post is not None
        else BOARD_LOCATION_PRIORS.get(board_slug)
    )
    feat = BOARD_FEATURE_PRIORS.get(board_slug)
    if not loc and not feat:
        return ""
    parts = []
    if loc:
        parts.append(f"likely location {loc}")
    if feat:
        parts.append(f"likely feature area {feat}")
    return f"Board hint (soft prior, override if content says otherwise): {', '.join(parts)}.\n"


def _has_no_classifiable_text(post: dict) -> bool:
    """True when title, details and all comments are empty/whitespace."""
    title = post.get("title")
    if isinstance(title, str) and title.strip():
        return False
    details = post.get("details")
    if isinstance(details, str) and details.strip():
        return False
    for c in post.get("comments") or []:
        if isinstance(c, dict) and _comment_row_has_content(c):
            return False
    return True


def _build_user_prompt(post: dict, board_slug: str) -> str:
    title = post.get("title") if isinstance(post.get("title"), str) else ""
    details = post.get("details") if isinstance(post.get("details"), str) else ""
    details = _truncate_text(details, MAX_DETAILS_CHARS)
    status = post.get("status") if isinstance(post.get("status"), str) else ""
    category = _post_category_name(post)

    lines = [f"Board: {board_slug}"]
    if category:
        lines.append(f"Canny category: {category}")
    if status:
        lines.append(f"Status: {status}")
    lines.append(_board_guidance(board_slug, post).rstrip())
    lines.append(f"Title: {title}")
    lines.append("")
    lines.append("Details:")
    lines.append(details)
    att = _attachment_note(post)
    if att:
        lines.append("")
        lines.append(att.rstrip())
    comment_block = _build_comments_prompt_block(post)
    if comment_block:
        lines.append(comment_block.rstrip())
    return "\n".join(p for p in lines if p is not None) + "\n"


def _chat_once(
    api_key: str,
    system_prompt: str,
    user_prompt: str,
    extra: str | None,
) -> tuple[str | None, str | None]:
    user = user_prompt if not extra else user_prompt + "\n" + extra
    last_body = ""
    attempt = 0
    rate_limit_retries = 0
    while attempt < MAX_CHAT_HTTP_RETRIES:
        code, body = _minimax_chat(api_key, system_prompt, user)
        last_body = body
        if code == 429:
            # Transient burst limit: back off and retry on a separate budget so
            # a recoverable 429 never burns the HTTP-retry allowance.
            rate_limit_retries += 1
            if rate_limit_retries > MAX_RATE_LIMIT_RETRIES:
                break
            _MINIMAX_LIMITER.wait()
            continue
        if code == 401:
            _warn_minimax_401_once(len(api_key))
        if code == 200 and body:
            return body, None
        if code in (-1, 0) or (code >= 500):
            time.sleep(1.0 * (attempt + 1))
            attempt += 1
            continue
        if code != 200:
            break
        attempt += 1
    return None, f"minimax error (http): {last_body[:500]}"


def _corrective_hint(err: str | None) -> str:
    """Retry hint targeted at the previous round's validation/parse failure."""
    e = (err or "").lower()
    base = "Reply with ONLY valid JSON {\"categories\":[...]}."
    if "location" in e:
        return (
            "Your previous answer omitted the location. Add at least one loc.* id for "
            "where the issue occurs (loc.website for vrchat.com, loc.in-world in-game, "
            "loc.unity-sdk in Unity, loc.mobile-app on mobile, loc.main-menu in menus). " + base
        )
    if "feature" in e:
        return ("Your previous answer omitted the feature. Add at least one leaf feature id "
                "that names the affected system. " + base)
    if "bucket" in e:
        return ("Return EITHER one bucket id alone OR only loc.* plus feature ids — never mix "
                "the two. " + base)
    if "unknown category id" in e:
        return ("Use only ids that appear verbatim in the lists above; do not invent ids. " + base)
    return base


def _run_classify(
    api_key: str,
    tree: dict,
    user_prompt: str,
    board_slug: str,
    post: dict | None = None,
) -> tuple[list[str] | None, str | None]:
    """Single-pass classification against the full taxonomy.

    Returns (categories, error). categories may be [] (deliberate
    'not classifiable'); error is set only on a transient/parse/HTTP failure so
    the caller can avoid stamping the post.
    """
    system = build_system_prompt(tree)
    last_err: str | None = None
    last_cats: list[str] | None = None
    for round_i in range(MAX_VALIDATION_ROUNDS):
        # Round 0 gets no hint; later rounds get a hint targeted at the exact
        # validation/parse error from the previous round so the model can
        # self-correct (e.g. add the loc.* it forgot) instead of us guessing.
        hint = None if round_i == 0 else _corrective_hint(last_err)
        body, err = _chat_once(api_key, system, user_prompt, hint)
        if err or not body:
            last_err = err or "empty response"
            continue
        cats, perr = _parse_categories_from_response(body)
        if perr:
            last_err = perr
            continue
        if cats is None:
            last_err = "no categories"
            continue
        last_cats = cats
        ok, verr = _validate_categories(cats, tree)
        if verr is None and ok is not None:
            return ok, None
        last_err = verr or "validation failed"
        if last_cats:
            location_prior = (
                _location_prior_for_post(post, board_slug) if post is not None else None
            )
            fallback = _fallback_categories(
                last_cats, tree, board_slug, location_prior=location_prior
            )
            if fallback:
                fok, _ = _validate_categories(fallback, tree, normalize=False)
                if fok:
                    print(f"[WARN] AI categorize used fallback for {board_slug}: {last_err}")
                    return fok, None
    return None, last_err or "classify failed"


def tag_post(
    post: dict,
    board_slug: str,
    tree: dict | None,
    system_prompt: str | None,
    api_key: str | None,
) -> dict:
    """Classify a post in a single LLM call. Returns either a success dict
    {\"aiCategories\": [...], \"aiTaggedAt\": iso, \"aiTaxonomyVersion\": n} or a
    failure marker {\"failed\": True} when the API call could not be completed.

    A failure marker is NOT stamped onto the post, so a transient error (rate
    limit, timeout, 5xx, unparseable response) leaves the post un-tagged and it
    is retried on a later run instead of being frozen with empty categories.
    An empty success ([]) is a deliberate \"not classifiable\" verdict. Never raises.
    """
    tagged_at = iso_now_z()
    tax_ver = taxonomy_version(tree)
    failed = {"failed": True}
    if not tree:
        return failed
    eff_key = (os.environ.get("MINIMAX_API_KEY") or "").strip() or (api_key or "").strip()
    if not eff_key:
        _warn_missing_key()
        return failed

    # Posts with no classifiable text can't be categorized from text; skip the
    # LLM call and record an explicit empty (unclassifiable) verdict.
    if _has_no_classifiable_text(post):
        return {"aiCategories": [], "aiTaggedAt": tagged_at, "aiTaxonomyVersion": tax_ver}

    user_prompt = _build_user_prompt(post, board_slug)
    cats, err = _run_classify(eff_key, tree, user_prompt, board_slug, post)
    if err:
        print(f"[WARN] AI categorize failed for post {post.get('_id')}: {err}")
        return failed
    return {"aiCategories": cats or [], "aiTaggedAt": tagged_at, "aiTaxonomyVersion": tax_ver}


def apply_ai_tags(
    post: dict,
    board_slug: str,
    previous_post: dict | None,
    tree: dict | None,
    system_prompt: str | None,
    api_key: str | None,
) -> None:
    """Mutate post with aiCategories/aiTaggedAt per retag rules."""
    if not needs_ai_retag(previous_post, post):
        carry_over_ai_tags(post, previous_post)
        return
    eff = (os.environ.get("MINIMAX_API_KEY") or "").strip() or (api_key or "").strip()
    if not eff:
        _warn_missing_key()
        carry_over_ai_tags(post, previous_post)
        return
    tags = tag_post(post, board_slug, tree, system_prompt, api_key)
    if tags.get("failed"):
        carry_over_ai_tags(post, previous_post)
        return
    post["aiCategories"] = tags["aiCategories"]
    post["aiTaggedAt"] = tags["aiTaggedAt"]
    post["aiTaxonomyVersion"] = tags.get("aiTaxonomyVersion")


def run_ai_tag_jobs(
    jobs: list[tuple[dict, str, dict | None]],
    *,
    tree: dict,
    system_prompt: str | None,
    api_key: str | None,
    workers: int,
    write_fn=None,
    progress_every: int = 100,
    progress_label: str = "Tagged",
) -> tuple[int, bool]:
    """Run tag_post in parallel. Returns (count tagged, rate_limited)."""
    if not jobs:
        return 0, False

    quota_stop = threading.Event()
    done_ids: set[str] = set()
    count = 0
    total = len(jobs)

    def _tag_one(post: dict, board_slug: str) -> bool:
        if quota_stop.is_set() or _MINIMAX_LIMITER.stop_requested:
            return False
        tags = tag_post(post, board_slug, tree, system_prompt, api_key)
        if quota_stop.is_set() or _MINIMAX_LIMITER.stop_requested:
            return False
        if tags.get("failed"):
            return False
        post["aiCategories"] = tags["aiCategories"]
        post["aiTaggedAt"] = tags["aiTaggedAt"]
        if tags.get("aiTaxonomyVersion") is not None:
            post["aiTaxonomyVersion"] = tags["aiTaxonomyVersion"]
        if write_fn:
            write_fn(board_slug, post)
        return True

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        futures = {
            ex.submit(_tag_one, post, board_slug): (post, board_slug, prev)
            for post, board_slug, prev in jobs
        }
        rate_limited = False
        for fut in as_completed(futures):
            if quota_stop.is_set():
                break
            post, board_slug, prev = futures[fut]
            pid = post.get("_id")
            try:
                if fut.result() and pid:
                    done_ids.add(pid)
                    count += 1
                    if count % progress_every == 0 or count == total:
                        print(f"[UPDATE] {progress_label} {count}/{total}...")
            except Exception as e:
                print(f"[ERROR] AI categorize crashed for {post.get('_id', '?')}: {e}")
            if should_stop_ai_tagging(api_key):
                rate_limited = True
                quota_stop.set()
                print("[UPDATE] Stopping AI tagging; MiniMax rate limited")
                break

    for fut, (post, _board_slug, _prev) in futures.items():
        if not fut.done():
            continue
        pid = post.get("_id")
        if not pid or pid in done_ids:
            continue
        try:
            if fut.result():
                done_ids.add(pid)
        except Exception:
            pass

    if rate_limited:
        for post, _board_slug, prev in jobs:
            pid = post.get("_id")
            if pid and pid not in done_ids:
                carry_over_ai_tags(post, prev)

    return count, rate_limited


def retag_all_posts(
    stored: dict,
    tree: dict | None,
    api_key: str | None,
    *,
    only_stale: bool = True,
    write_fn,
    board_slug_filter: str | None = None,
    limit: int | None = None,
    workers: int = 6,
) -> int:
    """Re-classify posts in stored. write_fn(board_slug, post) persists each post. Returns count tagged."""
    if not tree:
        return 0
    eff_key = (os.environ.get("MINIMAX_API_KEY") or "").strip() or (api_key or "").strip()
    if not eff_key:
        _warn_missing_key()
        return 0

    tag_jobs: list[tuple[dict, str]] = []
    for info in stored.values():
        post = info.get("post")
        board_slug = info.get("board_slug") or (post.get("board") or {}).get("urlName")
        if not post or not board_slug:
            continue
        if board_slug_filter and board_slug != board_slug_filter:
            continue
        if only_stale and not needs_retag(post):
            continue
        tag_jobs.append((post, board_slug))
        if limit is not None and len(tag_jobs) >= limit:
            break

    total = len(tag_jobs)
    if total == 0:
        return 0

    print(f"[UPDATE] Re-tagging {total} post(s) with {workers} worker(s)...")
    write_lock = threading.Lock()

    def _write(board_slug: str, post: dict) -> None:
        with write_lock:
            write_fn(board_slug, post)

    count, rate_limited = run_ai_tag_jobs(
        [(post, board_slug, None) for post, board_slug in tag_jobs],
        tree=tree,
        system_prompt=None,
        api_key=api_key,
        workers=workers,
        write_fn=_write,
        progress_every=100,
        progress_label="Re-tagged",
    )
    return count
