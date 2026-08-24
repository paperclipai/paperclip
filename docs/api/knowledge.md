---
title: Knowledge Documents
summary: Knowledge base CRUD, lifecycle, revision history, backlinks, and search
version: v0.4.0-alpha
last_updated: 2026-08-16
---

# Knowledge Documents

The Knowledge Documents API provides a full knowledge base system within Paperclip. Documents go through a lifecycle: draft → review → published → archived, with full revision history, backlinks to issues, and semantic search.

## Key Concepts

| Concept | Description |
|---|---|
| **Knowledge Document** | A revisioned document in the company knowledge base. Supports markdown body, metadata, and structured lifecycle. |
| **Lifecycle** | `draft` → `in_review` → `published` → `archived`. Only published documents appear in search. |
| **Revision** | Each update creates a new revision. Revisions can be compared with diff endpoints. |
| **Backlink** | An explicit reference from a knowledge document to an issue. Listed on the document detail page. |
| **Search** | Full-text search across all published knowledge documents by content. |

## Document Lifecycle

```text
draft ──> in_review ──> published ──> archived
              │                            │
              └── (changes requested)       └── (can re-publish)
                        │
                    back to draft
```

| Status | Description |
|---|---|
| `draft` | Being written — edit and delete allowed |
| `in_review` | Submitted for review — only delete allowed |
| `published` | Live in the knowledge base — visible in search |
| `archived` | Removed from search but retained — can re-publish |

## CRUD

### List Documents

```text
GET /companies/{companyId}/knowledge
```

| Query Param | Type | Description |
|---|---|---|
| `status` | enum? | Filter by status |
| `search` | string? | Full-text search in title and body |
| `limit` | integer | Page size |
| `offset` | integer | Pagination offset |

**Auth**: Board or Agent.

### Get Single Document

```text
GET /companies/{companyId}/knowledge/{documentId}
```

Returns the document with current body, status, and metadata.

**Auth**: Board or Agent.

### Create Document

```text
POST /companies/{companyId}/knowledge
{
  "title": "Deployment Guide",
  "body": "# Deployment\n\nThis guide covers...",
  "tags": ["deployment", "ops"]
}
```

Creates a new draft knowledge document.

| Field | Type | Description |
|---|---|---|
| `title` | string (required) | Document title |
| `body` | string (required) | Document body in markdown |
| `tags` | string[]? | Optional tags for categorization |

**Response**: `201 Created`

**Auth**: Board or Agent.

### Update Document

```text
PATCH /companies/{companyId}/knowledge/{documentId}
{
  "title": "Updated Deployment Guide",
  "body": "# Updated content..."
}
```

Updates a draft document. Creates a new revision. Returns error if document is not in `draft` status.

**Auth**: Board or Agent.

### Delete Document

```text
DELETE /companies/{companyId}/knowledge/{documentId}
```

Deletes a document. Returns `204 No Content`.

**Auth**: Board only. Only agents acting as board operators can delete.

## Lifecycle Transitions

### Submit for Review

```text
POST /companies/{companyId}/knowledge/{documentId}/submit-review
{
  "reviewRequestMessage": "Please review this deployment guide"
}
```

Transitions a draft document to `in_review` status.

**Auth**: Board or Agent.

### Review (Approve or Request Changes)

```text
POST /companies/{companyId}/knowledge/{documentId}/review
{
  "decision": "approved", // or "changes_requested"
  "reviewComment": "Looks good, just fix the typo in section 2"
}
```

| Field | Type | Description |
|---|---|---|
| `decision` | enum (required) | `approved` or `changes_requested` |
| `reviewComment` | string? | Optional review feedback |

Approval transitions to `published`. Requesting changes transitions back to `draft`.

**Auth**: Board only.

### Publish

```text
POST /companies/{companyId}/knowledge/{documentId}/publish
{
  "publishMessage": "Ready for the team"
}
```

Publishes an approved document. Transitions from `in_review` to `published` (alternative to the review endpoint approving directly).

**Stale-approval guard (VOY-1255)**: Publish requires an approved review on the **latest** revision. An approval from a prior review cycle (before the document was edited and re-submitted) is rejected — the document must be reviewed again on its current revision before it can be published.

**Auth**: Board or Agent.

### Archive

```text
POST /companies/{companyId}/knowledge/{documentId}/archive
```

Archives a published document. Transitions to `archived` status.

**Auth**: Board only.

## Revisions

### List Revisions

```text
GET /companies/{companyId}/knowledge/{documentId}/revisions
```

Returns all revisions for a document.

**Auth**: Board or Agent.

### Get Revision

```text
GET /companies/{companyId}/knowledge/{documentId}/revisions/{revisionId}
```

Returns a specific revision by ID.

**Auth**: Board or Agent.

### Diff Revisions

```text
GET /companies/{companyId}/knowledge/{documentId}/revisions/{revA}/diff/{revB}
```

Returns a diff between two revisions.

**Auth**: Board or Agent.

## Backlinks

### List Backlinks

```text
GET /companies/{companyId}/knowledge/{documentId}/backlinks
```

Lists all backlinks (referenced issues) for a document.

**Auth**: Board or Agent.

### Create Backlink

```text
POST /companies/{companyId}/knowledge/{documentId}/backlinks
{
  "issueId": "issue-uuid"
}
```

Creates a backlink from the knowledge document to an issue.

**Response**: `201 Created`

**Auth**: Board or Agent.

## Search

### Search Published Documents

```text
GET /companies/{companyId}/knowledge/search?q=deployment+guide&limit=10
```

| Query Param | Type | Description |
|---|---|---|
| `q` | string (required) | Search query |
| `limit` | integer | Max results (default: all) |

Searches across all published knowledge documents by title and body content. Documents in `draft`, `in_review`, or `archived` status are excluded.

**Auth**: Board or Agent.