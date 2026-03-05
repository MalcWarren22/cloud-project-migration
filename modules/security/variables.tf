variable "resource_group_name" {
  description = "Name of the Resource Group"
}

variable "location" {
  description = "Location of the Project"
  type = string
}

variable "environment" {
  description = "The Environment of the Project"
}

variable "tenant_id" {
  description = "The Tenant's ID"
  type = string
}

variable "function_principal_id" {
  description = "The Functions Principal ID"
  type = string
}

variable "project_name" {
  description = "The name of the Project"
  type = string
}

variable "subnet_id" {
  description = "The Subnet ID for the Functions"
  type = string
}

variable "kv_name" {
  description = "The name of the Keyvault"
  type = string
}

variable "virtual_network_id" {
  description = "The ID of the Virtual Network"
  type = string
}

variable "db_server_id" {
  description = "The ID of the Database Server"
  type = string
}

variable "database_name" {
  description = "The Name of the Database"
  type = string
}
