resource "azurerm_log_analytics_workspace" "web" {
  resource_group_name = var.resource_group_name
  location = var.location
  name = "web-law-${var.environment}-${var.project_name}"
}

resource "azurerm_log_analytics_workspace" "app" {
  resource_group_name = var.resource_group_name
  name = "app-law-${var.environment}-${var.project_name}"
  location = var.location
}
resource "azurerm_application_insights" "this" {
    resource_group_name = var.resource_group_name
    name = "appinsights-${var.environment}-${var.project_name}"
    location = var.location
    application_type = "other"

    workspace_id = azurerm_log_analytics_workspace.app.id
}