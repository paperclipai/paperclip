---
title: UI Layouts
summary: Per-user layout storage for the agent graph and the customizable dashboard
---

Store and read the signed-in board user's layout for one company surface. Each user has their own layout per company. Agent API keys cannot call these routes.

Surfaces: `agent_graph`, `dashboard`.

## Get Layout

```
GET /api/companies/{companyId}/ui-layouts/{surface}/me
```

Returns `{ "surface", "schemaVersion", "layout", "updatedAt" }`. `layout` is `null` when nothing is saved.

## Save Layout

```
PUT /api/companies/{companyId}/ui-layouts/{surface}/me
{ "layout": { "schemaVersion": 1, ... } }
```

The server validates `layout` against the schema of the surface and rejects unknown fields. The serialized layout must not exceed 262,144 bytes.

- `400` — the layout does not match the schema or is too large
- `403` — the caller is not a board user of this company
- `404` — unknown surface

## Reset Layout

```
DELETE /api/companies/{companyId}/ui-layouts/{surface}/me
```

Removes the saved layout. The app then shows its default layout.

## Layout Documents

Agent graph (`schemaVersion: 1`): `direction` (`TB` or `LR`), `viewport`, `positions` (manually moved agents only), `hiddenAgentIds`, `stickies`, and `drafts`. A draft is a hire that was not requested yet. It holds only a name, role, title, capabilities, adapter type, model, manager and position. It never holds adapter configuration, environment variables or secrets.

Dashboard (`schemaVersion: 1`): `widgets` (ordered, each with `instanceId`, `widgetId`, `w`, `h` and optional `config`) and `contextualRules`.

A layout is a personal view preference. Saves and resets do not write to the company activity log.
