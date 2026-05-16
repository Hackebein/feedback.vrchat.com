#!/usr/bin/env python3
"""
MiniMax-based post categorization against boards/_feature_tree.json.

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
DEFAULT_TREE_PATH = ROOT / "boards" / "_feature_tree.json"
# International default is api.minimax.io; China accounts often need api.minimaxi.com.
DEFAULT_MINIMAX_CHAT_URL = "https://api.minimax.io/v1/chat/completions"


def _minimax_chat_url() -> str:
    u = (os.environ.get("MINIMAX_API_URL") or "").strip()
    return u if u else DEFAULT_MINIMAX_CHAT_URL


def _minimax_model() -> str:
    return (os.environ.get("MINIMAX_MODEL") or "MiniMax-M2.7").strip()

USER_AGENT = "Mozilla/5.0 (compatible; VRChatFeedbackArchiver/1.0)"

BUG_BOARDS = frozenset({"bug-reports", "sdk-bug-reports"})

_missing_key_warned = False
_missing_tree_warned = False
_minimax_401_warned = False
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
    if not _missing_key_warned:
        print("[WARN] MINIMAX_API_KEY unset; AI categorization skipped for posts that need tagging")
        _missing_key_warned = True


def _warn_minimax_401_once(key_len: int) -> None:
    global _minimax_401_warned
    if _minimax_401_warned:
        return
    _minimax_401_warned = True
    print(
        "[WARN] MiniMax returned HTTP 401 (login fail). Typical causes:\n"
        "  - This Python process has no key: run `export MINIMAX_API_KEY=...` in the **same** terminal before\n"
        "    `python3 scripts/update.py`, or prefix: `MINIMAX_API_KEY=... python3 scripts/update.py ...`\n"
        "  - Wrong regional host: international `https://api.minimax.io/...` vs China `https://api.minimaxi.com/...`.\n"
        "  - If key length looks correct but auth still fails, double-check the key in MiniMax Account > API Keys.\n"
        f"  - Key length visible to this process: {key_len} (sanity-check; should match your real key length)."
    )


def _warn_missing_tree(msg: str):
    global _missing_tree_warned
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
    """Load feature tree; return dict with raw, flat_ids, bucket_ids or None on failure."""
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
        flat: set[str] = set()
        buckets = raw.get("buckets") or []
        bucket_ids: set[str] = set()
        if isinstance(buckets, list):
            for b in buckets:
                if isinstance(b, dict):
                    bid = b.get("id")
                    if isinstance(bid, str) and bid.strip():
                        bid = bid.strip()
                        bucket_ids.add(bid)
                        flat.add(bid)
        feats = raw.get("features")
        _walk_features(feats if isinstance(feats, list) else [], flat)
        bundle = {"raw": raw, "flat_ids": flat, "bucket_ids": bucket_ids}
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
        "Each id must appear exactly as listed. Use the most specific applicable ids.",
        "",
        "Rules:",
        "- Bucket ids (user-support, vrchat-meta, off-topic, spam) mean the post is NOT about product features.",
        "- Never mix bucket ids with feature ids in the same response.",
        "- For board type bug-reports or sdk-bug-reports: output exactly ONE id (one feature OR one bucket).",
        "- For other boards: output one or MORE feature ids if the post spans multiple features, OR exactly ONE bucket id.",
        "- If you cannot classify: {\"categories\": []}.",
        "",
        "Buckets:",
    ]
    for b in raw.get("buckets") or []:
        if isinstance(b, dict) and b.get("id"):
            desc = (b.get("description") or "").strip()
            lines.append(f"  {b['id']}: {desc}")
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


def needs_ai_retag(previous_post: dict | None, current_post: dict | None) -> bool:
    if current_post is None:
        return False
    if previous_post is None:
        return True
    if not previous_post.get("aiTaggedAt"):
        return True
    return (
        previous_post.get("title"),
        previous_post.get("details"),
    ) != (
        current_post.get("title"),
        current_post.get("details"),
    )


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
    board_slug: str,
    categories: list[str],
    tree: dict,
) -> tuple[list[str] | None, str | None]:
    flat = tree["flat_ids"]
    bucket_ids = tree["bucket_ids"]
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
    is_bug = board_slug in BUG_BOARDS
    if is_bug:
        if len(categories) > 1:
            return None, "bug board allows at most one category"
        return categories, None
    if not categories:
        return [], None
    has_bucket = any(c in bucket_ids for c in categories)
    if has_bucket:
        if len(categories) != 1:
            return None, "bucket id must be alone"
        return categories, None
    return categories, None


def _minimax_chat(api_key: str, system_prompt: str, user_prompt: str) -> tuple[int, str]:
    # Always prefer current process env (avoids stale/empty param vs interactive curl in another shell).
    env_key = (os.environ.get("MINIMAX_API_KEY") or "").strip()
    if env_key:
        api_key = env_key
    api_key = api_key.strip()
    if not api_key:
        return 0, '{"error":"missing MINIMAX_API_KEY in environment"}'
    # Request shape per official OpenAPI:
    # https://platform.minimax.io/docs/api-reference/text/api/openapi-chat-openai.json
    # POST {server}/v1/chat/completions with bearerAuth; required: model, messages.
    # Documented optional fields: stream, max_completion_tokens, temperature, top_p.
    # (max_tokens / response_format are OpenAI-client conveniences; not in that schema.)
    payload = {
        "model": _minimax_model(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        # Room for thinking tags + JSON (finish_reason:length yields empty categories otherwise).
        "max_completion_tokens": 2048,
    }
    return _urllib_post_minimax(_minimax_chat_url(), api_key, payload, timeout=90)


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
    user_base = f"Board: {board_slug}\nTitle: {title}\n\nDetails:\n{details}\n"

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
                    ok, verr = _validate_categories(board_slug, cats, tree)
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
