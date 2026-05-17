#!/usr/bin/env python3
"""
VRChat Canny Feedback Archiver

Usage:
    python3 update.py                        # all boards
    python3 update.py bug-reports            # single board
    python3 update.py --limit 10 bug-reports # limit to 10 posts per board
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

try:
    import categorize
except ImportError:  # when run as script
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import categorize  # type: ignore

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
ROOT                 = Path(__file__).resolve().parent.parent
BOARD_FILES          = ROOT / "boards"
README_FILE          = ROOT / "README.md"
README_TEMPLATE_NAME = "README.md.j2"
MAX_WORKERS          = 4
AI_WORKERS           = 8
CANNY_HOST           = "feedback.vrchat.com"
API_URL              = f"https://{CANNY_HOST}/api/posts/get"
SITE_URL             = f"https://{CANNY_HOST}"
USER_AGENT           = "Mozilla/5.0 (compatible; VRChatFeedbackArchiver/1.0)"

BOARD_FILES.mkdir(parents=True, exist_ok=True)


def _minimax_workers():
    raw = (os.environ.get("MINIMAX_WORKERS") or "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return AI_WORKERS


# ---------------------------------------------------------------------------
# Page parsing
# ---------------------------------------------------------------------------
_UNDEF_RE = re.compile(r'(?<=[:,\[])\s*undefined\s*(?=[,}\]])')


def parse_canny_data(html):
    """
    Extract `window.__data = {...}` from a Canny page.

    Canny embeds the full Redux store as a JS object literal that contains a
    handful of `undefined` values. We sanitize those to `null` and then
    brace-match the object so we don't depend on a specific terminator.
    """
    if not html:
        return None
    m = re.search(r'window\.__data\s*=\s*', html)
    if not m:
        return None
    sanitized = _UNDEF_RE.sub('null', html)
    m = re.search(r'window\.__data\s*=\s*', sanitized)
    if not m:
        return None
    i = m.end()
    if i >= len(sanitized) or sanitized[i] != '{':
        return None
    depth = 0
    in_str = False
    esc = False
    start = i
    end = None
    while i < len(sanitized):
        ch = sanitized[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        i += 1
    if end is None:
        return None
    try:
        return json.loads(sanitized[start:end])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------
class RateLimiter:
    """
    Adaptive delay shared across worker threads.

    On HTTP 429 the cooldown window is extended and the per-request baseline
    delay grows; on a clean response the baseline decays back toward zero.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._cooldown_until = 0.0
        self._base_delay = 0.0

    def wait(self):
        with self._lock:
            now = time.time()
            sleep_for = max(self._cooldown_until - now, self._base_delay)
        if sleep_for > 0:
            time.sleep(sleep_for)

    def hit_429(self):
        with self._lock:
            self._cooldown_until = max(self._cooldown_until, time.time() + 30.0)
            self._base_delay = min(self._base_delay + 0.5, 5.0)

    def ok(self):
        with self._lock:
            self._base_delay = max(0.0, self._base_delay - 0.05)


_LIMITER = RateLimiter()


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def _curl_get(url, timeout=15):
    """Returns (http_code, body). http_code is an int (0 on transport error)."""
    try:
        r = subprocess.run(
            ["curl", "-sS", "-L", "-w", "\n__HTTP_CODE__:%{http_code}",
             "-H", f"User-Agent: {USER_AGENT}",
             "-m", str(timeout), url],
            capture_output=True, text=True, timeout=timeout + 5,
        )
        out = r.stdout
        m = re.search(r"\n__HTTP_CODE__:(\d+)\s*$", out)
        if not m:
            return 0, out
        code = int(m.group(1))
        body = out[:m.start()]
        return code, body
    except Exception:
        return 0, ""


def _curl_post_json(url, payload, timeout=15):
    try:
        r = subprocess.run(
            ["curl", "-sS", "-X", "POST", url,
             "-H", "Content-Type: application/json",
             "-H", f"User-Agent: {USER_AGENT}",
             "--data-binary", json.dumps(payload),
             "-m", str(timeout)],
            capture_output=True, text=True, timeout=timeout + 5,
        )
        return r.stdout
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Canny API + page helpers
# ---------------------------------------------------------------------------
def fetch_boards():
    """
    GET the homepage, parse __data.boards.items.

    Returns a list of board dicts: {urlName, _id, name, postCount, activePostCount, settings}.
    """
    code, body = _curl_get(SITE_URL, timeout=15)
    if code != 200:
        return []
    data = parse_canny_data(body)
    if not data:
        return []
    items = data.get("boards", {}).get("items", {}) or {}
    out = []
    for url_name, b in items.items():
        if not url_name:
            continue
        out.append({
            "urlName": url_name,
            "_id": b.get("_id"),
            "name": b.get("name"),
            "postCount": b.get("postCount"),
            "activePostCount": b.get("activePostCount"),
            "settings": b.get("settings", {}),
        })
    out.sort(key=lambda b: b["urlName"])
    return out


