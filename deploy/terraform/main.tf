locals {
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    repo_clone_dir = var.repo_clone_dir
    repo_url       = var.repo_url
  })
}

resource "hcloud_ssh_key" "admin" {
  name       = "${var.server_name}-admin"
  public_key = var.ssh_public_key
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

  dynamic "rule" {
    for_each = var.enable_public_https ? [1] : []
    content {
      description = "HTTP for ACME http-01 and redirects"
      direction   = "in"
      protocol    = "tcp"
      port        = "80"
      source_ips  = ["0.0.0.0/0", "::/0"]
    }
  }

  dynamic "rule" {
    for_each = var.enable_public_https ? [1] : []
    content {
      description = "HTTPS for nginx proxy"
      direction   = "in"
      protocol    = "tcp"
      port        = "443"
      source_ips  = ["0.0.0.0/0", "::/0"]
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
