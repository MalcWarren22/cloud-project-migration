resource "azurerm_virtual_network" "this" {
    name                = "vnet-${var.environment}-${var.project_name}"
    location            = var.location
    resource_group_name = var.resource_group_name
    address_space       = var.vnet_address_space
}

resource "azurerm_subnet" "pe" {
    name                 = "subnet-${var.environment}-${var.project_name}-pe"
    resource_group_name  = var.resource_group_name
    virtual_network_name = azurerm_virtual_network.this.name
    address_prefixes     = var.private_endpoint_subnet_cidr
    
    private_endpoint_network_policies = "Disabled"
}

resource "azurerm_subnet" "func" {
   resource_group_name = var.resource_group_name
   name = "subnet-${var.environment}-${var.project_name}-func"
   virtual_network_name = azurerm_virtual_network.this.name
   address_prefixes = var.function_subnet_cidr

   delegation {
     name = "webapp-delegation"

     service_delegation {
       name = "Microsoft.Web/serverFarms"
       actions = [
            "Microsoft.Network/virtualNetworks/subnets/action"
       ]
     }
   }
}


resource "azurerm_subnet" "static" {
  name = "subnet-${var.environment}-staticapp"
  resource_group_name = var.resource_group_name
  address_prefixes = var.staticapp_subnet_cidr
  virtual_network_name = azurerm_virtual_network.this.name
}