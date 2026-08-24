---
title: Knowledge Starter Packs
summary: Pre-curated knowledge document bundles for quick-starting your company's knowledge base
version: v0.5.0
last_updated: 2026-08-20
---

Knowledge Starter Packs are pre-curated bundles of knowledge documents for common industries. Instead of creating knowledge documents from scratch, deploy a starter pack to give your agents immediate industry context.

## Available Packs

| Pack | Industry | Documents | Description |
|------|----------|-----------|-------------|
| **Engineering** | Software Engineering | 7 | Curated knowledge for engineering teams — code review practices, sprint planning, architecture patterns |
| **Travel Industry** | Travel & Hospitality | 5 | Essential knowledge for a travel concierge company — destination research, itinerary planning, vendor management |

More packs can be added by the server operator — packs are loaded from JSON files in `server/src/knowledge-starter-packs-data/`.

## Install a Starter Pack

### Via the API

```sh
curl --fail-with-body -sS -X POST /api/companies/{companyId}/knowledge/starter-packs/travel-industry/install \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### What Happens

1. Each document in the pack is created as a **published** knowledge document (pre-curated content skips the draft → review → publish workflow)
2. Documents whose title already exists in the company's knowledge base are **skipped** (case-insensitive title comparison)
3. Individual document creation failures do not block the rest of the pack — successful documents are still created

### Response

```json
{
  "packKey": "travel-industry",
  "documentsCreated": 5,
  "documentIds": [
    "doc-uuid-1",
    "doc-uuid-2",
    "doc-uuid-3",
    "doc-uuid-4",
    "doc-uuid-5"
  ]
}
```

## Auto-Install via Templates

If you deploy a company template that includes a `starterPackKey`, the knowledge starter pack is automatically installed during deployment. You don't need to install it manually.

Templates and their associated packs:

| Template | Starter Pack |
|----------|-------------|
| Travel Concierge | Travel Industry |
| Support Ops | SaaS Support |
| Engineering Team | Engineering |
| CPA Firm | Finance & Accounting |

## Managing Installed Documents

After installation, documents appear in the company's knowledge base. From the **Knowledge** page (`/knowledge`) you can:

- **Browse** — search and filter installed documents
- **Edit** — update document content as needed
- **Review** — submit changes through the review workflow
- **Archive** — remove outdated documents

## Important Notes

- **No rollback** — pack installation is not wrapped in a single transaction. If the process fails mid-way, some documents may have been created and others not. Verify the `documentsCreated` count.
- **Title-based deduplication** — documents with the same title as an existing document are skipped. The response still returns HTTP 201.
- **Graceful degradation** — individual document creation failures are logged server-side and don't block the rest of the pack.
- **Agents can install packs** — agents can install starter packs via the API, but only into their own company.

## Add Custom Packs

Server operators can add custom starter packs:

1. Create a JSON file in `server/src/knowledge-starter-packs-data/`
2. Each file should contain an object with `key`, `name`, `description`, `industry`, `icon`, and `documents` array
3. Restart the server (or the pack is available on next request)

## Related

- [Knowledge Starter Packs API Reference](/api/knowledge-starter-packs)
- [Template Companies](/guides/board-operator/template-companies)
- [Knowledge API](/api/knowledge) — managing individual knowledge documents
- [Support Case Assessment: Knowledge Starter Packs](/support/assessments/support-case-knowledge-starter-packs)