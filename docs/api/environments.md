---
title: Environments
summary: Manage execution environments and leases
---

Configure and inspect the execution runtimes (such as Local, SSH, Sandbox, or Plugin-based runners) available for agent heartbeats. 

Note: Environments are **instance-scoped** rather than company-scoped. However, company-prefixed routes (e.g. `/api/companies/{companyId}/environments`) are used to supply the necessary company context for verifying permissions and resolving company secret bindings.

### Permissions & Redaction
List and get environment endpoints are readable by company board members, but non-instance-admin readers will receive redacted values for `config`, `envVars`, and `metadata`. Creating, updating, deleting, or probing environments requires local implicit board or instance admin access.

## List Environments

```
GET /api/companies/{companyId}/environments
```

Returns the list of configured runtime environments. Note that environments are instance-wide, so this list returns all environments configured on the instance and does not filter by `{companyId}`.

## Create Environment

```
POST /api/companies/{companyId}/environments
{
  "name": "Local Sandbox",
  "description": "Standard isolated local process environment",
  "driver": "local",
  "config": {},
  "envVars": {
    "NODE_ENV": { "value": "production" },
    "GH_TOKEN": { "secretId": "secret-uuid-here" }
  }
}
```

Creates a new environment. Valid drivers are `local`, `ssh`, `sandbox`, and `plugin`.

## Get Environment Capabilities

```
GET /api/companies/{companyId}/environments/capabilities
```

Returns driver capabilities and supported settings.

## Probe Draft Environment Configuration

```
POST /api/companies/{companyId}/environments/probe-config
{
  "driver": "ssh",
  "config": {
    "host": "localhost",
    "port": 22
  },
  "envVars": {}
}
```

Validates an unsaved/draft environment configuration prior to creation or update, verifying connections and credentials in the specified company/secrets context.

## Get Environment

```
GET /api/environments/{id}
```

Returns a single environment configuration by ID.

## Update Environment

```
PATCH /api/environments/{id}?companyId={companyId}
{
  "name": "Updated Sandbox Name",
  "config": {},
  "envVars": {
    "NODE_ENV": { "value": "development" }
  }
}
```

Updates an existing environment runtime configuration. Probing/updating requires the optional `companyId` query parameter if you need to resolve secret-backed environment configurations.

## Delete Environment

```
DELETE /api/environments/{id}
```

Deletes an environment.

## List Environment Leases

```
GET /api/environments/{id}/leases
```

Returns active leases (which agents are currently using the environment).

## Probe Saved Environment

```
POST /api/environments/{id}/probe?companyId={companyId}
```

Triggers a heartbeat check to verify the host connection and credentials of the saved environment driver. The `companyId` query parameter is required to provide the company/secret context to resolve credentials.
