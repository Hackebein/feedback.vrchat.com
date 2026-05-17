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
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TREE_PATH = ROOT / "feature_tree.json"
# International default is api.minimax.io; China accounts often need api.minimaxi.com.
DEFAULT_MINIMAX_CHAT_URL = "https://api.minimax.io/v1/chat/completions"


def _minimax_chat_url() -> str:
    u = (os.environ.get("MINIMAX_API_URL") or "").strip()
    return u if u else DEFAULT_MINIMAX_CHAT_URL


def _minimax_model() -> str:
    return (os.environ.get("MINIMAX_MODEL") or "MiniMax-M2.7").strip()

USER_AGENT = "Mozilla/5.0 (compatible; VRChatFeedbackArchiver/1.0)"

_missing_key_warned = False
_missing_tree_warned = False
_minimax_401_warned = False
_warn_lock = threading.Lock()
_tree_lock = threading.Lock()
_cached_tree: dict | None = None

_TAG_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```")
# M2.x models may prefix assistant text with interleaved thinking (see MiniMax OpenAI-compat docs).
_THINKING_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


def _strip_minimax_thinking(text: str) -> str:
    if not text:
        return text
    return _THINKING_RE.sub("", text).strip()


def iso_now_z():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def _walk_features(nodes, out_flat: set[str]):
    if not isinstance(nodes, list):
        return
    for n in nodes:
        if not isinstance(n, dict):
            continue
        nid = n.get("id")
        if isinstance(nid, str) and nid.strip():
            out_flat.add(nid.strip())
        ch = n.get("children")
        if isinstance(ch, list):
            _walk_features(ch, out_flat)


def load_tree(path: Path | None = None) -> dict | None:
    """Load taxonomy; return dict with raw, flat_ids, bucket_ids, location_ids, feature_ids or None."""
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
        buckets = raw.get("buckets") or []
        if isinstance(buckets, list):
            for b in buckets:
                if isinstance(b, dict):
                    bid = b.get("id")
                    if isinstance(bid, str) and bid.strip():
                        bucket_ids.add(bid.strip())

        location_ids: set[str] = set()
        locs = raw.get("locations") or []
        if isinstance(locs, list):
            for loc in locs:
                if isinstance(loc, dict):
                    lid = loc.get("id")
                    if isinstance(lid, str) and lid.strip():
                        location_ids.add(lid.strip())

        feature_ids: set[str] = set()
        feats = raw.get("features")
        _walk_features(feats if isinstance(feats, list) else [], feature_ids)

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
        }
        if path is None:
            _cached_tree = bundle
        return bundle


def build_system_prompt(tree: dict | None) -> str:
    if not tree:
        return ""
    raw = tree["raw"]
    lines = [
        "You classify VRChat Canny feedback posts into categories from a fixed taxonomy.",
        "Return ONLY valid JSON: {\"categories\": [\"id\", ...]} with no other keys.",
        "Each id must appear exactly as listed below. Use every applicable id; dedupe within your list.",
        "",
        "Rules:",
        "If a Comments: section is provided, treat it as additional context "
        "(status changes, follow-ups, merged posts). Still classify the original feedback, "
        "not the comments themselves.",
        "",
        "First decide: is this post real product feedback (a bug, request, or feature comment about VRChat)?",
        "",
        "If NO — output EXACTLY ONE bucket id, alone, no other ids:",
        "  user-support: individual help / self-inflicted issues (forgot password, account recovery, "
        "\"my friend banned me\", personal config trouble).",
        "  vrchat-meta: VRChat company / team / policy / legal / ToS / community programs / release-note chatter.",
        "  off-topic: not about VRChat (posted about another game, random rants).",
        "  spam: ads, scams, abuse, junk.",
        "",
        "If YES — output at least one location id (loc.*) AND at least one feature id. Never mix a bucket with loc/feature ids.",
        "  A bug may list multiple feature ids when several features are affected.",
        "  Prefer the most specific feature ids (leaf children over parent ids when both apply).",
        "  List every location where the issue manifests (e.g. menu + website).",
        "",
        "If you truly cannot classify: {\"categories\": []}.",
        "",
        "Buckets:",
    ]
    for b in raw.get("buckets") or []:
        if isinstance(b, dict) and b.get("id"):
            desc = (b.get("description") or "").strip()
            lines.append(f"  {b['id']}: {desc}")
    lines.append("")
    lines.append("Locations (id: name — description):")

    def fmt_flat(nodes, indent: int = 0):
        pad = "  " * indent
        for n in nodes or []:
            if not isinstance(n, dict):
                continue
            nid = n.get("id", "")
            name = (n.get("name") or "").strip()
            desc = (n.get("description") or "").strip()
            lines.append(f"{pad}{nid}: /{name}/ — {desc}")

    fmt_flat(raw.get("locations") if isinstance(raw.get("locations"), list) else [])

    lines.append("")
    lines.append("Features (id: name — description):")

    def fmt_nodes(nodes, indent: int = 0):
        pad = "  " * indent
        for n in nodes or []:
            if not isinstance(n, dict):
                continue
            nid = n.get("id", "")
            name = (n.get("name") or "").strip()
            desc = (n.get("description") or "").strip()
            lines.append(f"{pad}{nid}: /{name}/ — {desc}")
            ch = n.get("children")
            if isinstance(ch, list) and ch:
                fmt_nodes(ch, indent + 1)

    fmt_nodes(raw.get("features") if isinstance(raw.get("features"), list) else [])

    return "\n".join(lines)


def sanitize_ai_tags(post: dict, tree: dict | None) -> bool:
    """Remove aiCategories ids not in the current tree. Returns True if post was modified.

    Clears aiTaggedAt when anything is dropped or normalized so needs_ai_retag() can fire.
    """
    if not tree:
        return False
    raw = post.get("aiCategories")
    if raw is None:
        return False
    flat = tree["flat_ids"]

    if not isinstance(raw, list):
        post["aiCategories"] = []
        post.pop("aiTaggedAt", None)
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

    unknown_removed = any(c not in flat for c in original)

    if malformed or unknown_removed or cleaned != original:
        post["aiCategories"] = cleaned
        post.pop("aiTaggedAt", None)
        return True

    return False


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
    for key in ("aiCategories", "aiTaggedAt"):
        if key in previous:
            target[key] = previous[key]


def _urllib_post_minimax(url: str, bearer: str, payload: dict, timeout: int) -> tuple[int, str]:
    """POST JSON with Bearer auth. Returns (status_code, response_body)."""
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
    # brace-match first JSON object
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


def _parse_categories_from_response(body: str) -> tuple[list[str] | None, str | None]:
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
    cats = obj.get("categories") if isinstance(obj, dict) else None
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
) -> tuple[list[str] | None, str | None]:
    flat = tree["flat_ids"]
    bucket_ids = tree["bucket_ids"]
    location_ids = tree["location_ids"]
    feature_ids = tree["feature_ids"]
    seen: set[str] = set()
    deduped: list[str] = []
    for c in categories:
        if c not in seen:
            seen.add(c)
            deduped.append(c)
    categories = deduped
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


def _minimax_chat(api_key: str, system_prompt: str, user_prompt: str) -> tuple[int, str]:
    # Always prefer current process env (avoids stale/empty param vs interactive curl in another shell).
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
    lines: list[str] = []
    for c in comments:
        if not isinstance(c, dict):
            continue
        if not _comment_row_has_content(c):
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
                parts.append(f'[merged from "{esc_t}": {m_d}]')
            else:
                parts.append(f'[merged from "{esc_t}"]')
        v = c.get("value")
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())

        lines.append(f"{prefix}: {' '.join(parts)}")

    if not lines:
        return ""
    return "\nComments:\n" + "\n".join(lines) + "\n"


def tag_post(
    post: dict,
    board_slug: str,
    tree: dict | None,
    system_prompt: str,
    api_key: str | None,
) -> dict:
    """Return {\"aiCategories\": [...], \"aiTaggedAt\": iso}. Never raises."""
    tagged_at = iso_now_z()
    empty = {"aiCategories": [], "aiTaggedAt": tagged_at}
    if not tree or not system_prompt:
        return empty
    eff_key = (os.environ.get("MINIMAX_API_KEY") or "").strip() or (api_key or "").strip()
    if not eff_key:
        _warn_missing_key()
        return empty
    title = post.get("title") if isinstance(post.get("title"), str) else ""
    details = post.get("details") if isinstance(post.get("details"), str) else ""
    user_base = (
        f"Board: {board_slug}\nTitle: {title}\n\nDetails:\n{details}\n"
        + _build_comments_prompt_block(post)
    )

    def run_attempt(extra: str | None) -> tuple[list[str] | None, str | None]:
        user = user_base if not extra else user_base + "\n" + extra
        last_body = ""
        for attempt in range(3):
            code, body = _minimax_chat(eff_key, system_prompt, user)
            last_body = body
            if code == 429:
                time.sleep(2.0 * (attempt + 1))
                continue
            if code == 401:
                _warn_minimax_401_once(len(eff_key))
            if code == 200 and body:
                cats, err = _parse_categories_from_response(body)
                if err is None and cats is not None:
                    ok, verr = _validate_categories(cats, tree)
                    if verr is None and ok is not None:
                        return ok, None
                    return None, verr or "validation failed"
            if code in (-1, 0) or (code >= 500):
                time.sleep(1.0 * (attempt + 1))
                continue
            if code != 200:
                break
        return None, f"minimax error (http): {last_body[:500]}"

    cats, err = run_attempt(None)
    if err:
        retry_hint = (
            f"Your previous output was invalid: {err}. "
            "Reply with ONLY valid JSON: {{\"categories\": [...]}} obeying all rules."
        )
        cats, err2 = run_attempt(retry_hint)
        if err2:
            print(f"[WARN] AI categorize failed for post {post.get('_id')}: {err2}")
            return empty
    return {"aiCategories": cats or [], "aiTaggedAt": tagged_at}


def apply_ai_tags(
    post: dict,
    board_slug: str,
    previous_post: dict | None,
    tree: dict | None,
    system_prompt: str,
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
