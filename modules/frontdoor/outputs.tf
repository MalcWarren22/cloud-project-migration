output "fd_endpoint_hostname" {
  value = azurerm_cdn_frontdoor_endpoint.this.host_name
}

output "fd_profile_id" {
  value = azurerm_cdn_frontdoor_profile.this.id
}