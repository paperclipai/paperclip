---
title: Support Case Assessment — Knowledge Starter Packs (v0.5.0)
summary: Pre-curated knowledge document bundles for common industries — installed via API or company templates
version: v0.5.2
commit: 2e90d0d5ae
last_updated: 2026-08-19
---

# Support Case Assessment: Knowledge Starter Packs (v0.5.0)

## Feature Overview

Knowledge Starter Packs are curated bundles of pre-written knowledge documents for common industries. They provide a company's agents with an instant knowledge base covering the key topics relevant to their domain — without requiring manual document creation.

### What it does

- **Standalone API** — Starter packs now have their own REST API endpoints: list all packs, get pack detail with full documents, and install a pack into a company's knowledge base. See the [Knowledge Starter Packs API Reference](/api/knowledge-starter-packs).
- **Automatic installation via templates** — Starter packs are also installed automatically as part of company template deployment (when the template specifies a `starterPackKey`). No separate API call is needed when using templates.
- **Pre-reviewed content** — Starter pack documents skip the draft → review → publish workflow. Since the content is pre-curated, each document is created directly as **published** and immediately searchable.
- **Title-based deduplication** — If a document with the same title already exists in the company's knowledge base, it is skipped. This prevents duplicate content when a starter pack is re-applied.
- **Graceful degradation** — Individual document failures (e.g., a document with the same title already existing) do not block the rest of the pack installation. Warnings are logged and the install continues.

### What it does NOT do

- **No pack management** — Packs are loaded from JSON files on the server (`server/src/knowledge-starter-packs-data/`). There is no UI or API for creating, editing, deleting, or publishing starter packs. Only the server operator can add or modify packs.
- **No industry-packs relationship enforcement** — The server does not validate that a starter pack's industry matches the template's industry. A Travel Concierge template could technically reference an `engineering` starter pack.
- **Not used in self-service onboarding** — The `POST /api/start` onboarding endpoint does not install knowledge starter packs. See the [Onboarding Support Case Assessment](support-case-v0.5.0-onboarding.md) for details.

## How It Works

### Pack Structure

Each starter pack is a JSON file in `server/src/knowledge-starter-packs-data/` with the following structure:

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
      "body": "# Destination Research\n\n## Key Factors\n... (full markdown body)"
    }
  ]
}
```

### API Endpoints

The Knowledge Starter Packs API provides three endpoints:

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/knowledge-starter-packs` | List all available packs (metadata only) | None |
| `GET` | `/api/knowledge-starter-packs/:packKey` | Get a single pack with full documents | None |
| `POST` | `/api/companies/:companyId/knowledge/starter-packs/:packKey/install` | Install a pack into a company's knowledge base | Board or Agent (same company) |

See the [Knowledge Starter Packs API Reference](/api/knowledge-starter-packs) for full endpoint details, request schemas, and response examples.

### Installation Flow (via API or Template)

Whether installed via the API or as part of company template deployment:

1. The server loads the pack JSON file from disk
2. For each document in the pack:
   a. Checks if a document with the same title already exists in the company
   b. If not, creates the document as **published** (no draft stage)
3. If any document fails, a warning is logged and the installation continues
4. The API returns a `documentsCreated` count; template deployment includes a `warnings` array

## Known Limitations

| Limitation | Description | Workaround |
|---|---|---|
| Data directory may be empty | If `knowledge-starter-packs-data/` does not exist or is empty, the pack list is empty. The server boots fine — this is handled gracefully with a startup warning. | Create the data directory and add pack JSON files. The service logs a warning: "Knowledge starter packs data directory unavailable; serving empty pack list" |
| Title-based dedup only (100-doc limit) | Deduplication is by exact title match (case-insensitive), and the dedup check only examines the first 100 knowledge documents in the company (due to `list(limit: 100)`). Two documents with different titles but identical content will both be created. Companies with >100 knowledge documents may see duplicates beyond the first 100. | Manually review and remove duplicate documents from the knowledge base after deployment. For large KBs, delete unwanted documents directly. |
| No rollback | Starter pack installation is not wrapped in a single transaction. If the process fails mid-way, some documents may have been created and others not. | Check the `documentsCreated` count in the API response. Manually create any missing documents. |
| Published status | All starter pack documents are created as **published**. There is no draft stage for review. | If the content needs modification, edit the published document via the Knowledge API or UI. |
| No per-document error detail in API response | The API returns a `documentsCreated` count but not per-document error details. | Check the server logs for detailed error messages when a document creation fails. |

