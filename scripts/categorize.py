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

# Bump when taxonomy or classifier prompts change materially (forces re-tag).
DEFAULT_TAXONOMY_VERSION = 3

MAX_DETAILS_CHARS = 12_000
MAX_COMMENT_BLOCK_CHARS = 8_000
MAX_COMMENT_LINES = 20
MAX_COMMENT_VALUE_CHARS = 1_500
MAX_CHAT_HTTP_RETRIES = 3
MAX_VALIDATION_ROUNDS = 4

BOARD_LOCATION_PRIORS: dict[str, str] = {
    "website": "loc.website",
    "udon": "loc.unity-sdk",
    "sdk-bug-reports": "loc.unity-sdk",
    "ios-mobile-beta": "loc.mobile-app",
    "android": "loc.mobile-app",
    "open-beta": "loc.pc-client",
    "creator-companion": "loc.creator-companion",
    "avatar-30": "loc.in-world",
    "impostors": "loc.in-world",
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


def build_pass1_system_prompt(tree: dict | None) -> str:
    if not tree:
        return ""
    raw = tree["raw"]
    domains = ", ".join(tree["top_level_features"])
    lines = [
        "You classify VRChat Canny feedback posts. Pass 1: decide bucket vs product domain.",
        'Return ONLY valid JSON with one of these shapes:',
        '  {"kind": "bucket", "categories": ["bucket-id"]}  — exactly one bucket id, alone',
        '  {"kind": "product", "domains": ["top-level-id", ...]}  — one or more top-level feature ids',
        "",
        "Rules:",
        *_shared_rules_lines(),
        "",
        "If truly not classifiable: {\"kind\": \"bucket\", \"categories\": []}.",
        "",
        "Buckets:",
    ]
    for b in raw.get("buckets") or []:
        if isinstance(b, dict) and b.get("id"):
            desc = (b.get("description") or "").strip()
            lines.append(f"  {b['id']}: {desc}")
    lines.append("")
    lines.append(f"Top-level product domains (use these ids in domains): {domains}")
    return "\n".join(lines)


def _feature_nodes_by_domain(raw: dict, domains: list[str]) -> list[dict]:
    out: list[dict] = []
    feats = raw.get("features")
    if not isinstance(feats, list):
        return out
    domain_set = set(domains)
    for n in feats:
        if isinstance(n, dict) and n.get("id") in domain_set:
            out.append(n)
    return out


def build_pass2_system_prompt(tree: dict | None, domains: list[str]) -> str:
    if not tree:
        return ""
    raw = tree["raw"]
    nodes = _feature_nodes_by_domain(raw, domains)
    if not nodes:
        nodes = raw.get("features") if isinstance(raw.get("features"), list) else []

    lines = [
        "You classify VRChat Canny feedback posts. Pass 2: assign location + feature ids.",
        'Return ONLY valid JSON: {"categories": ["id", ...]} with no other keys.',
        "Output at least one loc.* id AND at least one feature id from the lists below.",
        "Use leaf feature ids only. List every location where the issue manifests.",
        "",
        "Rules:",
        *_shared_rules_lines(),
        "",
        "Locations (id: name — description):",
    ]

    def fmt_flat(nodes_list, indent: int = 0):
        pad = "  " * indent
        for n in nodes_list or []:
            if not isinstance(n, dict):
                continue
            nid = n.get("id", "")
            name = (n.get("name") or "").strip()
            desc = (n.get("description") or "").strip()
            lines.append(f"{pad}{nid}: /{name}/ — {desc}")

    fmt_flat(raw.get("locations") if isinstance(raw.get("locations"), list) else [])

    lines.append("")
    lines.append("Features for this post (id: name — description):")

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

    fmt_nodes(nodes)
    return "\n".join(lines)


def build_system_prompt(tree: dict | None) -> str:
    """Legacy single-pass prompt (pass 2 with full tree). Kept for compatibility."""
    if not tree:
        return ""
    domains = tree["top_level_features"]
    return build_pass2_system_prompt(tree, domains)


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


def _parse_pass1_from_response(body: str, tree: dict) -> tuple[str | None, list[str] | None, str | None]:
    """Returns (kind, ids, error). kind is 'bucket' or 'product'. ids are categories or domains."""
    obj, err = _parse_json_object(body)
    if err or obj is None:
        return None, None, err
    kind = obj.get("kind")
    if kind is None and "categories" in obj:
        cats = obj.get("categories")
        if isinstance(cats, list):
            out = [x.strip() for x in cats if isinstance(x, str) and x.strip()]
            if not out:
                return "bucket", [], None
            if all(c in tree["bucket_ids"] for c in out):
                return "bucket", out, None
            if any(c in tree["location_ids"] or c in tree["feature_ids"] for c in out):
                domains = [c for c in out if c in tree["top_level_features"]]
                if domains:
                    return "product", domains, None
                return "product", tree["top_level_features"][:3], None
    if kind == "bucket":
        cats = obj.get("categories")
        if cats is None:
            return None, None, "pass1 bucket missing categories"
        if not isinstance(cats, list):
            return None, None, "pass1 categories must be a list"
        out = [x.strip() for x in cats if isinstance(x, str) and x.strip()]
        return "bucket", out, None
    if kind == "product":
        domains = obj.get("domains")
        if domains is None:
            return None, None, "pass1 product missing domains"
        if not isinstance(domains, list):
            return None, None, "pass1 domains must be a list"
        top = set(tree["top_level_features"])
        out = [x.strip() for x in domains if isinstance(x, str) and x.strip() and x.strip() in top]
        if not out:
            return None, None, "pass1 domains empty or invalid"
        return "product", out, None
    return None, None, f"pass1 unknown kind: {kind!r}"


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
        prior = BOARD_LOCATION_PRIORS.get(board_slug)
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
        "max_completion_tokens": 2048,
    }
    return _urllib_post_minimax(_minimax_chat_url(), api_key, payload, timeout=90)


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


