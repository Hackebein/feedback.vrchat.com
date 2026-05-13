locals {
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    repo_url            = var.repo_url
    enable_public_https = var.enable_public_https
    cf_api_token        = var.CF_API_TOKEN
  })

  # Cloudflare publishes its current edge IPv4 / IPv6 ranges at these
  # unauthenticated URLs. Pulled at every `terraform apply` so the firewall
  # tracks Cloudflare's current ranges (rotations are rare and Cloudflare
  # commits to ~24h notice). Local nginx also pulls the same lists for the
  # `set_real_ip_from` directives — see deploy/scripts/install_cloudflare_real_ip.sh.
  cf_ipv4 = compact(split("\n", trimspace(data.http.cloudflare_ipv4.response_body)))
  cf_ipv6 = compact(split("\n", trimspace(data.http.cloudflare_ipv6.response_body)))
}

data "http" "cloudflare_ipv4" {
  url = "https://www.cloudflare.com/ips-v4"
}

data "http" "cloudflare_ipv6" {
  url = "https://www.cloudflare.com/ips-v6"
}

resource "hcloud_ssh_key" "admin" {
  name       = "${var.server_name}-admin"
  public_key = var.SSH_PUBLIC_KEY
}

resource "hcloud_firewall" "opensearch" {
  name = "${var.server_name}-fw"

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.allowed_ssh_cidr
  }

  # Inbound 80/443 only from Cloudflare. Direct-IP connections to the origin
  # are dropped at the network edge — Cloudflare is the ONLY origin path.
  dynamic "rule" {
    for_each = var.enable_public_https ? [1] : []
    content {
      description = "HTTP via Cloudflare (redirect-to-HTTPS only; origin TLS is Cloudflare Origin CA)"
      direction   = "in"
      protocol    = "tcp"
      port        = "80"
      source_ips  = concat(local.cf_ipv4, local.cf_ipv6)
    }
  }

  dynamic "rule" {
    for_each = var.enable_public_https ? [1] : []
    content {
      description = "HTTPS via Cloudflare"
      direction   = "in"
      protocol    = "tcp"
      port        = "443"
      source_ips  = concat(local.cf_ipv4, local.cf_ipv6)
    }
  }
}

resource "hcloud_server" "opensearch" {
  name        = var.server_name
  server_type = var.server_type
  image       = var.image
  location    = var.location

  ssh_keys  = [hcloud_ssh_key.admin.id]
  user_data = local.user_data

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  firewall_ids = [hcloud_firewall.opensearch.id]
}
