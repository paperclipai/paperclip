---
id: paperclip-feature-agent-models-settings
title: Agent Models Settings Panel
doc_type: spec
owner: paperclip
status: active
version: 1.0.0
updated: 2026-03-06
applies_to:
  - ui
depends_on: []
related_docs:
  - /home/avi/projects/paperclip/docs/deploy/environment-variables.md
toc: auto
---

The Company Settings dashboard includes an **Agent Models** section that lets board members change the LLM model for each agent without navigating to individual agent settings pages.

## Location

Company Settings → **Agent Models** section (above Invites).

## Behavior

| Detail | Value |
|--------|-------|
| Visibility | Only shown when the company has at least one non-terminated `claude_local` or `codex_local` agent |
| Per-agent control | Each agent row shows its name, adapter type, and a model dropdown |
| Save mechanism | Immediate — `PATCH /api/agents/:id` with `adapterConfig.model` on selection |
| "Default" option | Clears `adapterConfig.model`; agent uses CLI built-in default |
| When change takes effect | Next heartbeat run |

## Available Models

Models are fetched from `GET /api/adapters/{type}/models` per adapter type.

### claude_local

| ID | Label |
|----|-------|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |

### codex_local

Models fetched dynamically from OpenAI API (with fallback list if unavailable).

## Implementation

| File | Role |
|------|------|
| `ui/src/pages/CompanySettings.tsx` | `AgentModelsSection` + `AgentModelRow` components |
| `packages/adapters/claude-local/src/index.ts` | `models` export — static list for claude_local |
| `server/src/routes/agents.ts` | `GET /adapters/:type/models` endpoint |
| `server/src/adapters/registry.ts` | `listAdapterModels(type)` — static + dynamic models |

## Batch Save UX

The panel uses a **pending state** pattern:

1. Dropdown changes are held in local React state (not persisted yet)
2. Changed rows are highlighted with an "unsaved" badge
3. A single **Save changes** button sends all `PATCH /api/agents/:id` requests in parallel
4. **Cancel** discards all pending changes without any API calls
5. After successful save, the agent list is re-fetched to confirm

## Adapter Type Switching

Each agent row includes an **Adapter** dropdown (Claude Code / Codex) in addition to the Model dropdown. Switching adapter type:

- Immediately clears the model selection (user must re-pick for the new adapter)
- On save, sends `{ adapterType, adapterConfig: { model? } }` with a **fresh** adapterConfig — old adapter fields are never merged into the new adapter's config
- Rows with pending changes are highlighted; "unsaved" badge appears per-row
