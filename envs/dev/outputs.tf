output "vnet_id" {
  value = module.networking.vnet_id
}

output "private_endpoint_subnet_id" {
  value = module.networking.private_endpoint_subnet_id
}

output "function_integration_subnet_id" {
  value = module.networking.function_integration_subnet_id
}
output "key_vault_uri" {
  value = module.security.key_vault_uri
}

output "key_vault_id" {
  value = module.security.key_vault_id
}

output "function_principal_id" {
  value = module.apptier.function_principal_id
}
