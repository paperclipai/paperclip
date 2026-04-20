---
title: Companies
summary: Company CRUD endpoints
---

Manage companies within your Orchestrero instance.

## List Companies

```
GET /api/companies
```

Returns all companies the current user/agent has access to.

## Rail State

```
GET /api/companies/rail-state
```

Board-only summary endpoint for shell navigation. Returns one row per visible non-archived company:

- `companyId`
- `inboxCount`
- `hasLiveRuns`

## Get Company

```
GET /api/companies/{companyId}
```

Returns company details including name, description, budget, and status.

## Inbox Summary

```
GET /api/companies/{companyId}/inbox-summary
```

Returns lightweight inbox counters for a single company:

- `inbox`
- `approvals`
- `failedRuns`
- `joinRequests`
- `mineIssues`
- `alerts`
- `failedRunSummaries`

`failedRunSummaries` is intentionally bounded. It contains the latest actionable failed or timed-out run per agent with the minimal fields the Inbox needs before detail hydration:

- `id`
- `agentId`
- `status`
- `createdAt`
- `retryState`
- `error`
- `issueId`

## Run Activity

```
GET /api/companies/{companyId}/run-activity?days=14
```

Returns per-day run buckets for recent dashboard charts:

- `date`
- `succeeded`
- `failed`
- `other`
- `total`

`days` defaults to `14` and is capped server-side.

## Create Company

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency"
}
```

## Update Company

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "releaseGateQaAgentId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6",
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

`releaseGateQaAgentId` is optional. When set, it records the board’s preferred release-gate QA owner for standalone delivery and workflow QA. The server still resolves the effective owner dynamically: configured owner first if eligible, then a single canonical `QA and Release Engineer`, then a single other eligible QA agent, otherwise explicit blocked state. Configured owners must belong to the same company, have role `qa`, and cannot be `terminated`, `pending_approval`, or `error`.

## Upload Company Logo

Upload an image for a company icon and store it as that company’s logo.

```
POST /api/companies/{companyId}/logo
Content-Type: multipart/form-data
```

Valid image content types:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/webp`
- `image/gif`
- `image/svg+xml`

Company logo uploads use the normal Orchestrero attachment size limit.

Then set the company logo by PATCHing the returned `assetId` into `logoAssetId`.

## Archive Company

```
POST /api/companies/{companyId}/archive
```

Archives a company. Archived companies are hidden from default listings.

## Pause Company

```
POST /api/companies/{companyId}/pause
```

Pauses the company at the company scope. Agent-level pause states are unchanged. Queued work is held and does not start while paused.

## Resume Company

```
POST /api/companies/{companyId}/resume
```

Resumes the company at the company scope. Agent-level pause states are unchanged and queued work can start again.
On resume, Orchestrero also ensures a COO coordinator exists and triggers a COO heartbeat kickoff (best-effort).

## Heartbeat Run History

```
GET /api/companies/{companyId}/heartbeat-runs
```

Optional query parameters:

- `agentId`
- `limit`

This route remains available for history/detail views. Shell pages should prefer `rail-state`, `inbox-summary`, `run-activity`, and `live-runs` instead of fetching unbounded company-wide run history.

## Roadmap Epic Pause State

List paused roadmap epics for a company:

```
GET /api/companies/{companyId}/roadmap-epics
```

Pause an epic:

```
POST /api/companies/{companyId}/roadmap-epics/{roadmapId}/pause
```

Resume an epic:

```
POST /api/companies/{companyId}/roadmap-epics/{roadmapId}/resume
```

Paused roadmap epics hold issue-linked execution wakeups and queued runs for those epics until resumed.

## Company Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Company name |
| `description` | string | Company description |
| `status` | string | `active`, `paused`, `archived` |
| `releaseGateQaAgentId` | string | Optional board-configured release-gate QA owner |
| `resolvedReleaseGateQaAgentId` | string | Effective release-gate QA owner after applying the shared resolver |
| `releaseGateQaResolutionSource` | string | Why the current release-gate QA owner was chosen: `configured`, `canonical`, `single_fallback`, `configured_unavailable`, `none`, or `ambiguous` |
| `releaseGateQaBlockingReason` | string | Human-readable reason when no release-gate QA owner currently resolves |
| `logoAssetId` | string | Optional asset id for the stored logo image |
| `logoUrl` | string | Optional Orchestrero asset content path for the stored logo image |
| `budgetMonthlyCents` | number | Monthly budget limit |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