def fetch_board_posts(board_slug, sort="newest"):
    """Pull posts via /api/posts/get.

    Returns (posts_list, ids_set, has_next_page).
    """
    body = {
        "__canny_requestID": f"update-{board_slug}-{sort}",
        "__host": CANNY_HOST,
        "boardURLNames": [board_slug],
        "currentBoard": board_slug,
        "pages": 50,
        "sort": sort,
        "status": "",
    }
    raw = _curl_post_json(API_URL, body, timeout=15)
    if not raw.strip():
        return [], set(), None
    try:
        data = json.loads(raw)
    except Exception as e:
        print(f"[WARN] {board_slug}: failed to parse posts/get response: {e}")
        return [], set(), None
    result = data.get("result") or {}
    raw_next = result.get("hasNextPage")
    has_next = None if raw_next is None else bool(raw_next)
    posts = result.get("posts", []) or []
    seen = set()
    out = []
    for p in posts:
        pid = p.get("_id")
        if pid and pid not in seen:
            seen.add(pid)
            out.append(p)
    return out, seen, has_next


def _merge_payload_into_comment(comment, payload):
    """Copy merged-post title/details from a postsActivity.mergedPosts entry."""
    if not isinstance(payload, dict):
        return
    title = payload.get("postTitle")
    details = payload.get("postDetails")
    if isinstance(title, str) and title.strip():
        comment["mergedPostTitle"] = title.strip()
    if isinstance(details, str) and details.strip():
        comment["mergedPostDetails"] = details.strip()


def enrich_comments_from_activity(comments: list, activity: dict) -> None:
    """Attach statusChangeNewStatus and merged post fields; append synthetic merge rows."""
    if not isinstance(activity, dict):
        return

    status_histories = activity.get("statusHistories") or {}
    merged_posts = activity.get("mergedPosts") or {}
    if not isinstance(status_histories, dict):
        status_histories = {}
    if not isinstance(merged_posts, dict):
        merged_posts = {}

    merge_ids_from_comments: set[str] = set()
    comment_doc_ids = {
        str(c["_id"]) for c in comments if isinstance(c, dict) and c.get("_id") is not None
    }

    for c in comments:
        if not isinstance(c, dict):
            continue

        scid = c.get("statusChangeID")
        if isinstance(scid, str) and scid.strip():
            hist = status_histories.get(scid.strip())
            if isinstance(hist, dict):
                st = hist.get("status")
                if isinstance(st, str) and st.strip():
                    c["statusChangeNewStatus"] = st.strip()

        mid = c.get("mergeID")
        if isinstance(mid, str) and mid.strip():
            mk = mid.strip()
            merge_ids_from_comments.add(mk)
            _merge_payload_into_comment(c, merged_posts.get(mk))

    # Merges only listed under mergedPosts (no matching comment row from Canny).
    for raw_key, mp in merged_posts.items():
        if not isinstance(mp, dict):
            continue
        merge_record_id = mp.get("_id") or raw_key
        if merge_record_id is None:
            continue
        mk = str(merge_record_id)
        if mk in merge_ids_from_comments:
            continue
        if mk in comment_doc_ids:
            continue
        synthetic = {
            "_id": mk,
            "mergeID": mk,
            "value": "",
            "created": mp.get("created"),
            "author": mp.get("member"),
            "postID": mp.get("mergeIntoPostID"),
            "boardID": mp.get("boardID"),
            "companyID": mp.get("companyID"),
            "deleted": False,
            "spam": False,
            "internal": False,
            "private": False,
            "pinned": False,
            "imageURLs": [],
            "fileURLs": [],
            "files": [],
            "synthetic": True,
        }
        _merge_payload_into_comment(synthetic, mp)
        comments.append(synthetic)

    comments.sort(key=lambda x: x.get("created") or "")


