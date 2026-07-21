# Deploy

## Provision / destroy

```bash
./deploy/scripts/provision.sh -y
# destroy: cd deploy/terraform && terraform destroy
```

See [`credentials.local.md`](credentials.local.md) for required env vars.

## Inbound mail (Canny notify wake-ups)

Recipient: `canny@vrchat-canny.hackebein.dev` (Postfix on the Hetzner VM).

1. Open Hetzner Cloud firewall TCP/25 (`deploy/terraform/main.tf` → `terraform apply`).
2. DNS (grey cloud / DNS only):

```bash
CF_API_TOKEN=... ./deploy/scripts/cloudflare_set_mx.sh "$(cd deploy/terraform && terraform output -raw server_ipv4)"
```

3. On the host, fill `/etc/feedback-search/mail.env`:
   - `GH_DISPATCH_TOKEN` — fine-grained PAT with **Contents: Read and write** (may be the same value as `GH_ISSUE_TOKEN`; install copies from `github.env` when unset)
4. `sync_runtime_stack.sh` installs/refreshes Postfix via `install_mail_on_server.sh`.

Also set Actions secret `VRCHAT_USERNAME` to the account’s current login email (must match after email cutover).

Canny mail (`@canny.io`) triggers `repository_dispatch` `canny-email`. Other mail to that address is saved under `/var/lib/feedback-search/mail-drop/`.

## After orphan-reset of `main`

Ingest is ff-only. Once:

```bash
git -C /srv/feedback.vrchat.com fetch origin
git -C /srv/feedback.vrchat.com reset --hard origin/main
```

Then ff-only resumes.
