output "function_principal_id" {
  value = azurerm_linux_function_app.this.identity[0].principal_id
}

output "function_app_name" {
  value = azurerm_linux_function_app.this.name
}

output "function_app_id" {
  value = azurerm_linux_function_app.this.id
}

output "database_id" {
  value = azurerm_mssql_database.this.id
}

output "db_server_id" {
  value = azurerm_mssql_server.this.id
}

output "database_name" {
  value = azurerm_mssql_database.this.name
}

output "swa_default_hostname" {
  value = azurerm_static_web_app.staticapp.default_host_name
}

output "functions_default_hostname" {
  value = azurerm_linux_function_app.this.default_hostname
}

output "storage_id" {
  value = azurerm_storage_account.this.id
}

output "cognitive_id" {
  value = azurerm_cognitive_account.this.id
}
