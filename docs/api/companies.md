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

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000
}
```

## Upload Company Logo

Upload an image for a company icon and store it as that company’s logo.

```
POST /api/companies/{companyId}/assets/images
Content-Type: multipart/form-data
```

Valid image content types:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/webp`
- `image/gif`
- `image/svg+xml`

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
| `logoUrl` | string | Optional path or URL for the logo image |
| `budgetMonthlyCents` | number | Monthly budget limit |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