def fetch_post_page(board_slug, url_slug, retries=3):
    """
    GET /{board_slug}/p/{url_slug}, parse the embedded `window.__data`.

    Returns (post_dict | None, comments_list, not_found, transient_error).
    - not_found is True when the HTTP status is 404 OR the parsed post says so.
    - transient_error is True when something went wrong but we shouldn't treat
      it as a 404 (network error, 5xx, parse failure, etc.).
    """
    if not url_slug:
        return None, [], False, True
    url = f"{SITE_URL}/{board_slug}/p/{url_slug}"
    last_err = None
    for attempt in range(retries):
        _LIMITER.wait()
        code, body = _curl_get(url, timeout=15)
        if code == 429:
            _LIMITER.hit_429()
            last_err = "429"
            continue
        if code == 404:
            return None, [], True, False
        if code == 0 or code >= 500:
            _LIMITER.hit_429()
            last_err = f"http={code}"
            time.sleep(1.0 + attempt)
            continue
        if code != 200:
            last_err = f"http={code}"
            time.sleep(1.0 + attempt)
            continue

        _LIMITER.ok()
        data = parse_canny_data(body)
        if not data:
            last_err = "parse"
            time.sleep(1.0 + attempt)
            continue

        posts_by_board = data.get("posts", {}) or {}
        post = None
        for _bid, slugs in posts_by_board.items():
            if isinstance(slugs, dict) and url_slug in slugs:
                post = slugs[url_slug]
                break
        if not post:
            return None, [], True, False
        if post.get("notFound") or post.get("deletedAt"):
            return None, [], True, False

        pid = post.get("_id")
        comments = []
        if pid:
            activity = (data.get("postsActivity") or {}).get(pid) or {}
            raw_comments = activity.get("comments") or {}
            if isinstance(raw_comments, dict):
                items = list(raw_comments.values())
            elif isinstance(raw_comments, list):
                items = raw_comments
            else:
                items = []
            for c in items:
                if not isinstance(c, dict):
                    continue
                if c.get("deleted") or c.get("postDeleted"):
                    continue
                if (
                    not c.get("value")
                    and not c.get("imageURLs")
                    and not c.get("fileURLs")
                    and not c.get("statusChangeID")
                    and not c.get("mergeID")
                ):
                    continue
                comments.append(dict(c))
            comments.sort(key=lambda x: x.get("created") or "")
            enrich_comments_from_activity(comments, activity)

        return post, comments, False, False

    print(f"[WARN] {board_slug}/{url_slug}: giving up after {retries} retries ({last_err})")
    return None, [], False, True


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------
def load_existing(board_file):
    existing = {}
    if not board_file.exists():
        return existing
    with open(board_file) as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                p = json.loads(line)
            except Exception:
                continue
            pid = p.get("_id")
            if pid:
                existing[pid] = p
    return existing


def write_board(board_file, posts_by_id):
    with open(board_file, "w") as f:
        for p in sorted(posts_by_id.values(), key=lambda x: x.get("created") or ""):
            f.write(json.dumps(p, ensure_ascii=False) + "\n")


def iso_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Per-board update
# ---------------------------------------------------------------------------
def fetch_newest_all(boards):
    """Parallel newest sweep per board.

    Returns (fresh_by_board, single_page_totals).
    """
    fresh_by_board = {}
    single_page_totals = {}
    print(f"[UPDATE] Fetching newest from {len(boards)} board(s)...")
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(fetch_board_posts, b, "newest"): b for b in boards}
        for fut in as_completed(futures):
            slug = futures[fut]
            try:
                posts, _, has_next = fut.result()
                fresh_by_board[slug] = posts
                if has_next is False:
                    single_page_totals[slug] = len(posts)
                print(f"[UPDATE] {slug}: {len(posts)} from API")
            except Exception as e:
                print(f"[ERROR] {slug} newest fetch failed: {e}")
                fresh_by_board[slug] = []
    return fresh_by_board, single_page_totals


