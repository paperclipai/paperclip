---
title: Companies
summary: Company CRUD endpoints
---

Manage companies within your Paperclip instance.

## List Companies

```
GET /api/companies
```

Returns all companies the current user/agent has access to.

## Get Company

```
GET /api/companies/{companyId}
```

Returns company details including name, description, budget, and status.

## Create Company

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency"
}
```

## Update Company

With an explicit technical reviewer override:

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6",
  "technicalReviewerReference": "revisor-pr"
}
```

Same request with the field omitted (or `null`) is valid — the dispatcher then uses the fallback chain below:

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

`technicalReviewerReference` is optional. When present, it is an agent **name** reference (same resolution rules as `@AgentName` in comments — see [Issues API — Add Comment](./issues.md#add-comment) for mention matching). It is used when dispatching technical review children from `handoff_ready` issues.

For production/operator reliability, prefer setting this field explicitly per company via the Update Company endpoint (API) or in UI board settings. Leaving it `null` through either mechanism shifts dispatch to fallback resolution (env/default), which can cause no-op dispatches when references are missing or ambiguous.

On **PATCH**, a non-null value must resolve to exactly one **non-terminated** agent in the **same company** (same resolution as dispatch). The API returns **422** when no agent matches or when the reference is ambiguous. There is **no database foreign key** on this column; enforcement is application-level.

**Fallback precedence** when `technicalReviewerReference` is **omitted** or **`null`:**

1. If the **`PAPERCLIP_TECHNICAL_REVIEWER_REFERENCE`** environment variable is set (non-empty after trim), use that string.
2. Otherwise use the literal default **`revisor-pr`**.

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

Company logo uploads use the normal Paperclip attachment size limit.

Then set the company logo by PATCHing the returned `assetId` into `logoAssetId`.

## Archive Company

```
POST /api/companies/{companyId}/archive
```

Archives a company. Archived companies are hidden from default listings.

## Company Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Company name |
| `description` | string | Company description |
| `status` | string | `active`, `paused`, `archived` |
| `logoAssetId` | string | Optional asset id for the stored logo image |
| `logoUrl` | string | Optional Paperclip asset content path for the stored logo image |
| `budgetMonthlyCents` | number | Monthly budget limit |
| `technicalReviewerReference` | string \| null | Optional agent reference for automatic technical review dispatch |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
