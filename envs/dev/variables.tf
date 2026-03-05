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

variable "tags" {
  type        = map(string)
  description = "Common resource tags."
  default     = {}
}


variable "enable_event_hubs" {
  type    = bool
  default = false
}

variable "enable_private_endpoints" {
  type    = bool
  default = false
}

variable "enable_aml" {
  type    = bool
  default = true
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
}

variable "sqlcon_secret_name" {
  type = string
}

variable "my_public_ip_cidr" {
  type    = string
  default = null
}

variable "app_fqdn" {
  type = string
}