---
name: memory
description: >
  Use this skill to store and recall shared knowledge across agents.
  Agents should store important discoveries (project patterns, preferences,
  architectural decisions) and recall relevant context at the start of work.
tags: [core]
---

# Shared Memory

Store and retrieve facts that persist across agent sessions and are shared
with all agents in the company.

## When to use shared memory vs personal memory (para-memory-files)

- **Shared memory** (this API): facts that benefit _any_ agent — project
  conventions, architecture decisions, user preferences, recurring patterns.
- **Personal memory** (para-memory-files): session-local notes, scratch
  context, or things only relevant to one agent's current task.

**Rule of thumb**: if another agent would benefit from knowing it, store it in
shared memory.

## API Reference

Base URL: `$PAPERCLIP_API_URL` (from environment)
Auth header: `Authorization: Bearer $PAPERCLIP_API_KEY`

### Store a fact

```bash
curl -s -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/memories" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Project uses Drizzle ORM with PostgreSQL; migrations in packages/db/drizzle/",
    "category": "knowledge",
    "scopeType": "company",
    "confidence": 0.95
  }'
```

### Recall facts

```bash
# Search by text
curl -s "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/memories?q=drizzle" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

# Filter by category
curl -s "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/memories?category=preference" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

# Filter by scope
curl -s "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/memories?scopeType=project&scopeId=UUID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### Delete a fact

```bash
curl -s -X DELETE "$PAPERCLIP_API_URL/api/memories/MEMORY_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `content` | string (required, max 4000) | The fact to store. Be specific and atomic. |
| `category` | string | `preference`, `knowledge`, `context`, `behavior`, or `goal`. Default: `knowledge` |
| `scopeType` | string | `company`, `project`, `issue`, or `agent`. Default: `company` |
| `scopeId` | uuid | Required when scopeType is `project`, `issue`, or `agent`. |
| `confidence` | number | 0-1, how confident you are. Default: 0.9 |

## Best practices

1. **Search before storing** — avoid duplicates. Query with `?q=` first.
2. **Be atomic** — one fact per memory. "Uses ESLint with Airbnb config" not
   "Uses ESLint, Prettier, and TypeScript with strict mode".
3. **Scope appropriately** — project-specific facts should use `scopeType=project`.
4. **Set confidence** — use 0.7-0.8 for inferred facts, 0.9+ for confirmed facts.
5. **Clean up** — delete facts that are no longer true.