## Troubleshooting

### Problem: Pack list is empty

1. Check if the `knowledge-starter-packs-data/` directory exists on the server
2. Verify the directory contains valid JSON pack files (one file per pack)
3. Check server startup logs for warnings about the data directory

### Problem: "Starter pack not found" error

1. The pack key does not match any file in `knowledge-starter-packs-data/`
2. Verify available pack keys by calling `GET /api/knowledge-starter-packs` or checking files in the data directory
3. Pack keys are case-sensitive — ensure the requested key matches exactly

### Problem: Pack installation reports fewer documents created than expected

1. Some documents may have been skipped due to title-based deduplication (same title already exists in the company's knowledge base)
2. Check the server logs for "Skipping existing knowledge document (title already exists)" messages
3. If you need to re-install with all documents, delete the existing documents first, then re-install

### Problem: Knowledge base shows documents but content looks wrong

1. Starter pack documents are created from the JSON content on disk at install time
2. Check the pack JSON file for content accuracy
3. If the pack content is incorrect, the server operator must update the JSON file
4. Already-created documents are not updated when the pack JSON changes — delete and re-create

### Problem: POST /install returns 404

1. Verify the `packKey` in the URL path matches an available pack
2. Verify the `companyId` in the URL path is a valid company UUID
3. If the route itself is missing, check that knowledge starter pack routes are registered in `app.ts`

### Problem: POST /install returns 403

1. Agent actors must be authenticated via agent API key or run JWT
2. Board users must have a valid session with access to the target company
3. Agent actors must belong to the same company as the `companyId` in the URL
4. Verify the actor has the correct authentication token/headers

## Available Starter Packs

| Pack Key | Industry | Used By Template |
|---|---|---|
| `travel-industry` | Travel & Hospitality | Travel Concierge |
| `saas-support` | SaaS & Customer Support | Support Ops |
| `engineering` | Software Engineering | Engineering Team |
| `finance-accounting` | Accounting & Tax | CPA Firm |

Note: The actual availability of these packs depends on the JSON files present in `knowledge-starter-packs-data/` on the server. The server operator controls which packs are available. Use `GET /api/knowledge-starter-packs` to see what's actually available.

## Support Escalation Path

| Issue | Severity | Action |
|---|---|---|
| Starter pack data directory missing | Low | Check server startup logs; verify `knowledge-starter-packs-data/` exists. Server operator creates the directory and adds pack JSON files. |
| Pack installation failure (via API) | Medium | Check server logs. Individual document failures are non-fatal — verify `documentsCreated` count. |
| Pack installation failure (via template) | Medium | Check the warnings array and server logs. Individual document failures are non-fatal. |
| Documents created with incorrect content | Medium | Content is read from the pack JSON file at install time. Server operator must fix the JSON source. |
| Title-based dedup not catching near-duplicates beyond 100 docs | Low | Dedup is exact title match, limited to first 100 docs. Manually clean up duplicate documents in the knowledge base. |
| Pack key not found | Low | Verify the pack key via `GET /api/knowledge-starter-packs` or check files in the data directory. |
| Authorization failure on install | Low | Verify actor authentication and company membership. See troubleshooting above. |

## Related Documentation

- [Knowledge Starter Packs API Reference](/api/knowledge-starter-packs) — full API endpoint documentation
- [Company Templates Support Case Assessment](support-case-company-templates.md) — templates use starter packs during deployment
- [Self-Service Onboarding Support Case Assessment](support-case-v0.5.0-onboarding.md) — onboarding does not install starter packs
- [Knowledge Documents API Reference](/api/knowledge) — managing individual knowledge documents post-install
- [Company Templates API Reference](/api/company-templates) — template deployment with starter pack support

## Version History

| Version | Date | Changes |
|---|---|---|
| v0.5.2 | 2026-08-19 | Added 100-doc dedup limit to known limitations (P5 from Staff Engineer audit) |
| v0.5.1 | 2026-08-19 | Updated for standalone API — 3 endpoints added (list, get, install). Removed "no standalone API" limitation. Added API reference link. |
| v0.5.0 | 2026-08-19 | Initial assessment — service exists as internal dependency of company templates; no standalone API |
