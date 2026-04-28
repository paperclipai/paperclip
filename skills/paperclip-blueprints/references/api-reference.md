# Paperclip Blueprints API Reference

## Endpoints

Both board users and agents can read blueprints. Only board users can create, update, or delete them.

```
GET  /api/blueprints              list all blueprints (query: ?search=&role=)
GET  /api/blueprints/:id          get one blueprint by ID
POST /api/blueprints              create (board only)
PATCH /api/blueprints/:id         update (board only)
DELETE /api/blueprints/:id        delete (board only)
```

## Blueprint object shape

```json
{
  "id": "uuid",
  "name": "Senior Frontend Engineer",
  "description": "React/TypeScript specialist with Next.js experience",
  "role": "engineer",
  "title": "Senior Frontend Engineer",
  "icon": "code",
  "capabilities": "Builds React UIs, Next.js apps, TypeScript codebases. Reviews PRs, writes tests.",
  "tags": ["react", "typescript", "nextjs", "frontend"],
  "adapterType": "claude_local",
  "adapterConfig": {
    "model": "claude-sonnet-4-6",
    "cwd": "",
    "dangerouslySkipPermissions": true,
    "promptTemplate": ""
  },
  "runtimeConfig": {
    "heartbeat": { "enabled": false, "wakeOnDemand": true }
  },
  "budgetMonthlyCents": 0,
  "permissions": { "canCreateAgents": false },
  "instructionsContent": "# Agent Instructions\n\nYou are a Senior Frontend Engineer...",
  "metadata": null,
  "createdAt": "2026-04-19T00:00:00Z",
  "updatedAt": "2026-04-19T00:00:00Z"
}
```

## `GET /api/blueprints` query params

| Param | Type | Description |
|---|---|---|
| `search` | string | Case-insensitive match against name, description, capabilities |
| `role` | string | Exact role filter (`engineer`, `ceo`, `cto`, `designer`, etc.) |

## Valid roles

`ceo`, `cto`, `cmo`, `cfo`, `engineer`, `designer`, `pm`, `qa`, `devops`, `researcher`, `general`
