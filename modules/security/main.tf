resource "azurerm_key_vault" "this" {
  resource_group_name = var.resource_group_name
  name = var.kv_name
  location = var.location
  tenant_id = var.tenant_id
  sku_name = "standard"
  enable_rbac_authorization = true
  public_network_access_enabled = true
}

resource "azurerm_private_endpoint" "kv" {
  resource_group_name = var.resource_group_name
  name = "pe-${var.environment}-${var.project_name}-kv"
  location = var.location
  subnet_id = var.subnet_id

  private_service_connection {
    private_connection_resource_id = azurerm_key_vault.this.id
    name = azurerm_key_vault.this.name
    subresource_names = ["vault"]
    is_manual_connection = false
  }

  private_dns_zone_group {
    name = "kv-zone-group"

    private_dns_zone_ids = [
    azurerm_private_dns_zone.kv.id
    ]
  }
}

  
  resource "azurerm_private_dns_zone" "kv" {
  resource_group_name = var.resource_group_name
  name = "privatelink.vaultcore.azure.net"
}

resource "azurerm_private_dns_zone_virtual_network_link" "kv" {
  resource_group_name = var.resource_group_name
  name = "vnet-${var.environment}-${var.project_name}-kv-link"
  virtual_network_id = var.virtual_network_id
  private_dns_zone_name = azurerm_private_dns_zone.kv.name
}





resource "azurerm_private_endpoint" "db" {
  resource_group_name = var.resource_group_name
  name = "pe-${var.environment}-${var.project_name}-db"
  subnet_id = var.subnet_id
  location = var.location

  private_service_connection {
    private_connection_resource_id = var.db_server_id
    name = "${var.database_name}-pe"
    subresource_names = ["sqlServer"]
    is_manual_connection = false
  }

  private_dns_zone_group {
    name = "db-zone-group"

    private_dns_zone_ids = [
      azurerm_private_dns_zone.db.id
    ]
  }
}


  resource "azurerm_private_dns_zone" "db" {
    resource_group_name = var.resource_group_name
    name = "privatelink.database.windows.net"
  }

resource "azurerm_private_dns_zone_virtual_network_link" "db" {
  resource_group_name = var.resource_group_name
  name = "db-${var.environment}-${var.project_name}-link"
  private_dns_zone_name = azurerm_private_dns_zone.db.name
  virtual_network_id = var.virtual_network_id
}