def load_all_stored(boards):
    """Load every stored post from the given boards into a single dict.

    Returns ({pid: {"board_slug": <file_stem>, "post": <dict>}}, deduped) where
    `deduped` is the count of duplicate copies eliminated. When the same `_id`
    appears in multiple files, prefer the entry whose file stem matches its
    own `post.board.urlName` (the authoritative location). The remaining copy
    in the wrong file is dropped on the next write of that board.
    """
    stored = {}
    deduped = 0
    selected = set(boards)
    for f in sorted(BOARD_FILES.glob("*.jsonl")):
        if f.name.startswith("_") or f.stem not in selected:
            continue
        stem = f.stem
        with open(f) as fp:
            for line in fp:
                if not line.strip().startswith("{"):
                    continue
                try:
                    p = json.loads(line)
                except Exception:
                    continue
                pid = p.get("_id")
                if not pid:
                    continue
                entry = {"board_slug": stem, "post": p}
                if pid not in stored:
                    stored[pid] = entry
                    continue

                deduped += 1
                existing = stored[pid]
                existing_actual = (existing["post"].get("board") or {}).get("urlName")
                new_actual = (p.get("board") or {}).get("urlName")
                new_correct = new_actual == stem
                existing_correct = existing_actual == existing["board_slug"]
                if new_correct and not existing_correct:
                    stored[pid] = entry
    return stored, deduped


def build_scan_targets(stored, fresh_by_board, limit):
    """Build the global scan list.

    Always includes every NEW pid found in any board's newest sweep, then any
    EXISTING pid in the newest sweep whose visible fields (commentCount,
    status, title) diverge from the stored copy, then fills the rest of the
    list with the globally oldest-updatedAt stored posts up to `limit`. If
    `limit` is None all stored posts are included.

    Returns (scan_targets, new_count, updated_count, oldest_count) where
    scan_targets is a list of (search_board_slug, pid, url_slug).
    """
    scan_targets = []
    seen = set()
    new_count = 0
    updated_count = 0

    for b, fresh_posts in fresh_by_board.items():
        for p in fresh_posts:
            pid = p.get("_id")
            if not pid or pid in stored or pid in seen:
                continue
            slug = p.get("urlName") or ""
            if not slug:
                continue
            scan_targets.append((b, pid, slug))
            seen.add(pid)
            new_count += 1

    for b, fresh_posts in fresh_by_board.items():
        for p in fresh_posts:
            pid = p.get("_id")
            if not pid or pid in seen or pid not in stored:
                continue
            stored_post = stored[pid]["post"]
            if all(
                p.get(k) == stored_post.get(k)
                for k in ("commentCount", "status", "title")
            ):
                continue
            slug = p.get("urlName") or stored_post.get("urlName") or ""
            if not slug:
                continue
            scan_targets.append((b, pid, slug))
            seen.add(pid)
            updated_count += 1

    oldest_sorted = sorted(
        stored.items(),
        key=lambda kv: (
            kv[1]["post"].get("updatedAt") is None,
            kv[1]["post"].get("updatedAt") or "",
        ),
    )
    if limit is not None and limit >= 0:
        oldest_sorted = oldest_sorted[:limit]

    oldest_count = 0
    for pid, info in oldest_sorted:
        if pid in seen:
            continue
        slug = info["post"].get("urlName") or ""
        if not slug:
            continue
        scan_targets.append((info["board_slug"], pid, slug))
        seen.add(pid)
        oldest_count += 1

    return scan_targets, new_count, updated_count, oldest_count


def fetch_all_pages(scan_targets):
    """Run fetch_post_page over every scan target in a shared thread pool.

    Returns {pid: (post | None, comments, not_found, transient_error)}.
    """
    if not scan_targets:
        return {}
    results = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {
            ex.submit(fetch_post_page, b, slug): pid
            for b, pid, slug in scan_targets
        }
        for fut in as_completed(futures):
            pid = futures[fut]
            try:
                results[pid] = fut.result()
            except Exception as e:
                print(f"[ERROR] page fetch crashed for {pid}: {e}")
    return results


