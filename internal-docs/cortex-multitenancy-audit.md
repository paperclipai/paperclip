# Cortex Multi-Tenancy Audit

**Date:** 2026-05-04
**Branch:** `integration`
**Scope:** Does inherited paperclip code support true multi-tenancy — i.e., can Company ABC and Company XYZ share a single Cortex deployment with their data fully isolated?

## Verdict

**Yes — paperclip is genuinely multi-tenant**, not single-tenant with org-scoping bolted on. A shared Cortex deployment can safely host multiple companies today, with the caveats in [§ Hardening Strategy](#hardening-strategy) below.

This validates the "multi-tenant from day one" assumption already encoded in `CLAUDE.md` and `cortex-orchestrator-plan.md`.

## Evidence

### Schema-level isolation (strong)

Every major entity table carries a `companyId` foreign key to a top-level `companies` table. Indices are `(companyId, ...)`-leading, keeping per-tenant queries fast.

Tables verified:

- Core: `agents`, `projects`, `issues`, `goals`, `documents`, `assets`
- Financial: `cost_events`, `budgetIncidents` (per-company budget counters live on the `companies` row itself)
- Secrets: `companySecrets`, `companySecretVersions` — uniqueness enforced per company
- Access: `companyMemberships` (users + agents as principals)
- Audit: `activityLog`

Key files:
- `packages/db/src/schema/companies.ts` — top-level tenant entity
- `packages/db/src/schema/agents.ts` — `companyId` FK + composite indices
- `packages/db/src/schema/issues.ts` — `(companyId, ...)` indices throughout
- `packages/db/src/schema/cost_events.ts` — all indices scoped by company

### Auth & request scoping (strong)

`server/src/middleware/auth.ts` resolves a tenant context for every request:

- **Agent actors:** JWT contains a `company_id` claim, verified against the agent record's `companyId`. Mismatch = auth failure.
- **Board users:** `req.actor.companyIds` is populated from `companyMemberships`.

`server/src/routes/authz.ts` enforces access at route entry:

- Agents can only access their own company (`req.actor.companyId !== companyId` throws forbidden)
- Board users are filtered by their `companyIds` membership array
- Writes require an active membership

Every route calls `assertCompanyAccess(req, companyId)` before returning data.

### Plugin system tenancy (strong)

Plugin **code** is instance-wide; plugin **data** is tenant-scoped.

- `plugin_state` keyed by `(pluginId, scopeKind, scopeId, namespace, stateKey)` — `company` is a valid `scopeKind`, so per-tenant state is first-class.
- Plugin secrets live in `companySecrets`; the secrets handler validates that a referenced secret UUID is declared in the plugin's `pluginConfig` (rate-limited at 30 resolutions/min).
- Host services (`server/src/services/plugin-host-services.ts`) ship `ensureCompanyId()` and `inCompany()` guards — every host-service read filters by the requesting company.
- `plugin_company_settings` lets each company independently enable/disable or override plugin settings.
- Event bus (`plugin-event-bus.ts`) emits scoped to `companyId`.

### Cross-tenant leakage (minimal)

Properly scoped:

- File storage: object keys prefixed `companyId/namespace/...` in `server/src/storage/service.ts`
- Activity log: every row carries `companyId`
- Real-time events: `subscribeCompanyLiveEvents(companyId)` per-tenant; `subscribeGlobalLiveEvents()` only for instance-level traffic
- Counters & budgets: live on `companies`, never global

Instance-level surfaces (intentionally shared, not tenant data):

- `instanceSettings` (singleton config)
- `instanceUserRoles` (instance-admin flag)
- Adapter plugins config in `~/.paperclip/adapter-plugins.json`
- Auth tables (`authUsers`, `authSessions`, `authAccounts`) — multi-tenancy modeled via `companyMemberships` join

### Single-tenant assumptions

**None found.** No hardcoded `COMPANY_ID` env vars (only `PAPERCLIP_COMPANY_ID` injected per agent/workspace runtime), no `getCurrentCompany()` singletons, no global caches that bypass tenant context.

## Hardening Strategy

Cortex is safe to run multi-tenant on the existing foundation. These are the gaps to close *before* exposing externally to non-WBIT companies.

1. **Bridge-plugin contract requires tenant scoping.**
   Plugin-defined custom tables are per-plugin, not per-company. Any WBIT bridge plugin (`paperclip-plugin-wbit-{sibling}`) that stores data must:
   - Include a `company_id` column on every custom table
   - Filter on `company_id` in every query
   - Use `plugin_state` with `scopeKind = 'company'` for ad-hoc per-tenant state
   - Encode this as a hard rule in the bridge-plugin contract (Phase 1 deliverable; ties to plan doc §8 Q7/Q8).

2. **Service-layer cross-tenant join audit.**
   Route-layer enforcement is consistent. Spot-check service-layer queries (`server/src/services/`) for missing `companyId` filters on multi-table joins — those are the places a regression could leak data without a route change.

3. **API key rotation policies.**
   `agentApiKeys` and `boardApiKeys` lack automatic expiry/rotation. Add per-company rotation policy and forced-rotation tooling before any external tenant lands.

4. **Plugin secret access logging.**
   The 30/min rate limit is good defense-in-depth; pair it with an audit trail of which plugin resolved which secret for which company, so we can detect anomalous access patterns.

5. **Budget policy scoping confirmation.**
   Verify any `budgetPolicies` (or equivalent) entries are company-scoped, not instance-wide — easy to miss when extending the budget system.

6. **Activity-log query hygiene.**
   Ensure all `activityLog` reads filter by `companyId`. The schema is correct; the risk is at the query site.

## Summary table

| Layer | Status | Isolation mechanism |
|---|---|---|
| Database schema | Strong | `companyId` FK on all entity tables; per-company uniqueness constraints |
| Authentication | Strong | JWT/key payload includes `company_id`; validated against agent/membership record |
| Authorization | Strong | `assertCompanyAccess()` enforced at route entry; users filtered by `companyIds` |
| Secrets | Strong | `companySecrets` table; plugin access scoped to declared config references |
| State | Strong | `plugin_state` keyed by `(pluginId, scopeKind, scopeId, ...)` with `company` scope |
| File storage | Strong | Object keys prefixed `companyId/...` |
| Activity log | Strong | `companyId` FK + indexed |
| Real-time events | Strong | Company-scoped subscriptions; no cross-company leakage |
| Instance config | N/A | Intentionally shared (adapters, auth settings) — no tenant data |

## Implications for Cortex

- The "multi-tenant from day one" rule in `CLAUDE.md` is already enforceable — extend paperclip's `companies`/`companyMemberships`/`companyId` model rather than inventing parallel scoping.
- The Bayesian spec's `belief_state` table being org-scoped lines up; Phase 3 will not need to retrofit tenancy into the engine.
- Sibling integration via bridge plugins (Option C, decided 2026-05-03) is compatible — bridge plugins inherit per-company state, secrets, and host-service scoping for free, provided they follow item 1 above.
