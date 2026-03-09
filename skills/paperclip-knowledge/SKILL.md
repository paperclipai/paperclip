---
name: paperclip-knowledge
description: >
  Manage Paperclip company knowledge through the Paperclip API. Use when you
  need to find existing knowledge, publish durable work products, update shared
  docs, attach knowledge to issues, or clean up knowledge you own.
---

# Paperclip Knowledge Skill

Use this skill for company memory, not for one-off scratch work.

Knowledge should usually contain:
- audits
- reports
- handoff notes
- runbooks
- access notes
- integration notes
- reusable debugging summaries
- onboarding notes for a subsystem

Do **not** use Knowledge for transient scratchpad text with no future reuse value.

## Authentication

Paperclip injects these env vars into the agent process:
- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_RUN_ID`
- often `PAPERCLIP_TASK_ID` when the work came from an issue

All requests use:
- `Authorization: Bearer $PAPERCLIP_API_KEY`
- `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on mutating requests

## Operating Rules

1. Before creating a new knowledge item, list existing knowledge and check whether an item already exists.
2. If an item already exists for the same durable concept, update it instead of creating a duplicate.
3. If the work came from an issue and the artifact is reusable, attach the knowledge item back to that issue.
4. Treat Knowledge as company memory: other agents may update it later.
5. Do not delete knowledge you did not create unless you are explicitly acting as CEO / board through the Paperclip permission model.

## Common Workflows

### 1. List company knowledge

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/knowledge-items" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 2. Inspect one item

```sh
curl -sS "$PAPERCLIP_API_URL/api/knowledge-items/<knowledge-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 3. Create a note knowledge item

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/knowledge-items" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Stripe integration audit",
    "kind": "note",
    "summary": "Current Stripe integration status, risks, and next actions.",
    "body": "## Summary\n\n- Current state ...\n- Risks ...\n- Recommended next steps ..."
  }'
```

### 4. Update an existing note knowledge item

```sh
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/knowledge-items/<knowledge-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "summary": "Revised Stripe integration status after webhook fix.",
    "body": "## Summary\n\n- Updated state ...\n- Remaining risk ..."
  }'
```

### 5. Delete knowledge you own when cleanup is justified

```sh
curl -sS -X DELETE "$PAPERCLIP_API_URL/api/knowledge-items/<knowledge-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"
```

Delete is restricted by the server. If deletion is rejected, do not retry blindly. Usually update the document instead.

### 6. List knowledge attached to the current issue

```sh
curl -sS "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/knowledge-items" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 7. Attach knowledge to the current issue

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/knowledge-items" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"knowledgeItemId":"<knowledge-id>"}'
```

### 8. Detach knowledge from the current issue

```sh
curl -sS -X DELETE "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/knowledge-items/<knowledge-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"
```

## Decision Rule: Create vs Update

Create a new knowledge item when:
- this is a new durable artifact
- the topic does not already exist in company knowledge

Update an existing knowledge item when:
- you are revising the same runbook / report / integration note
- the knowledge title and intent are substantially the same
- creating a new item would fragment company memory

## Expected Heartbeat Behavior

If your run produces reusable organizational knowledge:
1. Check whether a matching knowledge item already exists.
2. Create or update the knowledge item.
3. If your work came from an issue, attach the knowledge item to that issue.
4. Mention the resulting knowledge item in your issue update.

For full endpoint payload shapes and examples, see:
`skills/paperclip-knowledge/references/api-reference.md`
