#!/usr/bin/env bash
# Open or update a deploy-alert GitHub issue (dedup by kind marker in title).
set -euo pipefail

KIND="${1:?kind required}"
TITLE="${2:?title required}"
BODY_FILE="${3:-}"

if [[ -f /etc/feedback-search/github.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/feedback-search/github.env
  set +a
fi

if [[ -z "${GH_ISSUE_TOKEN:-}" ]]; then
  echo "[open_github_issue] GH_ISSUE_TOKEN not set; skipping ${KIND}" >&2
  exit 0
fi

REPO_ROOT="${FEEDBACK_REPO_ROOT:-/srv/feedback.vrchat.com}"
REMOTE_URL="$(git -C "${REPO_ROOT}" config --get remote.origin.url || true)"
if [[ -z "${REMOTE_URL}" ]]; then
  echo "[open_github_issue] no git remote.origin.url in ${REPO_ROOT}" >&2
  exit 1
fi

if [[ -n "${BODY_FILE}" && "${BODY_FILE}" != "-" && -f "${BODY_FILE}" ]]; then
  BODY="$(cat "${BODY_FILE}")"
elif [[ "${BODY_FILE}" == "-" ]] || [[ ! -t 0 ]]; then
  BODY="$(cat)"
else
  BODY="(no details provided)"
fi

MARKER="[deploy-alert] ${KIND}"
FULL_TITLE="${MARKER} ${TITLE}"

export KIND MARKER FULL_TITLE BODY REMOTE_URL GH_ISSUE_TOKEN
exec python3 - <<'PY'
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

token = os.environ["GH_ISSUE_TOKEN"]
remote = os.environ["REMOTE_URL"]
marker = os.environ["MARKER"]
full_title = os.environ["FULL_TITLE"]
body = os.environ["BODY"]

m = re.search(r"github\.com[:/](?P<owner>[^/:]+)[:/](?P<repo>[^/]+?)(?:\.git)?$", remote)
if not m:
    print(f"[open_github_issue] cannot parse owner/repo from {remote!r}", file=sys.stderr)
    sys.exit(1)

owner, repo = m.group("owner"), m.group("repo")
repo_api = f"https://api.github.com/repos/{owner}/{repo}"


def request(method: str, url: str, payload: dict | None = None) -> dict | list:
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "feedback-deploy-alert",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        print(f"[open_github_issue] {method} {url} -> HTTP {e.code}: {err}", file=sys.stderr)
        sys.exit(1)


q = urllib.parse.quote(f"repo:{owner}/{repo} is:issue is:open in:title {marker}")
search_url = f"https://api.github.com/search/issues?q={q}&per_page=5"
search = request("GET", search_url)
items = search.get("items", []) if isinstance(search, dict) else []

comment_body = f"Recurring alert ({os.environ['KIND']}) at {__import__('datetime').datetime.utcnow().isoformat()}Z\n\n{body}"

if items:
    issue = items[0]
    number = issue["number"]
    request("POST", f"{repo_api}/issues/{number}/comments", {"body": comment_body})
    print(f"[open_github_issue] commented on #{number}", flush=True)
else:
    created = request(
        "POST",
        f"{repo_api}/issues",
        {"title": full_title, "body": comment_body},
    )
    print(f"[open_github_issue] created #{created.get('number')}", flush=True)
PY
