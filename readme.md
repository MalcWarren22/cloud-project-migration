# Migration to Microsoft Azure

The Sentiment Analysis Dashboard was originally developed as a **local prototype**, where data from external APIs (such as YouTube and Twitter/X) was collected and processed locally. As the project grew, the need for **scalability, security, automation, and cloud-based AI services** led to a migration to **Microsoft Azure**.

The migration transformed the project into a **cloud-native AI analytics platform** using Azure services, enabling automated ingestion of user-generated content, secure secret management, scalable compute, and real-time data visualization.

Infrastructure and services were provisioned using **Terraform**, allowing the environment to be recreated and managed through **Infrastructure as Code (IaC)**.

---

# Azure Architecture

After migration, the system architecture consists of several Azure-managed services working together:

- **Azure Functions**  
  Provides serverless compute for data ingestion, processing API requests, and orchestrating sentiment analysis calls.

- **Azure AI Language Service**  
  Performs natural language processing and sentiment classification (positive, negative, neutral) on collected text data.

- **Azure SQL Database**  
  Stores processed sentiment data, topics, and analytics results used by the dashboard.

- **Azure Key Vault**  
  Securely stores API keys and sensitive configuration values such as:
  - Twitter/X API credentials  
  - YouTube API keys  
  - Azure AI Language service keys  

- **Azure Storage Account**  
  Provides required backend storage for the Azure Functions runtime.

- **Azure Front Door with Web Application Firewall (WAF)**  
  Serves as the global entry point for the application. Front Door routes traffic to the backend services and provides security protections through the integrated Web Application Firewall, which helps mitigate common web exploits and attacks.

- **Static Web Frontend (React + Vite)**  
  Hosts the sentiment dashboard interface used to visualize analytics and sentiment results.

---

# Security and Secret Management

During migration, all sensitive credentials were removed from application code and stored securely in **Azure Key Vault**.

The application accesses these secrets using **Managed Identity and Role-Based Access Control (RBAC)**. This approach prevents credentials from being exposed in code repositories and ensures that only authorized services can retrieve them at runtime.

Additionally, the application is placed **behind Azure Front Door with a Web Application Firewall (WAF)**, which filters incoming traffic and protects against common attack vectors such as:

- SQL injection
- Cross-site scripting (XSS)
- Malicious bot traffic
- Layer 7 web attacks

This design aligns with Azure’s **Zero Trust security model** and cloud-native security best practices.

---

# Infrastructure as Code (Terraform)

The Azure infrastructure is deployed using **Terraform**, allowing the environment to be fully reproducible and version-controlled.

Terraform provisions resources such as:

- Azure Resource Group
- Azure Functions
- Azure Storage Account
- Azure SQL Server and Database
- Azure Key Vault
- Azure AI Language Service
- Azure Front Door + WAF
- Networking and access policies
- Managed Identities
- LAW / Diagnostics

Using IaC ensures consistent deployments across development environments and simplifies updates to the infrastructure.

---

# Alignment with the Microsoft Well-Architected Framework

The migration was designed with guidance from the **Microsoft Well-Architected Framework**, which emphasizes five core pillars for building reliable cloud systems.

## Reliability

The application uses **Azure-managed services** to ensure high availability and fault tolerance. Azure Functions provides automatic scaling and removes the need to manage infrastructure for compute workloads.

**Azure Front Door** acts as the global entry point for the application, providing intelligent routing and high availability for incoming traffic. By placing the application behind Front Door, the system benefits from Microsoft's global edge network and improved resiliency against regional disruptions.

Additionally, Azure SQL Database and Azure Storage provide built-in redundancy and service-level reliability guarantees.

## Security

Security is enforced through multiple layers of Azure services and best practices.

Sensitive secrets are stored in **Azure Key Vault**, and the application retrieves them using **Managed Identity with RBAC permissions**, preventing credentials from being exposed in application code.

The application is also protected by **Azure Front Door’s Web Application Firewall (WAF)**, which inspects incoming requests and blocks malicious traffic before it reaches the backend services. This helps protect the application against common web vulnerabilities and distributed attack patterns.

Together, these controls implement a **defense-in-depth security model**.

## Cost Optimization

The project uses **serverless services**, including Azure Functions, which operate on a consumption-based pricing model. This ensures that compute resources are only used when the system processes requests, minimizing operational costs during periods of inactivity.

## Operational Excellence

Infrastructure is managed through **Terraform**, enabling version-controlled deployments and automated provisioning. This allows environments to be recreated quickly and ensures consistent configurations across development and testing environments.

## Performance Efficiency

Azure’s managed AI services allow the system to process sentiment analysis requests efficiently without requiring dedicated machine learning infrastructure. By using Azure AI Language Services, the application can scale sentiment processing dynamically based on workload demand.