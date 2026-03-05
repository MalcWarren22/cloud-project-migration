resource "azurerm_monitor_diagnostic_setting" "az_monitor" {
  name = var.diagnostic_name
  target_resource_id = var.target_resource_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

dynamic "enabled_log" {
    for_each = toset(var.log_category)
    content {
      category = enabled_log.value
    }
  }

  dynamic "metric" {
    for_each = toset(var.metric_category)
    content {
      category = metric.value
      enabled  = true
    }
  }
}