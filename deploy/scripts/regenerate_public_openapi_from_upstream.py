#!/usr/bin/env python3
"""
Build deploy/nginx/vrchat-feedback-search-openapi.json by slicing the
amalgamated OpenSearch API specification down to the public routes nginx
exposes.

Requires PyYAML: pip install PyYAML

By default the tool downloads the rolling **main-latest** amalgamated YAML
from the opensearch-api-specification GitHub releases. Override with
``--upstream-url`` or ``--upstream-file``.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

try:
    import yaml
except ImportError:
    sys.stderr.write("Install PyYAML: pip install PyYAML\n")
    raise

SPEC_REPO_RELEASE_BASE = (
    "https://github.com/opensearch-project/opensearch-api-specification/releases/download"
)
MAIN_LATEST_ASSET = f"{SPEC_REPO_RELEASE_BASE}/main-latest/opensearch-openapi.yaml"

HTTP_OPS = frozenset({"get", "post", "put", "patch", "delete", "options", "head", "trace"})
INDEX_PATH_PARAM_REF = "___path.index"

ROUTES: list[tuple[str, str, frozenset[str], str]] = [
    ("/health", "/_cluster/health", frozenset({"get"}), "Cluster"),
    ("/_mapping", "/{index}/_mapping", frozenset({"get"}), "Index"),
    ("/_count", "/{index}/_count", frozenset({"get", "post"}), "Index"),
    ("/_field_caps", "/{index}/_field_caps", frozenset({"get", "post"}), "Search"),
    ("/_doc/{id}", "/{index}/_doc/{id}", frozenset({"get", "head"}), "Index"),
    ("/_source/{id}", "/{index}/_source/{id}", frozenset({"get", "head"}), "Index"),
    ("/_search", "/{index}/_search", frozenset({"get", "post"}), "Search"),
]


def load_yaml_from_url(url: str) -> dict[str, Any]:
    req = Request(url, headers={"User-Agent": "vrchat-feedback-openapi-gen/1.0"})
    with urlopen(req, timeout=180) as r:  # noqa: S310 — project release URLs
        return yaml.safe_load(r.read().decode("utf-8"))


def load_upstream(path: str | None, url: str | None) -> dict[str, Any]:
    if path:
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f)
    assert url
    return load_yaml_from_url(url)


def _collect_refs(obj: Any, out: list[str]) -> None:
    if isinstance(obj, dict):
        ref = obj.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/"):
            out.append(ref)
        for v in obj.values():
            _collect_refs(v, out)
    elif isinstance(obj, list):
        for i in obj:
            _collect_refs(i, out)


def strip_index_path_parameters(op: dict[str, Any]) -> None:
    params = op.get("parameters")
    if not isinstance(params, list):
        return
    filtered: list[Any] = []
    for p in params:
        if isinstance(p, dict):
            ref = p.get("$ref")
            if isinstance(ref, str) and INDEX_PATH_PARAM_REF in ref:
                continue
        filtered.append(p)
    op["parameters"] = filtered


def build_path_item(
    upstream_paths: dict[str, Any],
    upstream_key: str,
    allowed: frozenset[str],
    tag: str,
) -> dict[str, Any]:
    if upstream_key not in upstream_paths:
        raise KeyError(f"upstream paths missing {upstream_key!r}")
    src = upstream_paths[upstream_key]
    out: dict[str, Any] = {}
    for key, val in src.items():
        lk = key.lower()
        if lk in HTTP_OPS:
            if lk not in allowed:
                continue
            if not isinstance(val, dict):
                out[key] = copy.deepcopy(val)
                continue
            op_copy = copy.deepcopy(val)
            strip_index_path_parameters(op_copy)
            op_copy["tags"] = [tag]
            out[key] = op_copy
        else:
            out[key] = copy.deepcopy(val)
    return out


def absorb_components(upstream: dict[str, Any], doc: dict[str, Any], root: Any) -> None:
    pending: list[str] = []
    _collect_refs(root, pending)
    ucomp = upstream.get("components") or {}
    ocomp = doc.setdefault("components", {})

    while pending:
        ref = pending.pop()
        if not ref.startswith("#/components/"):
            continue
        rest = ref[len("#/components/") :]
        parts = rest.split("/", 1)
        if len(parts) != 2:
            continue
        sect, key = parts
        bucket: dict[str, Any] = ocomp.setdefault(sect, {})
        if key in bucket:
            continue
        if key not in (ucomp.get(sect) or {}):
            raise KeyError(f"upstream spec missing component {ref}")
        piece = copy.deepcopy(ucomp[sect][key])
        bucket[key] = piece
        _collect_refs(piece, pending)


def main() -> int:
    deploy_dir = Path(__file__).resolve().parents[1]

    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--upstream-url",
        default=MAIN_LATEST_ASSET,
        metavar="URL",
        help=(
            f"Amalgamated OpenAPI YAML URL (default: main-latest — {MAIN_LATEST_ASSET})"
        ),
    )
    ap.add_argument(
        "--upstream-file",
        help="Local path to opensearch-openapi.yaml (overrides --upstream-url)",
    )
    ap.add_argument(
        "-o",
        "--out",
        default=str(deploy_dir / "nginx" / "vrchat-feedback-search-openapi.json"),
        help="Output OpenAPI JSON path",
    )
    args = ap.parse_args()

    if args.upstream_file:
        upstream = load_upstream(args.upstream_file, None)
        download_url = f"file:{Path(args.upstream_file).resolve()}"
    else:
        upstream = load_upstream(None, args.upstream_url)
        download_url = args.upstream_url

    upstream_paths = upstream.get("paths") or {}

    ui = upstream.get("info") or {}
    doc: dict[str, Any] = {
        "openapi": "3.1.0",
        "info": {
            "title": "VRChat Feedback Search",
            "version": "2.0.0",
            "description": (
                "Read-only public HTTP surface for feedback search. "
                "Schemas and operations are sliced from the OpenSearch Project "
                "[opensearch-api-specification](https://github.com/opensearch-project/opensearch-api-specification) "
                "amalgamated OpenAPI document. "
                f"Bundle URL: {download_url}. "
                f"Upstream bundle `info.version` is {ui.get('version', '?')!r} "
                f"(`x-api-version`: {ui.get('x-api-version', '?')!r}). "
                "`{index}` path parameters from the upstream spec are omitted here because the alias is fixed."
            ),
            "x-upstream-download": {
                "url": download_url,
            },
            "x-upstream-spec": {
                "title": ui.get("title"),
                "version": ui.get("version"),
                "x-api-version": ui.get("x-api-version"),
            },
        },
        "externalDocs": {
            "description": "OpenSearch — Search API reference",
            "url": "https://opensearch.org/docs/latest/api-reference/search/",
        },
        "servers": [{"url": "https://vrchat-canny.hackebein.dev"}],
        "tags": [
            {"name": "Search", "description": "Single-index search and field capabilities."},
            {"name": "Index", "description": "Read-only mapping, counts, documents."},
            {"name": "Cluster", "description": "Cluster health."},
        ],
        "paths": {},
        "components": {},
    }

    for public_path, upstream_path, methods, tag in ROUTES:
        doc["paths"][public_path] = build_path_item(upstream_paths, upstream_path, methods, tag)

    absorb_components(upstream, doc, doc["paths"])

    outpath = args.out
    with open(outpath, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")

    nparam = len(doc.get("components", {}).get("parameters", {}))
    nschema = len(doc.get("components", {}).get("schemas", {}))
    nresp = len(doc.get("components", {}).get("responses", {}))
    nbody = len(doc.get("components", {}).get("requestBodies", {}))
    sys.stderr.write(
        f"Wrote {outpath} ({len(doc['paths'])} paths; "
        f"components: {nparam} parameters, {nschema} schemas, {nresp} responses, {nbody} requestBodies)\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
