---
title: Deliverables
summary: Cross-issue list of file artifacts produced by agents
---

A **deliverable** is a downloadable file artifact produced by an agent while
working on an issue. It is a presentation view of `issue_work_products` rows
with `type = "artifact"`, joined with the issue chain (to surface the root
parent issue) and the agent that generated it.

These endpoints are **board-only**. Agent API keys are not authorized.

## List Deliverables

```
GET /api/companies/{companyId}/deliverables
```

Query parameters:

| Param | Description | Default |
|-------|-------------|---------|
| `limit` | Max items to return (1–200) | `50` |
| `offset` | Pagination offset | `0` |
| `projectId` | Restrict to a project | — |
| `agentId` | Restrict to an agent | — |
| `q` | Case-insensitive title contains filter | — |

Response:

```json
{
  "items": [
    {
      "id": "…",
      "companyId": "…",
      "projectId": null,
      "title": "Final report",
      "summary": null,
      "createdAt": "2026-05-01T00:00:00.000Z",
      "updatedAt": "2026-05-02T00:00:00.000Z",
      "contentPath": "/api/attachments/…/content",
      "contentType": "application/pdf",
      "byteSize": 1024,
      "originalFilename": "report.pdf",
      "childIssue": { "id": "…", "identifier": "PAP-12", "title": "Write report", "status": "done" },
      "rootIssue": { "id": "…", "identifier": "PAP-1",  "title": "Quarterly review", "status": "in_progress" },
      "agent":     { "id": "…", "name": "Astro", "icon": null },
      "runId": "…"
    }
  ],
  "limit": 50,
  "offset": 0
}
```

`rootIssue` is `null` when the child issue itself has no parent (i.e. it is the
root). `agent` is `null` when the producing run cannot be resolved. Items
ordered by `created_at DESC, id DESC`. Items whose stored metadata is not a
valid attachment-backed artifact are filtered out.

## Get Deliverable

```
GET /api/deliverables/{workProductId}
```

Returns the same shape as a list item, plus an `ancestors` array containing
every parent issue from the immediate parent up to the root (nearest first):

```json
{
  "id": "…",
  "title": "Final report",
  "ancestors": [
    { "id": "…", "identifier": "PAP-7", "title": "Middle", "status": "in_progress" },
    { "id": "…", "identifier": "PAP-1", "title": "Quarterly review", "status": "in_progress" }
  ]
}
```

Returns `404` when the work product does not exist or is not of type
`artifact`. Returns `403` when the actor cannot access the deliverable's
company.

## Downloading the file

Use `contentPath` directly — it points at the existing
`GET /api/attachments/{attachmentId}/content` endpoint, which enforces the same
company-access check.
