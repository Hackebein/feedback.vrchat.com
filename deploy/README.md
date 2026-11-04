# Deploy

## Provision / destroy

```bash
./deploy/scripts/provision.sh -y
# destroy: cd deploy/terraform && terraform destroy
```

See [`credentials.local.md`](credentials.local.md) for required env vars.

## Scraper HTTP connections

Install the updater dependencies with `python3 -m pip install -r scripts/requirements-update.txt`.
Bulk board, post and voter reads use PycURL with a reusable connection cache per
fetch worker. Each worker stage closes its connections after joining all workers;
main-thread requests close at the end of the run, including early exits.

`CANNY_HTTP_TRANSPORT=pooled` is the default. Set `CANNY_HTTP_TRANSPORT=curl` before
starting the updater to temporarily restore per-request curl subprocesses. Both
paths apply the same Canny proxy configuration and sticky session. A failed proxy
does not trigger direct requests. Authentication, SSO and voting retain their
separate cookie-aware curl transport.

The `[HTTP]` summary includes `connections`, the number of successful new
connections created by bulk requests. Compare it with `requests` and elapsed time;
redirects can create extra connections, so this is not an exact reuse percentage.
Run `python3 scripts/test_canny_http.py` for loopback HTTP, SOCKS5 and HTTP proxy
checks. The TLS fixture generates a temporary self-signed certificate using OpenSSL.

## Canny host daemon (notifications + new posts + upvotes)

Long-running `feedback-canny-wake.service` SSO-polls Canny every **30s**
(`/api/notifications/get` + public newest listings). When it sees new
notification IDs or post IDs missing from on-disk `boards/`, it fires
`repository_dispatch` `canny-wake` so Actions runs a light scrape
(`--refresh-oldest 0 --refresh-newest 0 --vote-batch 0`).

SSO failures back off for **15 minutes** (`CANNY_SSO_BACKOFF_SECS`) so a
dead Canny session cannot hammer VRChat `/sso/canny` into HTTP 429. The
cookie jar must not use `Domain=.vrchat.com` (that suffix matches
`feedback.vrchat.com` and leaks VRChat `auth` into Canny). Curl cookie
writes are merged so a Canny request does not wipe VRChat cookies.

If Canny returns `{"error":"invalid token"}` after a successful VRChat
login, the JWT from `GET /api/1/sso/canny` is being rejected (signature
or payload). Public board scrape still runs; notifications and votes
need Canny to accept that token again.

Separately, every **65s** it upvotes up to **10** most-active unscored posts
(skips the rest of that cycle on HTTP 429). Vote progress lives in
`/var/lib/feedback-search/canny-wake-state.json` (`votedPostIds`).

Scan (`scripts/update.py`) then removes that leftover upvote when a refreshed
post’s complete voter list is only the scrape bot (`POST /api/posts/vote`
`score: 0`). Canny keeps the post at score 0. This cleanup runs even when
`--vote-batch 0`; the host still owns the upvote backlog.

1. On the host, fill `/etc/feedback-search/canny.env` with the same
   `VRCHAT_USERNAME` / `VRCHAT_PASSWORD` / `VRCHAT_TOTP_SECRET` used by
   Actions. Install creates an empty skeleton.
2. Ensure `/etc/feedback-search/github.env` has `GH_ISSUE_TOKEN` with
   **Contents: Read and write** (enough for `repository_dispatch`), or set
   `GH_DISPATCH_TOKEN` in `canny.env`.
3. `sync_runtime_stack.sh` installs/enables the daemon via
   `install_canny_wake_on_server.sh` and tears down any legacy Postfix mail wake-up.

Also set Actions secret `VRCHAT_USERNAME` to the account’s current login email.
CI schedule voting defaults to `--vote-batch 0` (host owns upvotes).

```bash
systemctl status feedback-canny-wake.service
journalctl -u feedback-canny-wake.service -f
```

After changing the Hetzner firewall (SMTP/25 removed), run `terraform apply` from
`deploy/terraform`.

## After orphan-reset of `main`

Ingest is ff-only. Once:

```bash
git -C /srv/feedback.vrchat.com fetch origin
git -C /srv/feedback.vrchat.com reset --hard origin/main
```

Then ff-only resumes.
