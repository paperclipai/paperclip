# Cloudflare Pulumi Provider

Expert guidance for Cloudflare Pulumi Provider (@pulumi/cloudflare).

## Overview

Programmatic management of Cloudflare resources: Workers, Pages, D1, KV, R2, DNS, Queues, etc.

**Packages:**
- TypeScript/JS: `@pulumi/cloudflare`
- Python: `pulumi-cloudflare`
- Go: `github.com/pulumi/pulumi-cloudflare/sdk/v6/go/cloudflare`
- .NET: `Pulumi.Cloudflare`

**Version:** v6.x

## Core Principles

1. Use API tokens (not legacy API keys)
2. Store accountId in stack config
3. Match binding names across code/config
4. Use `module: true` for ES modules
5. Set `compatibilityDate` to lock behavior

## Authentication

```typescript
import * as cloudflare from "@pulumi/cloudflare";

// API Token (recommended): CLOUDFLARE_API_TOKEN env
const provider = new cloudflare.Provider("cf", { apiToken: process.env.CLOUDFLARE_API_TOKEN });

// API Key (legacy): CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL env
const provider = new cloudflare.Provider("cf", { apiKey: process.env.CLOUDFLARE_API_KEY, email: process.env.CLOUDFLARE_EMAIL });

// API User Service Key: CLOUDFLARE_API_USER_SERVICE_KEY env
const provider = new cloudflare.Provider("cf", { apiUserServiceKey: process.env.CLOUDFLARE_API_USER_SERVICE_KEY });
```

## Setup

**Pulumi.yaml:**
```yaml
name: my-cloudflare-app
runtime: nodejs
config:
  cloudflare:apiToken:
    value: ${CLOUDFLARE_API_TOKEN}
```

**Pulumi.<stack>.yaml:**
```yaml
config:
  cloudflare:accountId: "abc123..."
```

**index.ts:**
```typescript
import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
const accountId = new pulumi.Config("cloudflare").require("accountId");
```

## Common Resource Types
- `Provider` - Provider config
- `WorkerScript` - Worker
- `WorkersKvNamespace` - KV
- `R2Bucket` - R2
- `D1Database` - D1
- `Queue` - Queue
- `PagesProject` - Pages
- `DnsRecord` - DNS
- `WorkerRoute` - Worker route
- `WorkersDomain` - Custom domain

## Key Properties
- `accountId` - Required for most resources
- `zoneId` - Required for DNS/domain
- `name`/`title` - Resource identifier
- `*Bindings` - Connect resources to Workers

## Reading Order

| Order | File | What | When to Read |
|-------|------|------|--------------|
| 1 | [configuration.md](./configuration.md) | Resource config for Workers/KV/D1/R2/Queues/Pages | First time setup, resource reference |
| 2 | [patterns.md](./patterns.md) | Architecture patterns, multi-env, component resources | Building complex apps, best practices |
| 3 | [api.md](./api.md) | Outputs, dependencies, imports, dynamic providers | Advanced features, integrations |
| 4 | [gotchas.md](./gotchas.md) | Common errors, troubleshooting, limits | Debugging, deployment issues |

## In This Reference
- [configuration.md](./configuration.md) - Provider config, stack setup, Workers/bindings
- [api.md](./api.md) - Resource types, Workers script, KV/D1/R2/queues/Pages
- [patterns.md](./patterns.md) - Multi-env, secrets, CI/CD, stack management
- [gotchas.md](./gotchas.md) - State issues, deployment failures, limits

## See Also
- [terraform](../terraform/) - Alternative IaC for Cloudflare
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) - CLI deployment alternative
- [workers](https://developers.cloudflare.com/workers/) - Worker runtime documentation
