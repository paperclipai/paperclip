---
title: UI Layouts
summary: Per-user layout storage for the agent graph and the customizable dashboard
---

Store and read the signed-in user's own layout for one company surface. Each user has their own layout per company. A layout is a personal preference, so every active member of the company can read, save and reset their own layout. This includes viewers, who are read-only for company data. A user can never read or change the layout of another user. Agent API keys cannot call these routes.

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
- `403` — the caller is an agent, or a user without active access to this company
- `404` — unknown surface

## Reset Layout

```
DELETE /api/companies/{companyId}/ui-layouts/{surface}/me
```

Removes the saved layout. The app then shows its default layout.

Get and reset return the same `403` and `404` responses as save.

## Layout Documents

Agent graph (`schemaVersion: 1`): `direction` (`TB` or `LR`), `viewport`, `positions` (manually moved agents only), `hiddenAgentIds`, `stickies`, and `drafts`. Each sticky note and each draft has an `id` that is unique within its list. A draft is a hire that was not requested yet. It holds only a name, role, title, capabilities, adapter type, model, manager and position. It never holds adapter configuration, environment variables or secrets.

Dashboard (`schemaVersion: 1`): `widgets` (ordered, each with `instanceId`, `widgetId`, `w`, `h` and optional `config`) and `contextualRules`.

## Activity Log

The first save of a layout creates the stored row and writes one `ui_layout.created` entry to the company activity log. A reset that removes a stored layout writes one `ui_layout.reset` entry. The saves that follow the first one write no entry, because the apps save automatically after every change. An entry holds the user id and the surface, and never the layout content.
