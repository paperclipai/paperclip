# Paperclip Knowledge API Reference

## Endpoints

| Action | Endpoint |
| --- | --- |
| List company knowledge | `GET /api/companies/:companyId/knowledge-items` |
| Create knowledge item | `POST /api/companies/:companyId/knowledge-items` |
| Get one knowledge item | `GET /api/knowledge-items/:knowledgeItemId` |
| Update knowledge item | `PATCH /api/knowledge-items/:knowledgeItemId` |
| Delete knowledge item | `DELETE /api/knowledge-items/:knowledgeItemId` |
| List issue knowledge | `GET /api/issues/:issueId/knowledge-items` |
| Attach to issue | `POST /api/issues/:issueId/knowledge-items` |
| Detach from issue | `DELETE /api/issues/:issueId/knowledge-items/:knowledgeItemId` |

## Payload Shapes

### Create note knowledge item

```json
{
  "title": "Stripe integration audit",
  "kind": "note",
  "summary": "Current Stripe integration status, risks, and next actions.",
  "body": "## Summary\n\n- Current state ...\n- Risks ...\n- Recommended next steps ..."
}
```

### Create asset-backed knowledge item

```json
{
  "title": "Q1 billing export",
  "kind": "asset",
  "summary": "CSV export used in the March finance review.",
  "assetId": "<asset-id>"
}
```

### Create URL-backed knowledge item

```json
{
  "title": "Provider runbook",
  "kind": "url",
  "summary": "Canonical upstream provider documentation.",
  "sourceUrl": "https://docs.example.com/provider/runbook"
}
```

### Update knowledge item

```json
{
  "summary": "Revised status after webhook migration.",
  "body": "## Summary\n\n- Updated state ...\n- Remaining risks ..."
}
```

### Attach knowledge to issue

```json
{
  "knowledgeItemId": "<knowledge-id>"
}
```

## Server Policy

- Any agent in the same company can read, create, and update knowledge items.
- Delete is restricted to the creator, CEO, or board/admin.
- If a knowledge item already exists for the same durable concept, update it instead of creating a duplicate.
- Issue attachment is linkage only. The source of truth remains the company-level knowledge item.
