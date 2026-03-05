output "vnet_id" {
  value = azurerm_virtual_network.this.id
}

output "vnet_name" {
  value = azurerm_virtual_network.this.name
}

output "private_endpoint_subnet_id" {
  value = azurerm_subnet.pe.id
}

output "function_integration_subnet_id" {
  value = azurerm_subnet.func.id
}