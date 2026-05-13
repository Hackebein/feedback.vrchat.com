output "server_ipv4" {
  description = "Public IPv4 of the OpenSearch host."
  value       = hcloud_server.opensearch.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 of the OpenSearch host."
  value       = hcloud_server.opensearch.ipv6_address
}

output "ssh_hint" {
  description = "SSH once the host is up."
  value       = "ssh root@${hcloud_server.opensearch.ipv4_address}"
}
