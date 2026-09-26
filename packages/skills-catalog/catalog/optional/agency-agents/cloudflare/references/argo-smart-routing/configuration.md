## Configuration Management

**Note on Smart Shield Evolution:** Argo Smart Routing is being integrated into Smart Shield. Configuration methods below remain valid; Terraform and IaC patterns unchanged.

### Infrastructure as Code (Terraform)

```hcl
# terraform/argo.tf
# Note: Use Cloudflare Terraform provider

resource "cloudflare_argo" "example" {
  zone_id        = var.zone_id
  smart_routing  = "on"
  tiered_caching = "on"
}

variable "zone_id" {
  description = "Cloudflare Zone ID"
  type        = string
}

output "argo_enabled" {
  value       = cloudflare_argo.example.smart_routing
  description = "Argo Smart Routing status"
}
```

### Environment-Based Configuration

```typescript
// config/argo.ts
interface ArgoEnvironmentConfig {
  enabled: boolean;
  tieredCache: boolean;
  monitoring: {
    usageAlerts: boolean;
    threshold: number;
  };
}

const configs: Record<string, ArgoEnvironmentConfig> = {
  production: {
    enabled: true,
    tieredCache: true,
    monitoring: {
      usageAlerts: true,
      threshold: 1000, // GB
    },
  },
  staging: {
    enabled: true,
    tieredCache: false,
    monitoring: {
      usageAlerts: false,
      threshold: 100, // GB
    },
  },
  development: {
    enabled: false,
    tieredCache: false,
    monitoring: {
      usageAlerts: false,
      threshold: 0,
    },
  },
};

export function getArgoConfig(env: string): ArgoEnvironmentConfig {
  return configs[env] || configs.development;
}
```

### Pulumi Configuration

```typescript
// pulumi/argo.ts
import * as cloudflare from '@pulumi/cloudflare';

const zone = new cloudflare.Zone('example-zone', {
  zone: 'example.com',
  plan: 'enterprise',
});

const argoSettings = new cloudflare.Argo('argo-config', {
  zoneId: zone.id,
  smartRouting: 'on',
  tieredCaching: 'on',
});

export const argoEnabled = argoSettings.smartRouting;
export const zoneId = zone.id;
```

## Billing Configuration

Before enabling Argo Smart Routing, ensure billing is configured for the account:

**Prerequisites:**
1. Valid payment method on file
2. Enterprise or higher plan
3. Zone must have billing enabled

**Check Billing Status via Dashboard:**
1. Navigate to Account → Billing
2. Verify payment method configured
3. Check zone subscription status

**Note:** Attempting to enable Argo without billing configured will result in `editable: false` in API responses.

## Environment Variable Setup

**Required Environment Variables:**
```bash
# .env
CLOUDFLARE_API_TOKEN=your_api_token_here
CLOUDFLARE_ZONE_ID=your_zone_id_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here

# Optional
ARGO_ENABLED=true
ARGO_TIERED_CACHE=true
```

**TypeScript Configuration Loader:**
```typescript
// config/env.ts
import { z } from 'zod';

const envSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  CLOUDFLARE_ZONE_ID: z.string().min(1),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  ARGO_ENABLED: z.string().optional().default('false'),
  ARGO_TIERED_CACHE: z.string().optional().default('false'),
});

export const env = envSchema.parse(process.env);

export const argoConfig = {
  enabled: env.ARGO_ENABLED === 'true',
  tieredCache: env.ARGO_TIERED_CACHE === 'true',
};
```

## CI/CD Integration

**GitHub Actions Example:**
```yaml
# .github/workflows/deploy-argo.yml
name: Deploy Argo Configuration

on:
  push:
    branches: [main]
    paths:
      - 'terraform/argo.tf'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v2
        
      - name: Terraform Init
        run: terraform init
        working-directory: ./terraform
        
      - name: Terraform Apply
        run: terraform apply -auto-approve
        working-directory: ./terraform
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          TF_VAR_zone_id: ${{ secrets.CLOUDFLARE_ZONE_ID }}
```

## Enterprise Preview Program

For early access to Argo Smart Routing features and Smart Shield integration:

**Eligibility:**
- Enterprise plan customers
- Active Cloudflare support contract
- Production traffic >100GB/month

**How to Join:**
1. Contact Cloudflare account team or support
2. Request Argo/Smart Shield preview access
3. Receive preview zone configuration

**Preview Features:**
- Enhanced analytics and reporting
- Smart Shield DDoS integration
- Advanced routing policies
- Priority support for routing issues