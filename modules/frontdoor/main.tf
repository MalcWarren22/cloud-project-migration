resource "azurerm_cdn_frontdoor_profile" "this" {
  resource_group_name = var.resource_group_name
  name = "azurefd-${var.environment}-${var.project_name}"
  sku_name = "Premium_AzureFrontDoor"
}

resource "azurerm_cdn_frontdoor_endpoint" "this" {
  name = "azurefd-${var.environment}-${var.project_name}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  }

  resource "azurerm_cdn_frontdoor_origin_group" "swa" {
    name = "static-web-app"
    cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id

    health_probe {
    interval_in_seconds = 120
    path                = "/*"
    protocol            = "Https"
    request_type        = "GET"
  }

    load_balancing {
      sample_size = 4
      successful_samples_required = 3
      additional_latency_in_milliseconds = 0
    }
  }

  resource "azurerm_cdn_frontdoor_origin" "swa" {
    name = "swa-origin-${var.environment}-${var.project_name}"
    cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.swa.id
    enabled = true
    certificate_name_check_enabled = true
    host_name = var.swa_origin_host
    origin_host_header = var.swa_origin_host
    http_port = 80
    https_port = 443
  }

  resource "azurerm_cdn_frontdoor_origin_group" "func" {
    name = "functions"
    cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id

     health_probe {
    interval_in_seconds = 120
    path                = "/api/health"
    protocol            = "Https"
    request_type        = "GET"
  }
    
    load_balancing {
      sample_size = 4
      successful_samples_required = 3
      additional_latency_in_milliseconds = 0
    }
  }

  resource "azurerm_cdn_frontdoor_origin" "func" {
    name = "func-origin-${var.environment}-${var.project_name}"
    cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.func.id
    enabled = true
    certificate_name_check_enabled = true
    host_name = var.functions_origin_host
    origin_host_header = var.functions_origin_host
    http_port = 80
    https_port = 443
  }

  
resource "azurerm_cdn_frontdoor_route" "swa" {
  name                          = "route-swa"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.this.id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.swa.id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.swa.id]

  patterns_to_match        = ["/*"]
  supported_protocols      = ["Http", "Https"]
  https_redirect_enabled   = true
  forwarding_protocol      = "HttpsOnly"
  link_to_default_domain   = true
}


resource "azurerm_cdn_frontdoor_route" "funcapi" {
  name                          = "route-api"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.this.id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.func.id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.func.id]

  patterns_to_match        = ["/api/*"]
  supported_protocols      = ["Http", "Https"]
  https_redirect_enabled   = true
  forwarding_protocol      = "HttpsOnly"
  link_to_default_domain   = true
}

  resource "azurerm_cdn_frontdoor_firewall_policy" "this" {
    resource_group_name = var.resource_group_name
    name = "fdsentwaf"
    mode = "Detection"
    sku_name = "Premium_AzureFrontDoor"
    enabled = true

    managed_rule {
      type = "DefaultRuleSet"
      version = "1.0"
      action = "Block"
    }

    custom_rule {
      name = "RateLimit"
      enabled = true
      priority = 10
      type = "RateLimitRule"
      action = "Block"
      
      rate_limit_duration_in_minutes = 1
      rate_limit_threshold = 100

      match_condition {
        match_variable = "RemoteAddr"
        operator = "IPMatch"
        match_values = ["0.0.0.0/0"]
        negation_condition = false
      }
    }
  }


  resource "azurerm_cdn_frontdoor_security_policy" "this" {
    name = "fd-waf-policy"
    cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
    
    security_policies {
      firewall {
        cdn_frontdoor_firewall_policy_id = azurerm_cdn_frontdoor_firewall_policy.this.id

        association {
          patterns_to_match = ["/*"]

          domain {
            cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_endpoint.this.id
          }
        }
      }
    }
  }