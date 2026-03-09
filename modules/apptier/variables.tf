variable "location" {
  description = "The Location of the resource group"
  type = string
}

variable "project_name" {
  description = "Name of the Project"
  type = string
}

variable "environment" {
  description = "The Type of environment"
  type = string
}

variable "resource_group_name" {
  description = "The Name of the resource group"
  type = string
}

variable "tags" {
  description = "Tags for the Project"
  type = map(string)
}

variable "enable_aml" {
  description = "Enables Azure Machine Learning"
  type = string
}

variable "enable_event_hubs" {
  description = "Enables Azures Event Hubs"
  type = string
}

variable "enable_private_endpoints" {
  description = "Enables Private Endpoints for services"
  type = string
}

variable "tenant_id" {
  description = "The Tenants ID"
  type = string
}

variable "key_vault_uri" {
  description = "The Key Vault URI"
  type = string
}

variable "function_integration_subnet_id" {
  description = "Function Integration Subnet ID"
  type = string
}

variable "ai_language_key_secret_name" {
  type = string
  description = "The AI Language Key Secret Name"
}

variable "sql_admin_username" {
  type    = string
  default = "sqladminuser"
  description = "Name of the SQL Admin Username"
}

variable "sqlcon_secret_name" {
  type = string
  description = "SQL Connection String Name"
}

variable "key_vault_id" {
  type = string
  description = "ID of the Key Vault"
}

variable "ad_object_id" {
  type = string
  description = "Active Directory object ID"
}

variable "app_insights_connection_string" {
  type = string
  description = "App Insights Connection String"
}