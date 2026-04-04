resource "azurerm_api_management" "this" {
  name = "funcapim-${var.project_name}-${var.environment}"
  resource_group_name = var.resource_group_name
  location = var.location
  sku_name = var.apim_sku_name
  publisher_name = var.publisher_name
  publisher_email = var.publisher_email
}
resource "azurerm_api_management_api" "this" {
  name = "fapim-${var.project_name}-${var.environment}"
  resource_group_name = var.resource_group_name
  api_management_name = azurerm_api_management.this.name
 
  revision = "1"
  display_name = var.api_display_name
  path = var.api_path
  protocols = ["https"]

  service_url = var.backend_url
}

resource "azurerm_api_management_api_policy" "cors" {
api_management_name = azurerm_api_management.this.name
api_name = azurerm_api_management_api.this.name
resource_group_name = var.resource_group_name

  xml_content = <<XML
<policies>
  <inbound>
    <base />
    <cors allow-credentials="false">
      <allowed-origins>
        <origin>https://azurefd-dev-sentimentanalysisproject-d7fdagh0dhfrerdx.z01.azurefd.net</origin>
        <origin>http://localhost:5173</origin>
      </allowed-origins>
      <allowed-methods preflight-result-max-age="300">
        <method>GET</method>
        <method>POST</method>
        <method>OPTIONS</method>
      </allowed-methods>
      <allowed-headers>
        <header>*</header>
      </allowed-headers>
      <expose-headers>
        <header>*</header>
      </expose-headers>
    </cors>
  </inbound>

  <backend>
    <base />
  </backend>

  <outbound>
    <base />
  </outbound>

  <on-error>
    <base />
  </on-error>
</policies>
XML
}