def _board_guidance(board_slug: str) -> str:
    loc = BOARD_LOCATION_PRIORS.get(board_slug)
    feat = BOARD_FEATURE_PRIORS.get(board_slug)
    if not loc and not feat:
        return ""
    parts = []
    if loc:
        parts.append(f"likely location {loc}")
    if feat:
        parts.append(f"likely feature area {feat}")
    return f"Board hint (soft prior, override if content says otherwise): {', '.join(parts)}.\n"


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
    lines.append(_board_guidance(board_slug).rstrip())
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
    for attempt in range(MAX_CHAT_HTTP_RETRIES):
        code, body = _minimax_chat(api_key, system_prompt, user)
        last_body = body
        if code == 429:
            time.sleep(2.0 * (attempt + 1))
            continue
        if code == 401:
            _warn_minimax_401_once(len(api_key))
        if code == 200 and body:
            return body, None
        if code in (-1, 0) or (code >= 500):
            time.sleep(1.0 * (attempt + 1))
            continue
        if code != 200:
            break
    return None, f"minimax error (http): {last_body[:500]}"


def _run_pass1(
    api_key: str,
    tree: dict,
    user_prompt: str,
) -> tuple[str | None, list[str] | None, str | None]:
    system = build_pass1_system_prompt(tree)
    hints = [
        None,
        "Reply with ONLY valid JSON: {\"kind\":\"bucket\",\"categories\":[...]} or {\"kind\":\"product\",\"domains\":[...]}.",
        "If product feedback, domains must be top-level ids. If not product feedback, use a single bucket id.",
    ]
    last_err: str | None = None
    for round_i in range(min(MAX_VALIDATION_ROUNDS, len(hints))):
        body, err = _chat_once(api_key, system, user_prompt, hints[round_i])
        if err or not body:
            last_err = err or "empty response"
            continue
        kind, ids, perr = _parse_pass1_from_response(body, tree)
        if perr:
            last_err = perr
            continue
        if kind == "bucket":
            if not ids:
                return "bucket", [], None
            ok, verr = _validate_categories(ids, tree)
            if verr:
                last_err = verr
                continue
            return "bucket", ok, None
        if kind == "product":
            return "product", ids, None
        last_err = "pass1 parse failed"
    return None, None, last_err or "pass1 failed"


