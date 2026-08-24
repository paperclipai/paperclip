---
title: Knowledge Starter Packs
summary: Browse and install pre-curated knowledge document bundles
version: v0.5.0
last_updated: 2026-08-19
---

# Knowledge Starter Packs API

Knowledge Starter Packs are pre-curated bundles of knowledge documents for common industries. They provide a quick-start knowledge base for new companies — without manual document creation.

Packs are loaded from JSON files on the server (`server/src/knowledge-starter-packs-data/`). The server operator controls which packs are available by adding or removing files in that directory.

## List All Packs

```http
GET /api/knowledge-starter-packs
```

Returns metadata for all available starter packs. Documents are excluded from the list response — use the detail endpoint to retrieve full documents.

### Response

```json
[
  {
    "key": "engineering",
    "name": "Engineering",
    "description": "Curated knowledge for engineering teams",
    "industry": "Software Engineering",
    "icon": "tools",
    "documentCount": 7
  },
  {
    "key": "travel-industry",
    "name": "Travel Industry Knowledge Pack",
    "description": "Essential knowledge for a travel concierge company",
    "industry": "Travel & Hospitality",
    "icon": "globe",
    "documentCount": 5
  }
]
```

### Authorization

This endpoint is accessible without authentication. No board session or API key is required.

### Error Codes

| Status | Meaning |
|--------|---------|
| 200    | Returns pack list (empty array if no packs exist or data directory unavailable) |

## Get Pack Detail

```http
GET /api/knowledge-starter-packs/{packKey}
```

Returns a single starter pack by key, including its full documents array.

### Response

```json
{
  "key": "travel-industry",
  "name": "Travel Industry Knowledge Pack",
  "description": "Essential knowledge for a travel concierge company",
  "industry": "Travel & Hospitality",
  "icon": "globe",
  "documentCount": 5,
  "documents": [
    {
      "title": "Destination Research Guide",
      "summary": "How to research and recommend travel destinations",
      "body": "# Destination Research\n\n## Key Factors\n..."
    }
  ]
}
```

### Error Codes

| Status | Meaning |
|--------|---------|
| 200    | Pack found and returned |
| 404    | Pack key does not match any available pack |

## Install Pack into a Company

```http
POST /api/companies/{companyId}/knowledge/starter-packs/{packKey}/install
```

Installs all documents from a knowledge starter pack into a company's knowledge base. Each document is created directly as **published** (pre-curated content skips the draft → review → publish workflow). Documents whose title already exists in the company's knowledge base are skipped (title-based deduplication).

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `actorAgentId` | string | No | Override the document creator agent ID. Defaults to the authenticated agent's ID, or omitted if the actor is a board user |

### Response (201 Created)

```json
{
  "packKey": "engineering",
  "documentsCreated": 7,
  "documentIds": [
    "doc-uuid-1",
    "doc-uuid-2",
    "doc-uuid-3"
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `packKey` | string | The installed pack key |
| `documentsCreated` | number | Number of documents successfully created (skipped duplicates not counted) |
| `documentIds` | array | IDs of the created documents |

### Authorization

Requires board-level or agent-level authentication. Agents must belong to the target company (matching `companyId`). Board users must have access to the company.

### Error Codes

| Status | Meaning |
|--------|---------|
| 201    | Pack installed successfully (some documents may have been skipped due to title duplicates) |
| 403    | Not authenticated, or actor does not have access to the company |
| 404    | Pack key not found |

## Details

### Title-Based Deduplication

When installing a pack, each document's title is compared against existing knowledge document titles in the company (case-insensitive). If a match is found, the document is skipped and a warning is logged. The response still returns HTTP 201 — skipped documents are not counted in `documentsCreated`.

### Graceful Degradation

Individual document creation failures do not block the rest of the pack installation. The documents that succeeded are still created, and those that failed are logged server-side. The response only reports the count of successfully created documents.

### No Rollback

Pack installation is not wrapped in a single transaction. If the process fails mid-way, some documents may have been created and others not. Verify the `documentsCreated` count and check server logs for details.

## Related

- [Company Templates API](/api/company-templates) — templates can include a `starterPackKey` for automatic pack installation during deployment
- [Knowledge API](/api/knowledge) — managing individual knowledge documents post-install
- [Support Case Assessment: Knowledge Starter Packs](/support/assessments/support-case-knowledge-starter-packs)
