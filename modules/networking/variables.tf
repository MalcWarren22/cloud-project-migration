variable "resource_group_name" {
    description = "The name of the resource group"
    type        = string
}

variable "location" {
  description = "The location of the resource group"
  type        = string
}

variable "environment" {
  description = "The Type of environment"
  type = string
}

variable "project_name" {
  description = "Name of the Project"
  type = string
}

variable "vnet_address_space" {
  description = "The Address space of the Virtual Network"
  type = list(string)
  default = [ "172.20.10.0/24" ]
  # Range = 255.255.255.0  0 - 254 to play with
}

variable "function_subnet_cidr" {
  type = list(string)
  default = [ "172.20.10.0/27" ]
  # 0 - 31
}


variable "private_endpoint_subnet_cidr" {
  type = list(string)
  default = [ "172.20.10.32/27" ]
  # 32 - 63 
}

variable "staticapp_subnet_cidr" {
  type = list(string)
  default = [ "172.20.10.64/27" ]
  # 64 - 95
}