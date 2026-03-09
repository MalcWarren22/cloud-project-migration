variable "resource_group_name" {
  description = "The Name of the Resource Group"
  type = string
}

variable "location" {
  description = "The Location of the Resource Group"
  type = string
}

variable "environment" {
  description = "The type of Environment"
  type = string
}

variable "project_name" {
  description = "The Name of the Project"
}

variable "swa_origin_host" {
  description = "Origin For the SWA endpoint"
  type = string
}

variable "functions_origin_host" {
  description = "Origin For the Functions endpoint"
  type = string
}

variable "enable_waf" {
  type = bool
  default = true
  description = "Status of the Azure Front Door's Web Application Firewall"
}