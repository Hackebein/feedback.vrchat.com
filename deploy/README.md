# Deploy

Needs **Terraform**, **jq**, and **curl**.

## Deploy

```bash
export HCLOUD_TOKEN='…'
export CF_API_TOKEN='…'
export TF_VAR_SSH_PUBLIC_KEY='…'

deploy/scripts/provision.sh -y
```

## Destroy

```bash
export HCLOUD_TOKEN='…'
cd deploy/terraform && terraform destroy && cd ../..
```