def apply_results(stored, results, now, tree, system_prompt, api_key):
    """Merge fetch results back into per-board write buckets.

    Returns (boards_to_write, stats) where:
      - boards_to_write: {board_slug: {pid: post_dict}}
      - stats: {"added", "deleted", "refreshed", "moved"}
    """
    boards_to_write = {}
    for pid, info in stored.items():
        boards_to_write.setdefault(info["board_slug"], {})[pid] = info["post"]

    added = deleted = refreshed = moved = 0
    eff_key = (os.environ.get("MINIMAX_API_KEY") or "").strip() or (api_key or "").strip()
    tag_jobs: list[tuple[dict, str]] = []
    for pid, (post, comments, not_found, transient) in results.items():
        original = stored.get(pid, {}).get("board_slug")
        if transient:
            continue
        if not_found:
            if original and pid in boards_to_write.get(original, {}):
                del boards_to_write[original][pid]
                deleted += 1
                print(f"[UPDATE] {original}/{pid} -> 404, removed")
            continue
        if not post:
            continue

        post["updatedAt"] = now
        post["comments"] = comments

        actual_board = (post.get("board") or {}).get("urlName") or original
        if not actual_board:
            continue

        prev_post = stored.get(pid, {}).get("post")
        if not categorize.needs_ai_retag(prev_post, post):
            categorize.carry_over_ai_tags(post, prev_post)
        elif not eff_key:
            categorize.apply_ai_tags(
                post, actual_board, prev_post, tree, system_prompt, api_key,
            )
        else:
            tag_jobs.append((post, actual_board))

        if original and original != actual_board:
            boards_to_write.get(original, {}).pop(pid, None)
            moved += 1
            print(f"[UPDATE] {original}/{post.get('urlName','?')} -> moved to {actual_board}")

        if pid in stored:
            refreshed += 1
        else:
            added += 1
        boards_to_write.setdefault(actual_board, {})[pid] = post

    if tag_jobs:
        workers = _minimax_workers()
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = {
                ex.submit(
                    categorize.tag_post, post, board_slug, tree, system_prompt, api_key,
                ): post
                for post, board_slug in tag_jobs
            }
            for fut in as_completed(futures):
                post = futures[fut]
                try:
                    tags = fut.result()
                    post["aiCategories"] = tags["aiCategories"]
                    post["aiTaggedAt"] = tags["aiTaggedAt"]
                except Exception as e:
                    pid = post.get("_id", "?")
                    print(f"[ERROR] AI categorize crashed for {pid}: {e}")

    return boards_to_write, {
        "added": added,
        "deleted": deleted,
        "refreshed": refreshed,
        "moved": moved,
    }


# ---------------------------------------------------------------------------
# README rendering
# ---------------------------------------------------------------------------
def format_coverage_str(collected, total):
    """Format coverage percent; never show 100%% unless collected >= total."""
    if total is None or total <= 0:
        return None
    if collected >= total:
        return "100.0%"
    pct = 100.0 * collected / total
    for decimals in range(1, 8):
        if round(pct, decimals) < 100.0:
            return f"{pct:.{decimals}f}%"
    return f"{pct:.8f}%"


def get_board_totals(slug_to_urlname=None):
    """Return {urlName: postCount} sourced from the public homepage."""
    totals = {}
    for b in fetch_boards():
        url_name = b.get("urlName")
        if url_name:
            totals[url_name] = b.get("postCount")
    return totals


def compute_newest_scrape_horizon(fresh_by_board, board_totals, min_posts=500):
    """Return the youngest of each board's oldest `created` from the newest sweep.

    Only boards with at least `min_posts` total posts are considered, since
    smaller boards are fully covered by a single newest scrape and have no
    meaningful horizon. For each qualifying board, the oldest `created` in
    the newest scrape is the cutoff beyond which "newest" alone cannot
    discover posts. The youngest (most recent) of those per-board cutoffs is
    the global horizon. Returns a datetime (UTC) or None.
    """
    horizon = None
    for slug, posts in fresh_by_board.items():
        total = board_totals.get(slug)
        if total is None or total < min_posts:
            continue
        oldest_created = None
        for p in posts:
            c = p.get("created")
            if not c:
                continue
            try:
                dt = datetime.fromisoformat(c.replace("Z", "+00:00"))
            except Exception:
                continue
            if oldest_created is None or dt < oldest_created:
                oldest_created = dt
        if oldest_created is None:
            continue
        if horizon is None or oldest_created > horizon:
            horizon = oldest_created
    return horizon


