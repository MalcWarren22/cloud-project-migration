variable "location" {
  type = string
  description = "Location of the Identity resources"
}

variable "function_principal_id" {
  type = string
  description = "The ID of the Function Principal"
}

variable "key_vault_id" {
  type = string
  description = "The ID of the Key Vault"
}

variable "storage_account_id" {
  type = string
  description = "The ID of the Storage Account"
}

variable "cognitive_account_id" {
  type = string
  description = "The ID of the Cognitive Account"
}
