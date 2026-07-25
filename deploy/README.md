# Deploy

## Provision / destroy

```bash
./deploy/scripts/provision.sh -y
# destroy: cd deploy/terraform && terraform destroy
```

See [`credentials.local.md`](credentials.local.md) for required env vars.

## Canny host daemon (notifications + new posts + upvotes)

Long-running `feedback-canny-wake.service` SSO-polls Canny every **30s**
(`/api/notifications/get` + public newest listings). When it sees new
notification IDs or post IDs missing from on-disk `boards/`, it fires
`repository_dispatch` `canny-wake` so Actions runs a light scrape
(`--refresh-oldest 0 --refresh-newest 0 --vote-batch 0`).

Separately, every **65s** it upvotes up to **10** most-active unscored posts
(skips the rest of that cycle on HTTP 429). Vote progress lives in
`/var/lib/feedback-search/canny-wake-state.json` (`votedPostIds`).

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