def generate_readme(
    slug_to_urlname=None,
    newest_scrape_horizon=None,
    inferred_totals=None,
):
    """Render README.md from README.md.j2 template with board statistics.

    `inferred_totals` comes from `main()`'s newest sweep for homepage-missing
    boards. If omitted (standalone regen), one quiet newest sweep fills both
    inferred totals (single-page boards) and scrape horizon when needed.
    """
    import jinja2

    if not BOARD_FILES.exists():
        return

    slug_to_urlname = slug_to_urlname or {}
    board_totals = get_board_totals(slug_to_urlname)

    jsonl_slugs = sorted(
        f.stem for f in BOARD_FILES.iterdir() if f.suffix == ".jsonl"
    )

    needs_meta_fetch = (
        newest_scrape_horizon is None or inferred_totals is None
    )
    fresh_h = None
    single_page = {}
    totals_h = None
    if needs_meta_fetch:
        fresh_h, single_page = fetch_newest_all(jsonl_slugs)
        totals_h = {
            b["urlName"]: b.get("postCount") or 0
            for b in fetch_boards() if b.get("urlName")
        }

    inferred = dict(inferred_totals or {})
    if inferred_totals is None:
        inferred.update(single_page)

    if newest_scrape_horizon is None:
        effective_horizon = (
            compute_newest_scrape_horizon(fresh_h, totals_h)
            if fresh_h is not None and totals_h is not None
            else None
        )
    else:
        effective_horizon = newest_scrape_horizon

    boards = []
    total_collected = 0

    for f in sorted(BOARD_FILES.iterdir()):
        if f.suffix != ".jsonl":
            continue
        api_count = 0
        with open(f) as fp:
            for line in fp:
                try:
                    post = json.loads(line)
                    if post.get("_id"):
                        api_count += 1
                except Exception:
                    pass
        slug = f.stem
        url_name = slug_to_urlname.get(slug, slug) if slug_to_urlname else slug

        total = board_totals.get(url_name) if url_name in board_totals else None
        if total is None:
            total = inferred.get(slug)
        collected = api_count
        if total is not None:
            if total > 500:
                hidden = 0
                unknown = max(0, total - collected)
            else:
                hidden = max(0, total - collected)
                unknown = 0
        else:
            hidden = None
            unknown = None
        pct = format_coverage_str(collected, total) if total is not None else None
        boards.append({
            "slug": slug,
            "collected": collected,
            "hidden": hidden,
            "unknown": unknown,
            "total": total,
            "coverage_str": pct,
        })
        total_collected += collected

    total_hidden = sum(b["hidden"] for b in boards if b["hidden"] is not None)
    total_unknown = sum(b["unknown"] for b in boards if b["unknown"] is not None)
    total_known = sum(b["total"] for b in boards if b["total"] is not None)
    total_from_known = sum(b["collected"] for b in boards if b["total"] is not None)
    overall_coverage = (total_from_known / total_known * 100) if total_known > 0 else 0

    total_row = {
        "slug": "**Total**",
        "collected": total_collected,
        "hidden": total_hidden,
        "unknown": total_unknown,
        "total": total_known if total_known > 0 else None,
        "coverage_str": format_coverage_str(total_from_known, total_known)
        if total_known > 0
        else "0.0%",
    }

    freshness = None
    for f in BOARD_FILES.iterdir():
        if f.suffix != ".jsonl" or f.name.startswith("_"):
            continue
        with open(f) as fp:
            for line in fp:
                if not line.strip().startswith("{"):
                    continue
                try:
                    p = json.loads(line)
                    ua = p.get("updatedAt")
                    if ua:
                        dt = datetime.fromisoformat(ua.replace("Z", "+00:00"))
                        if freshness is None or dt < freshness:
                            freshness = dt
                except Exception:
                    pass
    now = datetime.now(timezone.utc)
    if freshness:
        delta = now - freshness
        secs = int(delta.total_seconds())
        if secs < 60:
            age_str = f"{max(secs, 0)}s ago"
        elif secs < 3600:
            age_str = f"{secs // 60}m ago"
        elif secs < 86400:
            age_str = f"{secs // 3600}h ago"
        else:
            age_str = f"{secs // 86400}d ago"
        oldest_updated_str = f"{freshness.strftime('%Y-%m-%d %H:%M UTC')} ({age_str})"
    else:
        oldest_updated_str = "unknown"

    if effective_horizon:
        delta = now - effective_horizon
        secs = int(delta.total_seconds())
        if secs < 60:
            horizon_age = f"{max(secs, 0)}s ago"
        elif secs < 3600:
            horizon_age = f"{secs // 60}m ago"
        elif secs < 86400:
            horizon_age = f"{secs // 3600}h ago"
        else:
            horizon_age = f"{secs // 86400}d ago"
        newest_scrape_horizon_str = (
            f"{effective_horizon.strftime('%Y-%m-%d %H:%M UTC')} ({horizon_age})"
        )
    else:
        newest_scrape_horizon_str = "unknown"

    env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(str(ROOT)),
        keep_trailing_newline=True,
    )
    env.filters["comma"] = lambda v: f"{v:,}" if v is not None else "?"
    env.filters["percentage"] = lambda v: f"{v:.1f}%"

    template = env.get_template(README_TEMPLATE_NAME)
    rendered = template.render(
        boards=boards,
        total_row=total_row,
        total_collected=total_collected,
        total_hidden=total_hidden,
        total_unknown=total_unknown,
        overall_coverage=overall_coverage,
        oldest_updated=oldest_updated_str,
        newest_scrape_horizon=newest_scrape_horizon_str,
    )

    README_FILE.write_text(rendered)
    print(f"[README] Updated {README_FILE} ({len(boards)} boards, {total_collected:,} collected)")
    return slug_to_urlname


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def get_boards():
    """
    Get list of board slugs to process.

    Prefers existing .jsonl files; falls back to the homepage parser.
    """
    files = sorted(f.stem for f in BOARD_FILES.glob("*.jsonl") if not f.name.startswith("_"))
    if files:
        return files
    return [b["urlName"] for b in fetch_boards() if b.get("urlName")]


