output "web_law_id" {
  value = azurerm_log_analytics_workspace.web.id
}

output "app_law_id" {
  value = azurerm_log_analytics_workspace.app.id
}

output "app_insights_connection_string" {
  value = azurerm_application_insights.this.connection_string
}