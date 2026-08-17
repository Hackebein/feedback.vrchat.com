"""Parse VRChat in-client bug-report Details templates."""

from __future__ import annotations

import re
from typing import Any, TypedDict

CATEGORIES: dict[str, str] = {
    "audio": "audio",
    "avatar": "avatar",
    "world": "world",
    "user interface": "user-interface",
    "performance": "performance",
    "networking": "networking",
    "other": "other",
}

FREQUENCIES: dict[str, str] = {
    "once": "once",
    "sometimes": "sometimes",
    "often": "often",
    "always": "always",
}

_FIELD_RE = re.compile(
    r"(?im)^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?"
    r"(Category|Frequency|platform|rawPlatform|clientVersion|unityVersion)"
    r"(?:\*\*)?[ \t]*:[ \t]*(.+?)\s*$"
)
_INNER_FIELD_RE = re.compile(
    r"(?i)(platform|store|headset)\s*:\s*([^,]+?)(?=\s*,\s*(?:platform|store|headset)\s*:|$)"
)
_IN_CLIENT_REPORT_RE = re.compile(r"(?im)^\s*In-Client Report\s*$")


class InClientReport(TypedDict):
    category: str
    category_label: str
    frequency: str
    frequency_label: str
    platform: str
    platform_line: str
    inner_platform: str
    store: str
    headset: str
    raw_platform: str
    client_version: str
    unity_version: str
    has_in_client_report: bool


def slugify(value: str) -> str:
    text = value.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def _norm_key(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def _last_fields(details: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for match in _FIELD_RE.finditer(details):
        found[match.group(1)] = match.group(2).strip()
    return found


def _split_platform_line(line: str) -> tuple[str, str, str, str]:
    leading = line
    inner = ""
    paren = line.find("(")
    if paren >= 0:
        leading = line[:paren].strip()
        close = line.rfind(")")
        inner = line[paren + 1 : close if close > paren else None].strip()
    leading_token = leading.split()[0] if leading.split() else ""
    inner_fields = {k.lower(): v.strip() for k, v in _INNER_FIELD_RE.findall(inner)}
    return (
        leading_token,
        inner_fields.get("platform", ""),
        inner_fields.get("store", ""),
        inner_fields.get("headset", ""),
    )


def parse_in_client_template(details: Any) -> InClientReport | None:
    """Return structured template fields, or None if the Details block is absent.

    Detection is the client template shape (Category, Frequency, platform,
    rawPlatform, clientVersion, unityVersion). Label language does not matter.
    English labels are canonicalized for search tags; any other wording still
    counts as in-client with those tags omitted.
    """
    if not isinstance(details, str) or not details.strip():
        return None
    fields = _last_fields(details)
    category_raw = fields.get("Category", "")
    frequency_raw = fields.get("Frequency", "")
    platform_line = fields.get("platform", "")
    raw_platform = fields.get("rawPlatform", "")
    client_version = fields.get("clientVersion", "")
    unity_version = fields.get("unityVersion", "")
    if not (
        category_raw
        and frequency_raw
        and platform_line
        and raw_platform
        and client_version
        and unity_version
    ):
        return None

    leading, inner_platform, store, headset = _split_platform_line(platform_line)
    platform = slugify(leading) or slugify(raw_platform)
    if not platform:
        return None

    return {
        "category": CATEGORIES.get(_norm_key(category_raw), ""),
        "category_label": category_raw.strip(),
        "frequency": FREQUENCIES.get(_norm_key(frequency_raw), ""),
        "frequency_label": frequency_raw.strip(),
        "platform": platform,
        "platform_line": platform_line,
        "inner_platform": inner_platform,
        "store": store,
        "headset": headset,
        "raw_platform": raw_platform,
        "client_version": client_version,
        "unity_version": unity_version,
        "has_in_client_report": _IN_CLIENT_REPORT_RE.search(details) is not None,
    }


def is_in_client_report(details: Any) -> bool:
    return parse_in_client_template(details) is not None


def client_location_tags(parsed: InClientReport) -> list[str]:
    """Existing taxonomy loc.* / platforms.* ids for the filing client."""
    leading = parsed["platform"]
    raw = parsed["raw_platform"].lower()
    inner = parsed["inner_platform"].lower()
    line = parsed["platform_line"].lower()
    is_quest = leading == "quest" or "quest" in inner or "quest" in line
    if is_quest:
        return ["loc.standalone-vr", "platforms.standalone-vr.quest"]

    is_pc = leading == "pc" or raw in ("windowsplayer", "windowseditor")
    if not is_pc:
        return []

    tags = ["loc.pc-client"]
    store = slugify(parsed["store"])
    if store == "steam":
        tags.append("platforms.pc.steam")
    elif store == "viveport":
        tags.append("platforms.pc.viveport")
    else:
        tags.append("platforms.pc.desktop")
    return tags


def client_location_prior(details: Any) -> str | None:
    parsed = parse_in_client_template(details)
    if parsed is None:
        return None
    for tag in client_location_tags(parsed):
        if tag.startswith("loc."):
            return tag
    return None


def in_client_search_tags(parsed: InClientReport) -> list[str]:
    """Index-only inclient.* tags for template fields."""
    tags: list[str] = []
    if parsed["category"]:
        tags.append(f"inclient.category.{parsed['category']}")
    if parsed["frequency"]:
        tags.append(f"inclient.frequency.{parsed['frequency']}")
    tags.extend(
        [
            f"inclient.platform.{parsed['platform']}",
            f"inclient.raw-platform.{slugify(parsed['raw_platform'])}",
            f"inclient.client-version.{parsed['client_version']}",
            f"inclient.unity-version.{parsed['unity_version']}",
        ]
    )
    store = slugify(parsed["store"])
    if store:
        tags.append(f"inclient.store.{store}")
    headset = parsed["headset"].strip()
    if headset and headset.lower() != "none":
        tags.append(f"inclient.headset.{slugify(headset)}")
    if parsed["has_in_client_report"]:
        tags.append("inclient.report")
    return tags