def _run_pass2(
    api_key: str,
    tree: dict,
    domains: list[str],
    user_prompt: str,
    board_slug: str,
) -> tuple[list[str] | None, str | None]:
    system = build_pass2_system_prompt(tree, domains)
    hints = [
        None,
        "Reply with ONLY valid JSON: {\"categories\": [...]} with at least one loc.* and one feature id.",
        "Use leaf feature ids only. Include loc.website for vrchat.com issues.",
        "Never mix bucket ids with loc/feature ids.",
    ]
    last_err: str | None = None
    last_cats: list[str] | None = None
    for round_i in range(min(MAX_VALIDATION_ROUNDS, len(hints))):
        body, err = _chat_once(api_key, system, user_prompt, hints[round_i])
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
            fallback = _fallback_categories(last_cats, tree, board_slug)
            if fallback:
                fok, _ = _validate_categories(fallback, tree, normalize=False)
                if fok:
                    print(f"[WARN] AI categorize used fallback for domains {domains}: {last_err}")
                    return fok, None
    return None, last_err or "pass2 failed"


def tag_post(
    post: dict,
    board_slug: str,
    tree: dict | None,
    system_prompt: str | None,
    api_key: str | None,
) -> dict:
    """Return {\"aiCategories\": [...], \"aiTaggedAt\": iso, \"aiTaxonomyVersion\": n}. Never raises."""
    tagged_at = iso_now_z()
    tax_ver = taxonomy_version(tree)
    empty = {"aiCategories": [], "aiTaggedAt": tagged_at, "aiTaxonomyVersion": tax_ver}
    if not tree:
        return empty
    eff_key = (os.environ.get("MINIMAX_API_KEY") or "").strip() or (api_key or "").strip()
    if not eff_key:
        _warn_missing_key()
        return empty

    user_prompt = _build_user_prompt(post, board_slug)

    kind, ids, err = _run_pass1(eff_key, tree, user_prompt)
    if err:
        print(f"[WARN] AI categorize pass1 failed for post {post.get('_id')}: {err}")
        fallback = _fallback_categories([], tree, board_slug)
        if fallback:
            return {"aiCategories": fallback, "aiTaggedAt": tagged_at, "aiTaxonomyVersion": tax_ver}
        return empty

    if kind == "bucket":
        return {"aiCategories": ids or [], "aiTaggedAt": tagged_at, "aiTaxonomyVersion": tax_ver}

    if kind == "product" and ids:
        cats, err2 = _run_pass2(eff_key, tree, ids, user_prompt, board_slug)
        if err2:
            print(f"[WARN] AI categorize pass2 failed for post {post.get('_id')}: {err2}")
            fallback = _fallback_categories([], tree, board_slug)
            if fallback:
                return {"aiCategories": fallback, "aiTaggedAt": tagged_at, "aiTaxonomyVersion": tax_ver}
            return empty
        return {"aiCategories": cats or [], "aiTaggedAt": tagged_at, "aiTaxonomyVersion": tax_ver}

    fallback = _fallback_categories([], tree, board_slug)
    if fallback:
        return {"aiCategories": fallback, "aiTaggedAt": tagged_at, "aiTaxonomyVersion": tax_ver}
    return empty


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
    post["aiCategories"] = tags["aiCategories"]
    post["aiTaggedAt"] = tags["aiTaggedAt"]
    post["aiTaxonomyVersion"] = tags.get("aiTaxonomyVersion")


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
        if only_stale and not is_stale_taxonomy(post):
            continue
        tag_jobs.append((post, board_slug))
        if limit is not None and len(tag_jobs) >= limit:
            break

    total = len(tag_jobs)
    if total == 0:
        return 0

    print(f"[UPDATE] Re-tagging {total} post(s) with {workers} worker(s)...")
    count = 0
    write_lock = threading.Lock()

    def _apply_tags(post: dict, board_slug: str) -> None:
        tags = tag_post(post, board_slug, tree, None, api_key)
        post["aiCategories"] = tags["aiCategories"]
        post["aiTaggedAt"] = tags["aiTaggedAt"]
        post["aiTaxonomyVersion"] = tags.get("aiTaxonomyVersion")
        with write_lock:
            write_fn(board_slug, post)

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        futures = {
            ex.submit(_apply_tags, post, board_slug): (post, board_slug)
            for post, board_slug in tag_jobs
        }
        for fut in as_completed(futures):
            post, board_slug = futures[fut]
            try:
                fut.result()
                count += 1
                if count % 100 == 0 or count == total:
                    print(f"[UPDATE] Re-tagged {count}/{total}...")
            except Exception as e:
                pid = post.get("_id", "?")
                print(f"[ERROR] AI retag crashed for {board_slug}/{pid}: {e}")

    return count
