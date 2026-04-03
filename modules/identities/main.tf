data "azuread_group" "sql_admins" {
  security_enabled = true
  display_name = var.sql_admins_group_name
  object_id = var.sql_admins_group_object_id
}

resource "azurerm_role_assignment" "kv_secrets_user" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = var.function_principal_id
}

resource "azurerm_role_assignment" "storage_blob" {
  scope                = var.storage_account_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.function_principal_id
}

resource "azurerm_role_assignment" "storage_queue" {
  scope                = var.storage_account_id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = var.function_principal_id
}

resource "azurerm_role_assignment" "cog_user" {
  scope                = var.cognitive_account_id
  role_definition_name = "Cognitive Services User"
  principal_id         = var.function_principal_id
}
