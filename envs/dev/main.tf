resource "azurerm_resource_group" "this" {
  location = var.location
  name     = "rg-${var.environment}-${var.project_name}"
}

module "identities" {
  source                     = "../../modules/identities"
  storage_account_id         = module.apptier.storage_id
  key_vault_id               = module.security.key_vault_id
  function_principal_id      = module.apptier.function_principal_id
  cognitive_account_id       = module.apptier.cognitive_id
  location                   = var.location
  sql_admins_group_name      = var.sql_admins_group_name
  sql_admins_group_object_id = var.sql_admins_group_object_id
}

module "networking" {
  source              = "../../modules/networking"
  resource_group_name = azurerm_resource_group.this.name
  project_name        = var.project_name
  environment         = var.environment
  location            = var.location
}

module "apptier" {
  source                         = "../../modules/apptier"
  resource_group_name            = azurerm_resource_group.this.name
  project_name                   = var.project_name
  environment                    = var.environment
  location                       = var.location
  function_integration_subnet_id = module.networking.function_integration_subnet_id
  enable_event_hubs              = var.enable_event_hubs
  enable_private_endpoints       = var.enable_private_endpoints
  tenant_id                      = var.tenant_id
  key_vault_uri                  = module.security.key_vault_uri
  ai_language_key_secret_name    = var.ai_language_key_secret_name
  sqlcon_secret_name             = var.sqlcon_secret_name
  key_vault_id                   = module.security.key_vault_id
  ad_object_id                   = module.identities.object_id
  app_insights_connection_string = module.observability.app_insights_connection_string
}

module "security" {
  source                = "../../modules/security"
  resource_group_name   = azurerm_resource_group.this.name
  environment           = var.environment
  location              = var.location
  tenant_id             = var.tenant_id
  function_principal_id = module.apptier.function_principal_id
  virtual_network_id    = module.networking.vnet_id
  subnet_id             = module.networking.private_endpoint_subnet_id
  db_server_id          = module.apptier.db_server_id
  database_name         = module.apptier.database_name
  kv_name               = var.kv_name
  project_name          = var.project_name
}

module "frontdoor" {
  source                = "../../modules/frontdoor"
  resource_group_name   = azurerm_resource_group.this.name
  environment           = var.environment
  location              = var.location
  project_name          = var.project_name
  swa_origin_host       = module.apptier.swa_default_hostname
  functions_origin_host = module.apptier.functions_default_hostname
}

module "observability" {
  source              = "../../modules/observability"
  resource_group_name = azurerm_resource_group.this.name
  environment         = var.environment
  location            = var.location
  project_name        = var.project_name
}

module "monitor-fd-diagnostics" {
  source                     = "../../modules/diagnostics"
  diagnostic_name            = "monitor-fd"
  log_analytics_workspace_id = module.observability.web_law_id
  target_resource_id         = module.frontdoor.fd_profile_id
  log_category               = ["FrontDoorAccessLog", "FrontDoorHealthProbeLog", "FrontDoorWebApplicationFirewallLog"]

  metric_category = ["AllMetrics"]
}
module "monitor_storage" {
  source                     = "../../modules/diagnostics"
  diagnostic_name            = "monitor-storage"
  log_analytics_workspace_id = module.observability.app_law_id
  target_resource_id         = module.apptier.storage_id

  log_category = []

  metric_category = ["Transaction", "Capacity"]
}


module "monitor_functions" {
  source                     = "../../modules/diagnostics"
  diagnostic_name            = "monitor-functions"
  log_analytics_workspace_id = module.observability.app_law_id
  target_resource_id         = module.apptier.function_app_id

  log_category = ["FunctionAppLogs"]

  metric_category = ["AllMetrics"]
}

module "monitor_db_sql_server" {
  source                     = "../../modules/diagnostics"
  diagnostic_name            = "monitor-sqlserver"
  log_analytics_workspace_id = module.observability.app_law_id
  target_resource_id         = module.apptier.db_server_id

  log_category = []

  metric_category = ["AllMetrics"]
}

module "monitor_db" {
  source                     = "../../modules/diagnostics"
  diagnostic_name            = "monitor-database"
  log_analytics_workspace_id = module.observability.app_law_id
  target_resource_id         = module.apptier.database_id

  log_category = [
    "AutomaticTuning",
    "QueryStoreRuntimeStatistics",
    "QueryStoreWaitStatistics",
    "Errors",
    "Timeouts",
    "Blocks",
    "Deadlocks",
    "SQLInsights",
    "DatabaseWaitStatistics"
  ]

  metric_category = ["AllMetrics"]
}

