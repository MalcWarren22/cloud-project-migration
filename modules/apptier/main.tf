locals {
  sqlcon = "Driver={ODBC Driver 18 for SQL Server};Server=tcp:${azurerm_mssql_server.this.fully_qualified_domain_name},1433;Database=${azurerm_mssql_database.this.name};Uid=${var.sql_admin_username};Pwd=${random_password.sql_admin.result};Encrypt=yes;TrustServerCertificate=no;Connection Timeout=30;"
}

resource "azurerm_key_vault_secret" "sqlcon" {
  name         = var.sqlcon_secret_name
  value        = local.sqlcon
  key_vault_id = var.key_vault_id
}


resource "random_password" "sql_admin" {
  length  = 24
  special = true
}


resource "azurerm_mssql_server" "this" {
  name                         = "sql-${var.environment}-db-44v3"
  resource_group_name          = var.resource_group_name
  location                     = var.location
  version                      = "12.0"
  administrator_login          = var.sql_admin_username
  administrator_login_password = random_password.sql_admin.result

  minimum_tls_version = "1.2"

  public_network_access_enabled = true

  azuread_administrator {
    login_username = "sql-admin-sentanalysis"
    object_id = var.ad_object_id
    tenant_id = var.tenant_id
  }
}

resource "azurerm_mssql_database" "this" {
  name      = "sentiment"
  server_id = azurerm_mssql_server.this.id
  sku_name = "Basic"
}

resource "azurerm_mssql_firewall_rule" "allow_azure" {
  name             = "AllowAzureServices"
  server_id        = azurerm_mssql_server.this.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_storage_account" "this" {
    resource_group_name = var.resource_group_name 
    name = "st${var.environment}sentimentanalysis44"
    location = var.location
    account_tier = "Standard"
    account_replication_type = "LRS" 
    access_tier = "Hot"
    allow_nested_items_to_be_public = false
    cross_tenant_replication_enabled = false
}

resource "azurerm_service_plan" "this" {
    resource_group_name = var.resource_group_name
    name = "appservplan-${var.environment}-${var.project_name}"
    location = var.location
    os_type = "Linux"
    sku_name = "EP1"
}

resource "azurerm_linux_function_app" "this" {
  resource_group_name = var.resource_group_name
  name = "functapp-${var.environment}-${var.project_name}"
  location = var.location
  service_plan_id = azurerm_service_plan.this.id
  storage_account_name = azurerm_storage_account.this.name

  storage_uses_managed_identity = true
  virtual_network_subnet_id = var.function_integration_subnet_id
  https_only = true

  identity {
    type = "SystemAssigned"
  }
   app_settings = {
  AI_LANGUAGE_ENDPOINT = azurerm_cognitive_account.this.endpoint

  
  AI_LANGUAGE_KEY = "@Microsoft.KeyVault(SecretUri=${var.key_vault_uri}secrets/${var.ai_language_key_secret_name}/)"
  SQLCON = "@Microsoft.KeyVault(SecretUri=${var.key_vault_uri}secrets/${var.sqlcon_secret_name}/)"
  YOUTUBE_API_KEY      = "@Microsoft.KeyVault(SecretUri=${var.key_vault_uri}secrets/youtube-api-key)"
  TWITTER_ACCESS_TOKEN = "@Microsoft.KeyVault(SecretUri=${var.key_vault_uri}secrets/twitter-access-token)"
  TWITTER_ACCESS_TOKEN_SECRET = "@Microsoft.KeyVault(SecretUri=${var.key_vault_uri}secrets/twitter-access-token-secret)"
  TWITTER_BEARER_TOKEN = "@Microsoft.KeyVault(SecretUri=${var.key_vault_uri}secrets/twitter-bearer-token)"

  APPLICATIONINSIGHTS_CONNECTION_STRING = var.app_insights_connection_string
  FUNCTIONS_WORKER_RUNTIME              = "python"
  FUNCTIONS_EXTENSION_VERSION           = "~4"

  AzureWebJobsStorage__accountName      = azurerm_storage_account.this.name
  WEBSITE_RUN_FROM_PACKAGE = "1"

  TOPIC_DEFAULT = "demo"
  ENV           = var.environment
}

  site_config {
    always_on = true
    vnet_route_all_enabled = true
    application_stack {
      python_version = "3.11"
    }
  }
}

resource "azurerm_cognitive_account" "this" {
  resource_group_name = var.resource_group_name
  name = "ailanguage-${var.environment}-${var.project_name}"
  location = var.location
  kind = "TextAnalytics"
  sku_name = "F0"

  custom_subdomain_name = "cog-sentiment-${var.environment}"
}

resource "azurerm_static_web_app" "staticapp" {
  resource_group_name = var.resource_group_name
  name = "sentiment-dev-staticapp"
  location = var.location
}