def main():
    parser = argparse.ArgumentParser(description="VRChat Canny Feedback Archiver")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=None,
                        help="Refresh only the N globally-oldest-updatedAt posts (default: all)")
    parser.add_argument("boards", nargs="*", default=None, help="Board slugs (default: all)")
    args = parser.parse_args()

    boards = get_boards()
    if args.boards:
        requested = set(args.boards)
        known = set(boards)
        boards = [b for b in args.boards if b in known]
        missing = requested - known
        if missing:
            print(f"[WARN] Unknown boards: {sorted(missing)}")

    print(f"[UPDATE] {len(boards)} board(s): {boards}")

    if args.dry_run:
        print("[DRY-RUN] No changes made")
        return

    t0 = time.time()

    fresh_by_board, single_page_totals = fetch_newest_all(boards)
    board_totals = {b["urlName"]: b.get("postCount") or 0
                    for b in fetch_boards() if b.get("urlName")}
    newest_scrape_horizon = compute_newest_scrape_horizon(fresh_by_board, board_totals)
    if newest_scrape_horizon:
        print(f"[UPDATE] newest-scrape horizon: {newest_scrape_horizon.isoformat()}")
    stored, deduped = load_all_stored(boards)
    print(f"[UPDATE] {len(stored)} stored across {len(boards)} board(s)")
    if deduped:
        print(f"[UPDATE] {deduped} cross-board duplicate(s) consolidated")

    scan_targets, new_count, updated_count, oldest_count = build_scan_targets(
        stored, fresh_by_board, args.limit,
    )
    print(f"[UPDATE] scanning {len(scan_targets)} posts "
          f"(new={new_count}, updated={updated_count}, oldest={oldest_count})...")

    results = fetch_all_pages(scan_targets)

    now = iso_now()
    tree = categorize.load_tree()
    sanitized = 0
    if tree:
        for info in stored.values():
            if categorize.sanitize_ai_tags(info["post"], tree):
                sanitized += 1
        if sanitized:
            print(
                f"[UPDATE] Sanitized AI tags on {sanitized} post(s) "
                "(removed unknown or stale ids)",
            )
    system_prompt = categorize.build_system_prompt(tree)
    api_key = (os.environ.get("MINIMAX_API_KEY") or "").strip() or None
    boards_to_write, totals = apply_results(
        stored, results, now, tree, system_prompt, api_key,
    )
    totals["deduped"] = deduped

    for slug, posts in sorted(boards_to_write.items()):
        write_board(BOARD_FILES / f"{slug}.jsonl", posts)

    elapsed = time.time() - t0
    print(f"\n[UPDATE] Done in {elapsed:.1f}s - "
          f"+{totals['added']} added, "
          f"-{totals['deleted']} deleted, "
          f"~{totals['refreshed']} refreshed, "
          f">{totals['moved']} moved, "
          f"={totals['deduped']} deduped")

    try:
        print("[UPDATE] Regenerating README...")
        generate_readme(
            newest_scrape_horizon=newest_scrape_horizon,
            inferred_totals=single_page_totals,
        )
        print("[UPDATE] README regenerated")
    except Exception as e:
        print(f"[UPDATE] README generation skipped: {e}")

if __name__ == "__main__":
    main()
