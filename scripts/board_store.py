"""Per-post board storage: boards/<board-slug>/<post-slug>.json."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parent.parent
BOARD_DIR = ROOT / "boards"


def format_post(post: dict) -> str:
    return json.dumps(post, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def board_slugs() -> list[str]:
    if not BOARD_DIR.is_dir():
        return []
    return sorted(
        p.name for p in BOARD_DIR.iterdir()
        if p.is_dir() and not p.name.startswith("_")
    )


def post_path(board_slug: str, url_slug: str) -> Path:
    return BOARD_DIR / board_slug / f"{url_slug}.json"


def iter_board_posts(board_slug: str) -> Iterator[dict]:
    bdir = BOARD_DIR / board_slug
    if not bdir.is_dir():
        return
    for path in sorted(bdir.glob("*.json")):
        if path.name.endswith(".json.tmp"):
            continue
        with path.open(encoding="utf-8") as fp:
            yield json.load(fp)


def write_post(board_slug: str, post: dict) -> Path:
    url = post.get("urlName")
    if not url or not isinstance(url, str):
        raise ValueError(f"post missing urlName: _id={post.get('_id')!r}")
    cat = post.get("category")
    if isinstance(cat, dict):
        cat.pop("postCount", None)
    bdir = BOARD_DIR / board_slug
    bdir.mkdir(parents=True, exist_ok=True)
    path = bdir / f"{url}.json"
    text = format_post(post)
    if path.is_file() and path.read_text(encoding="utf-8") == text:
        return path
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return path


def delete_post(board_slug: str, url_slug: str) -> bool:
    path = post_path(board_slug, url_slug)
    if not path.is_file():
        return False
    path.unlink()
    return True


def iter_all_posts() -> Iterator[tuple[str, dict]]:
    """Yield (board_slug, post) for every stored post."""
    for slug in board_slugs():
        for post in iter_board_posts(slug):
            yield slug, post


def existing_post_ids() -> set[str]:
    ids: set[str] = set()
    for _slug, post in iter_all_posts():
        pid = post.get("_id")
        if isinstance(pid, str) and pid:
            ids.add(pid)
    return ids
