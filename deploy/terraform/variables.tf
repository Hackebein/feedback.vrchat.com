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
  description = "Open inbound TCP 80 (ACME / redirect) and 443 when nginx + TLS front OpenSearch."
  default     = true
}

variable "repo_url" {
  type        = string
  description = "Git clone URL for this repository"
  default     = "https://github.com/Hackebein/feedback.vrchat.com.git"
}
