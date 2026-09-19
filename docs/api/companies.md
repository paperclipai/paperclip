---
title: Companies
summary: Company CRUD endpoints
---

Manage companies within your Paperclip instance.

## List Companies

```
GET /api/companies
```

Requires a board user. Returns companies where the user has active membership.
Instance administrators and the local trusted board can list all companies.

For navigation and company selectors, use `GET /api/companies?scope=accessible`.
This returns only companies the caller can enter through company-scoped routes,
including for instance administrators. Instance administrator status alone does
not grant access to a company's contents. The local trusted board can still
enter all companies. The board UI uses this scope for its company list, so it
does not select companies the user cannot open.
The Instance Access screen uses the unscoped directory so administrators can
manage membership for all companies. A supplied `scope` must be a single
`accessible` value; empty, unknown, or repeated values return `400`.

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

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

### Company-wide run capacity

The create and update endpoints accept `maxConcurrentRuns`, a positive integer
or `null`. It defaults to `null`, preserving per-agent admission without an
additional company-wide cap. Set it to `1` for sequential execution across
agents in the same company. Per-agent limits and existing budget, dependency,
checkout, pause, and review guards continue to apply.

Eligible runs remain queued while company capacity is occupied. Completing or
failing an occupying run promotes queued company peers through the existing
admission path; no extra timer or caller-issued wake is required. Capacity is
claimed transactionally in the database, not held by an agent waiting for work.
Other companies have independent capacity.

Configure the limit before dispatching work. Changing the limit does not cancel
existing runs or create a new wake for an idle queue. A run capacity setting
does not prove that a remote adapter acknowledged cancellation.

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
| `maxConcurrentRuns` | number or null | Optional company-wide concurrent run limit; null preserves per-agent-only admission |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
