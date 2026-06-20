---
title: Environments
summary: Manage execution environments and leases
---

Configure and inspect the execution runtimes (E2B, Daytona, Local process sandbox) available for agent heartbeats.

## List Environments

```
GET /api/companies/{companyId}/environments
```

Returns the list of configured runtime environments available to the company.

## Create Environment

```
POST /api/companies/{companyId}/environments
{
  "name": "E2B Sandbox",
  "description": "Standard isolated node environment",
  "driver": "e2b",
  "config": {},
  "envVars": []
}
```

Creates a new environment available to run agent heartbeats.

## Get Environment Capabilities

```
GET /api/companies/{companyId}/environments/capabilities
```

Returns driver capabilities and supported settings.

## Get Environment

```
GET /api/environments/{id}
```

Returns a single environment configuration by ID.

## Update Environment

```
PATCH /api/environments/{id}
{
  "name": "Updated Sandbox Name",
  "config": {}
}
```

Updates an existing environment runtime configuration.

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

## Probe Environment

```
POST /api/environments/{id}/probe
```

Triggers a heartbeat check to verify the host connection and credentials of the sandbox driver.
