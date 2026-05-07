# Company AI Builder

Date: 2026-05-04
Status: Phase 0 (read-only spike) being implemented in this PR; Phases 1-4 follow.

## 1. Goal & scope

Build an in-app **AI Builder** for a Bizbox company: a chat-like surface (scoped
to a company) that talks to a configured LLM and can mutate Bizbox control-plane
primitives — companies, agents, org/reports-to, goals, projects, issues,
routines, budgets, secrets, approvals — using the **existing service layer** as
the underlying tool surface, fronted by a typed **MCP-style tool layer** that
maps cleanly to capabilities and audit logging.

It is *not* a generic chatbot (per `PRODUCT.md` "do not"s). It is a **board
operator copilot** that produces governed mutations against a single company,
with previews, diffs, and approvals where needed.

## 2. Decisions taken (from clarifying questions)

| # | Question | Decision |
|---|---|---|
| 1 | v0 mutation surface | Read-only catalog in Phase 0 (`list_companies`, `list_agents`, `list_goals`, `list_issues`, `list_routines`, `get_budget_summary`). Curated mutations land in Phase 1+. |
| 2 | Who can use it | Board only (`builder:use`). Agent access deferred. |
| 3 | Approval model | N/A in Phase 0. Phase 1+: proposal-based for create/destroy, direct for safe edits, configurable per company. |
| 4 | Plugin vs core | Hybrid: core ships service + tool registry + UI; an extension surface (`registerBuilderTool`) lets plugins contribute additional tools without touching core. |
| 5 | LLM providers (v0) | OpenAI-compatible URL only (covers OpenAI, Together, Groq, local). Anthropic deferred. |
| 6 | Streaming | Non-streaming JSON for v0; SSE in Phase 4. |
| 7 | Cost accounting | Per-message `tokens` + `cost_cents` columns recorded on `builder_messages`; full bridge into `cost_events` (synthetic agent) deferred to Phase 4. |
| 8 | Naming | "Company AI Builder". |
| 9 | Reference docs | Mirror only the surface this fork actually exposes. |

## 3. Architecture

```
UI: ui/src/pages/CompanyBuilder.tsx
  - chat transcript, tool-call cards
  - (later) diff preview, apply/approve/reject affordances
        │  REST  /api/companies/:id/builder/*
        ▼
Server: builderService + builderRoutes
  - LLM client (provider-pluggable, OpenAI-compat in v0); secrets via secretService
  - Tool runner: invokes core service functions (NOT raw HTTP); enforces:
      * assertCompanyAccess
      * builder:use permission gate
      * (later) approval gating via approvalService
      * (later) logActivity for every mutation
      * (later) cost-event ingestion via synthetic agent
  - Tool registry: core read-only tools + extensions (registerBuilderTool)
        │ uses
        ▼
Existing services: companies / agents / goals / projects /
issues / routines / approvals / budgets / secrets / access
```

Two key design choices:

- **Tools call services, not HTTP.** Re-using the service layer is the only way
  to keep invariants (atomic checkout, approval gates, budget hard-stop,
  activity log) intact.
- **Builder runs are first-class `builder_sessions`** so transcripts, costs,
  pause/stop, and activity can plug into existing systems. Sessions are
  conversation containers only; live runtime config comes from the
  company-level Builder settings record.

## 4. Data model

New tables in `packages/db/src/schema/`:

- `builder_sessions` — `id`, `companyId`, `createdByUserId`, `title`,
  `providerType`, `model`, `state` (`active|completed|aborted`), token totals,
  timestamps. `providerType` and `model` are legacy snapshots; the active
  runtime config is owned by `builder_provider_settings`.
- `builder_messages` — `id`, `sessionId`, `companyId`, `role`
  (`user|assistant|tool|system`), `content` (JSON: text + tool calls + tool
  results), `tokens`, `costCents`, timestamps.
- `builder_proposals` — `id`, `sessionId`, `messageId`, `companyId`, `kind`,
  `payload` (JSON), `status` (`pending|approved|applied|rejected|failed`),
  `appliedActivityId`, `approvalId`. *(Phase 1+; table created now, unused in
  Phase 0.)*
- `builder_provider_settings` — `companyId`, `providerType`, `model`, `baseUrl`,
  `secretId` (FK to `companySecrets`), `extras`.
  This is the single source of truth for Builder runtime config across all
  sessions in the company.

All four are company-scoped and cascade on company delete.

## 5. Server surface

- `services/builder/provider/openai-compat.ts` — single chat() call with
  `tools` parameter and `tool_choice: auto`.
- `services/builder/tools/` — one file per primitive. Each tool:
  ```
  { name, description, inputSchema (zod),
    requiresApproval: boolean, capability: string,
    run(ctx, input) }
  ```
- `services/builder/tool-registry.ts` — core tools + plugin/platform extension
  registrations.
- `services/builder/runner.ts` — orchestration loop (max-turns capped).
- `services/builder/audit.ts` — logActivity wrapper using
  `actorType=user, actorId=board-user` plus `details.builderSessionId`.
- `services/builder.ts` — session/message/settings persistence.

REST routes (`/api/companies/:companyId/builder/*`):

- `GET    /sessions` / `POST /sessions`
- `GET    /sessions/:sid` (full transcript)
- `POST   /sessions/:sid/messages` (send user message; returns updated transcript)
- `POST   /sessions/:sid/abort`
- `GET    /tools` (tool catalog with capability badges)
- `GET    /settings` / `PUT /settings`
- *(Phase 1+)* `GET /proposals/:pid`, `POST /proposals/:pid/apply|reject`

All routes gated by `assertCompanyAccess` + `builder:use` board check + the
`builderEnabled` instance feature flag.

## 6. UI

- `ui/src/pages/CompanyBuilder.tsx` — split layout: settings sidebar + chat.
- `ui/src/api/builder.ts` — typed client (REST only in Phase 0).
- Sidebar entry under company nav, hidden unless `builderEnabled` is true on
  instance experimental settings.

## 7. Security & invariants

- Never bypass approvals/budget/checkout — tools call services.
- Forbidden tools: no direct DB access, no "execute SQL", no approval override.
- Secrets only via `secretService`; never echoed to the model.
- Per-session caps: `maxTurns`, `maxToolCalls` (defaults 8 / 16).

## 8. Rollout phases

1. **Phase 0 — read-only spike** *(this PR)*: schema, settings, OpenAI-compat
   provider, read tools, chat UI, no mutations.
2. **Phase 1 — curated mutations** (proposal-based): routine, goal, issue.
3. **Phase 2 — governed primitives**: hire agent, set budget, update company,
   grant access — proposals integrate with existing `approvalService`.
4. **Phase 3 — extension surface**: `surfaces: ["builder"]` on
   `PluginToolDeclaration`; sample plugin under `packages/plugins/examples/`.
5. **Phase 4 — polish**: SSE streaming, cost-event bridge, redaction tests,
   eval harness in `evals/`.

## 9. Risks

- Governance regressions if tools build their own DB calls — enforced by
  convention "tool implementations may only import from `services/`".
- Token spend surprises — per-session caps + monthly hard-stop.
- Provider lock-in — kept tiny via `openai-compat` interface.
- UI clutter vs. PRODUCT.md "not a chatbot" — Builder is a *tool* page, not
  the home/dashboard.
