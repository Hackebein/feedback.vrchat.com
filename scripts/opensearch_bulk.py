#!/usr/bin/env python3
"""
Bulk index boards/<slug>/*.json into OpenSearch using a zero-downtime alias swap:

  PUT backing index `{alias}-{UTC YYYYmmDDHHMM}` -> bulk load -> POST _aliases
  atomic swap -> optional DELETE for stale `{alias}-YYYYMMDDHHMM` indices.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

import in_client_report

REPO_ROOT = Path(__file__).resolve().parents[1]

IN_CLIENT_BOARD_ID = "69f3e15229c8d0dea5379a7b"
IN_CLIENT_BOARD_NAME = "In-Client Bug Reporting"
BUG_REPORTS_URL_NAME = "bug-reports"


def utc_backing_suffix() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M")


def validate_suffix(s: str, *, src: str) -> None:
    if not re.fullmatch(r"[0-9]{12}", s):
        sys.exit(f"{src} must be exactly 12 digits UTC YYYYmmDDHHMM (digits only): got {s!r}")


def load_index_body(mapping_path: Path) -> dict[str, Any]:
    with mapping_path.open(encoding="utf-8") as f:
        raw = json.load(f)
    if "mappings" not in raw:
        sys.exit(f"mappings file missing top-level mappings: {mapping_path}")
    return raw


def json_safe(value: Any) -> Any:
    """Round-trip via JSON so only ES-friendly scalars/objects survive; stray types become strings."""
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return None


def comment_text_snippets(c: dict[str, Any]) -> list[str]:
    """Plain-text contributions from a comment (body/value + enrichments + author name) for combined_text."""
    out: list[str] = []
    v = c.get("value")
    if isinstance(v, str) and v.strip():
        out.append(v.strip())
    sns = c.get("statusChangeNewStatus")
    if isinstance(sns, str) and sns.strip():
        out.append(sns.strip())
    mt = c.get("mergedPostTitle")
    if isinstance(mt, str) and mt.strip():
        out.append(mt.strip())
    md = c.get("mergedPostDetails")
    if isinstance(md, str) and md.strip():
        out.append(md.strip())
    au = c.get("author")
    if isinstance(au, dict):
        nm = au.get("name")
        if isinstance(nm, str) and nm.strip():
            out.append(nm.strip())
    return out


def _parse_activity_datetime(v: Any) -> datetime | None:
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        return datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def compute_last_activity_iso(post: dict[str, Any]) -> str | None:
    candidates: list[datetime] = []
    for key in ("created", "statusChanged"):
        dt = _parse_activity_datetime(post.get(key))
        if dt is not None:
            candidates.append(dt)
    comments_in = post.get("comments") or []
    if isinstance(comments_in, list):
        for c in comments_in:
            if not isinstance(c, dict):
                continue
            if c.get("deleted") is True or c.get("spam") is True:
                continue
            ct = _parse_activity_datetime(c.get("created"))
            if ct is not None:
                candidates.append(ct)
    if not candidates:
        return None
    return max(candidates).isoformat()


def _scraper_user_id(repo_root: Path | None = None) -> str | None:
    root = repo_root or REPO_ROOT
    path = root / "scraper_user_id"
    if path.is_file():
        line = path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        if line and line[0].strip():
            return line[0].strip()
    env = (os.environ.get("SCRAPER_CANNY_USER_ID") or "").strip()
    return env or None


def apply_virtual_in_client_board(doc: dict[str, Any]) -> None:
    """Present bug-reports in-client template posts as In-Client Bug Reporting.

    Stored JSON stays on bug-reports. Permalinks keep `board.urlName` so
    `/{board.urlName}/p/{urlName}` still resolves on Canny.
    """
    board = doc.get("board")
    if not isinstance(board, dict):
        return
    if board.get("urlName") != BUG_REPORTS_URL_NAME:
        return
    if not in_client_report.is_in_client_report(doc.get("details")):
        return
    board["_id"] = IN_CLIENT_BOARD_ID
    board["name"] = IN_CLIENT_BOARD_NAME
    doc["boardID"] = IN_CLIENT_BOARD_ID


def merge_in_client_search_tags(doc: dict[str, Any]) -> None:
    """Add template location and inclient.* tags to indexed aiCategories."""
    parsed = in_client_report.parse_in_client_template(doc.get("details"))
    if parsed is None:
        return
    extra = in_client_report.client_location_tags(parsed)
    extra.extend(in_client_report.in_client_search_tags(parsed))
    cats = doc.get("aiCategories")
    if not isinstance(cats, list):
        cats = []
    seen: set[str] = {c for c in cats if isinstance(c, str)}
    for tag in extra:
        if tag not in seen:
            cats.append(tag)
            seen.add(tag)
    doc["aiCategories"] = cats


def _filter_scraper_voter(doc: dict[str, Any], scraper_id: str | None) -> None:
    """Drop the SSO scrape bot from voters and adjust score for index docs."""
    if not scraper_id:
        return
    voters = doc.get("voters")
    if not isinstance(voters, list):
        return
    kept = []
    removed = False
    for v in voters:
        if isinstance(v, dict) and (v.get("_id") or v.get("id")) == scraper_id:
            removed = True
            continue
        kept.append(v)
    if not removed:
        return
    doc["voters"] = kept
    score = doc.get("score")
    if isinstance(score, int) and score > 0:
        doc["score"] = score - 1
    elif isinstance(score, float) and score > 0:
        doc["score"] = int(score) - 1


def transform_post(line: dict[str, Any], *, scraper_id: str | None = None) -> dict[str, Any] | None:
    pid = (line.get("_id") or "").strip()
    if not pid:
        return None

    safe = json_safe(line)
    if not isinstance(safe, dict):
        return None

    # _id is reserved by OpenSearch as a metadata field at the document root.
    safe.pop("_id", None)
    # Volatile Canny timestamps; do not index.
    safe.pop("lastUpdated", None)
    safe.pop("updatedAt", None)

    apply_virtual_in_client_board(safe)
    merge_in_client_search_tags(safe)

    title = safe.get("title") or ""
    details = safe.get("details") or ""
    parts: list[str] = [str(title), str(details)]

    author = safe.get("author")
    if isinstance(author, dict):
        nm = author.get("name")
        if isinstance(nm, str) and nm.strip():
            parts.append(nm.strip())

    comments_in = safe.get("comments") or []
    if isinstance(comments_in, list):
        for c in comments_in:
            if isinstance(c, dict):
                parts.extend(comment_text_snippets(c))

    safe["post_id"] = pid
    safe["combined_text"] = "\n\n".join(p for p in parts if p and str(p).strip())
    last_activity = compute_last_activity_iso(safe)
    if last_activity is not None:
        safe["lastActivityAt"] = last_activity
    _filter_scraper_voter(safe, scraper_id)
    return safe


def iter_board_documents(
    boards_root: Path,
    *,
    scraper_id: str | None = None,
) -> Iterator[tuple[str, dict[str, Any]]]:
    for board_dir in sorted(boards_root.iterdir()):
        if not board_dir.is_dir() or board_dir.name.startswith("_"):
            continue
        for path in sorted(board_dir.glob("*.json")):
            if path.name.endswith(".json.tmp"):
                continue
            try:
                obj = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            except json.JSONDecodeError as e:
                raise SystemExit(f"{path}: invalid JSON: {e}") from e
            doc = transform_post(obj, scraper_id=scraper_id)
            if doc:
                yield doc["post_id"], doc


def gen_bulk(new_index: str, pairs: Iterable[tuple[str, dict[str, Any]]]) -> Iterator[dict[str, Any]]:
    for pid, doc in pairs:
        yield {"_index": new_index, "_id": pid, "_op_type": "index", "_source": doc}


_BACKING_SUFFIX = r"-(?P<suf>\d{12})$"


def backing_pat(alias: str) -> re.Pattern[str]:
    return re.compile("^" + re.escape(alias) + _BACKING_SUFFIX)


def list_backing_indices_sorted(client: Any, alias: str, newest_first: bool = False) -> list[str]:
    try:
        r = client.indices.get(index=f"{alias}-*", params={"ignore": 404})
    except Exception:
        return []
    if not isinstance(r, dict):
        return []
    pat = backing_pat(alias)
    keyed: list[tuple[int, str]] = []
    for name in r:
        m = pat.match(name)
        if not m:
            continue
        keyed.append((int(m.group("suf")), name))
    keyed.sort(reverse=newest_first, key=lambda t: t[0])
    return [t[1] for t in keyed]


def atomic_alias_swap(client: Any, alias: str, new_index: str) -> None:
    """Atomically point `alias` at `new_index`, removing it from any other backing index.

    We avoid `indices.get_alias` because the ingest role typically lacks
    `indices:admin/aliases/get` permission (silent 403 would skip removals and
    leave the alias pointing at multiple indices). Instead we enumerate
    backing indices via `indices.get(index="{alias}-*")`, which only requires
    `indices:admin/get`, and issue `remove` actions for every backing index
    except the new one. `update_aliases` ignores `remove` actions for indices
    that don't currently hold the alias, so the operation stays idempotent.
    """
    actions: list[dict[str, Any]] = []
    for ix in list_backing_indices_sorted(client, alias):
        if ix == new_index:
            continue
        actions.append({"remove": {"index": ix, "alias": alias, "must_exist": False}})
    actions.append({"add": {"index": new_index, "alias": alias}})
    resp = client.indices.update_aliases(body={"actions": actions})
    acknowledged = resp.get("acknowledged", True)
    if acknowledged is False or resp.get("errors"):
        sys.exit(f"alias swap rejected: {resp}")


def delete_stale_backing(client: Any, alias: str, current_index: str, *, dry_run: bool, keep_prev: int) -> None:
    """Keep newest `(keep_prev + 1)` backing `{alias}-{YYYYMMDDHHMM}` indices; DELETE anything older."""

    newest_first = list_backing_indices_sorted(client, alias, newest_first=True)
    if not newest_first:
        sys.stderr.write(f"[warn] no backing indices matched {alias}-* after swap\n")
        return
    if newest_first[0] != current_index:
        sys.stderr.write(f"[warn] newest backing idx {newest_first[0]!r} != current {current_index!r}; cleanup might be wrong\n")

    doomed = newest_first[keep_prev + 1 :]

    for ix in doomed:
        if ix == current_index:
            continue
        if dry_run:
            print(f"[dry-run] DELETE index {ix}", file=sys.stderr)
            continue
        client.indices.delete(index=ix)
        print(f"deleted stale index {ix}", file=sys.stderr)


def _import_opensearch() -> tuple[Any, Any]:
    try:
        from opensearchpy import OpenSearch
        from opensearchpy.helpers import bulk
    except ImportError:
        sys.stderr.write("Install deps: pip install -r scripts/requirements-ingest.txt\n")
        raise
    return OpenSearch, bulk


def build_client(host: str, port: int, use_ssl: bool, http_auth: tuple[str, str] | None) -> Any:
    OpenSearch, _ = _import_opensearch()
    kwargs: dict[str, Any] = {
        "hosts": [{"host": host, "port": port}],
        "use_ssl": use_ssl,
        "verify_certs": use_ssl,
    }
    if http_auth:
        kwargs["http_auth"] = http_auth
    kwargs["timeout"] = 300
    return OpenSearch(**kwargs)


def parse_args() -> argparse.Namespace:
    default_mapping = Path(
        os.environ.get("OPENSEARCH_MAPPING_JSON", str(REPO_ROOT / "deploy/opensearch/index_mappings.json"))
    )
    parser = argparse.ArgumentParser(description="Index boards JSONL with OpenSearch alias swap")
    parser.add_argument("--repo-root", type=Path, default=Path(os.environ.get("FEEDBACK_REPO_ROOT", REPO_ROOT)))
    parser.add_argument(
        "--boards-dir",
        type=Path,
        default=None,
        help="defaults to REPO_ROOT/boards",
    )
    parser.add_argument(
        "--mapping",
        type=Path,
        default=default_mapping,
        help="index body JSON (settings + mappings)",
    )
    parser.add_argument("--alias", default=os.environ.get("OPENSEARCH_ALIAS", "feedback-posts"))
    parser.add_argument(
        "--suffix",
        default=None,
        help="backing index UTC suffix override (default now UTC YYYYmmDDHHMM)",
    )
    parser.add_argument("--url", default=os.environ.get("OPENSEARCH_URL"))
    parser.add_argument("--dry-run", action="store_true", help="print actions only")
    parser.add_argument("--bulk-chunks", type=int, default=320, help="helpers.bulk chunk size")
    parser.add_argument(
        "--keep-prev",
        type=int,
        default=int(os.environ.get("OPENSEARCH_KEEP_PREV_BACKING", "1")),
        help="how many superseded backing indices to retain besides the current backing index",
    )
    parser.add_argument(
        "--no-delete-old",
        action="store_true",
        help="do not DELETE older backing indices after swap",
    )
    parser.add_argument(
        "--no-swap",
        action="store_true",
        help="populate backing index without updating alias (dangerous/testing)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    url = args.url
    if url is None:
        url_str = (
            os.environ.get("OPENSEARCH_URL_DEFAULT")
            or os.environ.get("OPENSEARCH_URL")
            or "http://127.0.0.1:9200"
        )
    else:
        url_str = url
    hp = urlparse_fallback(url_str)
    host, port, use_ssl, http_auth_from_url = hp
    hu = os.environ.get("OPENSEARCH_USER") or ""
    pw = os.environ.get("OPENSEARCH_PASSWORD") or ""
    if hu:
        http_auth = (hu, pw)
    else:
        http_auth = http_auth_from_url

    boards_root = args.boards_dir or (args.repo_root / "boards")
    if not boards_root.is_dir():
        sys.stderr.write(f"boards directory missing: {boards_root}\n")
        return 1

    scraper_id = _scraper_user_id(args.repo_root)
    if scraper_id:
        sys.stderr.write(f"filtering scraper user {scraper_id} from voters/score\n")

    map_path = args.mapping.resolve()
    if not map_path.is_file():
        sys.stderr.write(f"mapping JSON not found: {map_path}\n")
        return 1

    body = load_index_body(map_path)
    alias = args.alias.strip()
    suff = args.suffix or utc_backing_suffix()
    validate_suffix(suff, src="backing suffix")
    new_idx = f"{alias}-{suff}"
    client = None if args.dry_run else build_client(host, port, use_ssl, http_auth)

    if args.dry_run:
        print(f"would PUT index={new_idx} from {map_path}")
        count = sum(1 for _ in iter_board_documents(boards_root, scraper_id=scraper_id))
        print(f"would bulk-index {count} documents")
        print(f'would POST _aliases: point "{alias}" -> {new_idx}')
        if args.no_delete_old:
            print("(skip stale index DELETE)")
        else:
            print(f"(DELETE old backings retain current + prev {args.keep_prev})")
        return 0

    assert client is not None
    if client.indices.exists(index=new_idx):
        sys.stderr.write(f"refusing overwrite: backing index exists: {new_idx}\n")
        return 2

    reindex_start = time.perf_counter()

    client.indices.create(index=new_idx, body=body)

    def docs() -> Iterable[tuple[str, dict[str, Any]]]:
        yield from iter_board_documents(boards_root, scraper_id=scraper_id)

    bulk_start = time.perf_counter()
    _, bulk = _import_opensearch()
    n_ok, _ = bulk(
        client,
        gen_bulk(new_idx, docs()),
        stats_only=False,
        raise_on_error=True,
        request_timeout=300,
        chunk_size=args.bulk_chunks,
    )
    client.indices.refresh(index=new_idx)
    bulk_elapsed = time.perf_counter() - bulk_start
    rate = n_ok / bulk_elapsed if bulk_elapsed > 0 else 0.0
    print(
        f"bulk-indexed {n_ok} docs into {new_idx} in {bulk_elapsed:.1f}s ({rate:.0f} docs/s)",
        file=sys.stderr,
    )

    print(f'alias "{alias}" -> {new_idx}', file=sys.stderr)

    if args.no_swap:
        sys.stderr.write("warning: skipped alias swap (--no-swap)\n")
    else:
        atomic_alias_swap(client, alias, new_idx)

    if not args.no_delete_old:
        delete_stale_backing(
            client,
            alias,
            new_idx,
            dry_run=False,
            keep_prev=max(0, args.keep_prev),
        )

    reindex_elapsed = time.perf_counter() - reindex_start
    print(
        f"reindex complete: {n_ok} docs, alias {alias} -> {new_idx}, "
        f"total {reindex_elapsed:.1f}s",
        file=sys.stderr,
    )

    return 0


def urlparse_fallback(urlstr: str) -> tuple[str, int, bool, tuple[str, str] | None]:
    from urllib.parse import urlparse

    u = urlparse(urlstr)
    host = u.hostname or "127.0.0.1"
    port = u.port or (443 if u.scheme == "https" else 9200)
    sslv = u.scheme == "https"
    user_pass = None
    if u.username:
        pwd = u.password or ""
        user_pass = (u.username, pwd)
    return (host, port, sslv, user_pass)


if __name__ == "__main__":
    raise SystemExit(main())
