---
title: Cloud Starter Inference
summary: Inspect Cloud starter-inference status, migrate trial agents to a connected provider, and record onboarding funnel telemetry
---

These company-scoped endpoints support Paperclip Cloud starter inference when the
`enableCloudTrialInference` instance experimental setting is enabled. Every
endpoint requires a board session with active membership in `{companyId}`. Agent
API keys cannot call them. Responses use `Cache-Control: no-store`.

## Get Cloud Inference Status

```
GET /api/companies/{companyId}/cloud-inference/status?refresh=true
```

Returns the company's starter-inference state, trial-bound agents, and whether
the caller can migrate them.

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `refresh` | `"1"` \| `"true"` | — | When set, refreshes key usage from Paperclip Cloud and OpenRouter before responding |

### Permissions

- Authenticated board user with access to `{companyId}` (viewers may read status; `canMigrate` is `false` for viewers or users without agent configuration authority).

### Response (`200 OK`)

```json
{
  "enabled": true,
  "provider": "openrouter",
  "status": "active",
  "limitUsdCents": 100,
  "spentUsdCents": 12,
  "remainingUsdCents": 88,
  "defaultModel": "openrouter/openai/gpt-6-luna",
  "canMigrate": true,
  "trialAgentIds": ["11111111-1111-4111-8111-111111111111"],
  "trialAgents": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Nova",
      "role": "ceo",
      "title": "Chief of Staff"
    }
  ],
  "blockedRun": null
}
```

`status` is one of `unavailable`, `not_issued`, `active`, `exhausted`,
`disabled`, `ineligible`, or `migrated`. `blockedRun` is either `null` or
`{ runId, agentId, issueId, failedAt }` when a trial agent's latest run failed
due to starter-inference exhaustion.

## Migrate Trial Agents

```
POST /api/companies/{companyId}/cloud-inference/migrate
```

Moves non-terminated, non-pending trial agents in `{companyId}` off Cloud
starter inference onto a connected user or shared AI connection, clears
incompatible task sessions, ensures connection install access, and optionally
resumes the latest blocked run.

### Permissions

- Authenticated board user with company access (non-viewer, unless instance admin).
- Must hold `agent_config:update` (or setup-draft creator authority) for every target trial agent.
- Personal grants may only be used by their owner; adding missing agent installs requires `connections:configure` (or self-service ownership of a personal grant).

### Request Body

```json
{
  "connectionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "grantId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "provider": "anthropic",
  "method": "subscription",
  "ownership": "personal",
  "model": "claude-sonnet-4-6",
  "agentIds": ["11111111-1111-4111-8111-111111111111"],
  "resumeBlockedWork": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connectionId` | UUID | Yes | Active company AI `tool_connections` ID |
| `grantId` | UUID | Yes | Active `connection_grants` ID belonging to `connectionId` |
| `provider` | `"openai"` \| `"anthropic"` \| `"google"` \| `"xai"` \| `"openrouter"` \| `"github"` | Yes | Connected AI provider |
| `method` | `"subscription"` \| `"api_key"` | Yes | Authentication method |
| `ownership` | `"personal"` \| `"shared"` | No (default `"personal"`) | Personal delegated vs. shared org binding |
| `model` | string (1–200 chars) | No | Optional model override (defaults come from deployment config or provider defaults) |
| `agentIds` | UUID[] (max 200) | No | Optional subset of trial agent IDs to migrate; omits to migrate all eligible trial agents |
| `resumeBlockedWork` | boolean | No (default `true`) | Whether to wake the latest exhaustion-blocked run after migration |

### Response (`200 OK`)

```json
{
  "migratedCount": 1,
  "agents": [
    {
      "agentId": "11111111-1111-4111-8111-111111111111",
      "name": "Nova",
      "adapterType": "paperclip_runner",
      "runnerProvider": "claude",
      "model": "claude-sonnet-4-6"
    }
  ],
  "resumedRunIds": ["99999999-9999-4999-8999-999999999999"],
  "resumedIssueId": "33333333-3333-4333-8333-333333333333"
}
```

### Errors

| Status | Meaning |
|--------|---------|
| `400` | Validation error or selected AI connection is not active |
| `403` | Viewer role, missing `agent_config:update`, another user's personal grant, or unauthorized connection install |
| `404` | Selected AI connection grant was not found for `{companyId}` |

## Record Starter Inference Telemetry

```
POST /api/companies/{companyId}/cloud-inference/telemetry
```

Records Cloud-only PostHog funnel events (no-op on self-hosted instances).

### Request Body

Either an onboarding exposure event:

```json
{
  "event": "onboarding_exposure",
  "surface": "onboarding_wizard"
}
```

or a connect-provider modal impression event:

```json
{
  "event": "modal_shown",
  "trialAgentCount": 1
}
```

### Response

`204 No Content`.
