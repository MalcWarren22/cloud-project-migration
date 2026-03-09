variable "project_name" {
  type        = string
  description = "Short project identifier used in naming."
}

variable "environment" {
  type        = string
  description = "Environment name (dev/prod)."
}

variable "location" {
  type        = string
  description = "Azure region."
}

variable "enable_event_hubs" {
  type    = bool
  default = false
  description = "Enables Event Hubs for Data ingestion if necessary"
}

variable "enable_private_endpoints" {
  type    = bool
  default = false
  description = "Enables Private Endpoints on PAAS services"
}

variable "tenant_id" {
  description = "The Tenants ID"
  type        = string
}

variable "kv_name" {
  description = "The Name for the Keyvault"
  type        = string
}

variable "ai_language_key_secret_name" {
  type = string
  description = "The Name for Azure AI Language Secret Key"
}

variable "sqlcon_secret_name" {
  type = string
  description = "Name of the SQL Connection string secret"
}
