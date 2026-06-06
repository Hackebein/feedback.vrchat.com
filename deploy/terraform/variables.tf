variable "server_name" {
  type        = string
  description = "Hetzner Cloud server name."
  default     = "feedback-opensearch"
}

variable "location" {
  type        = string
  description = "Hetzner location (e.g. nbg1, fsn1, hel1)."
  default     = "fsn1"
}

variable "server_type" {
  type        = string
  description = "Server type (see https://www.hetzner.com/cloud/). cpx22 is a common default in fsn1; if unavailable, try ccx13 or another type listed as available in your location."
  default     = "cpx22"
}

variable "image" {
  type        = string
  description = "OS image (Ubuntu LTS on Hetzner, e.g. ubuntu-24.04)."
  default     = "ubuntu-24.04"
}

variable "SSH_PUBLIC_KEY" {
  type        = string
  description = "SSH public key for admin access (TF_VAR_SSH_PUBLIC_KEY)."
}

variable "allowed_ssh_cidr" {
  type        = list(string)
  description = "CIDRs allowed for SSH."
  default     = ["0.0.0.0/0", "::/0"]
}

variable "enable_public_https" {
  type        = bool
  description = "Open inbound TCP 80 (HTTPS redirect) and 443 for the nginx search edge."
  default     = true
}

variable "repo_url" {
  type        = string
  description = "Git clone URL for this repository"
  default     = "https://github.com/Hackebein/feedback.vrchat.com.git"
}

variable "CF_API_TOKEN" {
  type        = string
  description = "Cloudflare API token (TF_VAR_CF_API_TOKEN). Needs Zone:DNS:Edit + Zone:SSL and Certificates:Edit on the zone. Provisioned to /etc/feedback-search/cf.env on first boot for Cloudflare Origin CA cert issuance."
  sensitive   = true
}

variable "GH_ISSUE_TOKEN" {
  type        = string
  description = "GitHub fine-grained PAT (TF_VAR_GH_ISSUE_TOKEN). Needs Issues read and write on this repo. Provisioned to /etc/feedback-search/github.env for deploy-alert issues."
  sensitive   = true
  default     = ""
}
