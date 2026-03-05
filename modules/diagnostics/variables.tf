variable "diagnostic_name" {
  description = "Name for the Diagnostics"
  type = string
}

variable "log_analytics_workspace_id" {
  description = "ID of the LAW"
  type = string
}

variable "target_resource_id" {
  description = "The Target Resource's ID"
  type = string
}

variable "metric_category" {
  description = "Categorization for the Metrics"
  type = list(string)
}

variable "log_category" {
  description = "Categorization for the Logs"
  type = list(string)
}