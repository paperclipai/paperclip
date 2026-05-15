# Plugin Secret Refs: Company Scope Reintroduction Plan

Date: 2026-04-26
Status: follow-up after fail-closed mitigation
Related issue: PAP-2394

## Current state

`PAP-2394` now fails closed:

- `POST /api/plugins/:pluginId/config` rejects any config containing plugin secret refs.
- `ctx.secrets.resolve()` is disabled for plugin workers.

This removes the release-blocking cross-company exposure path, but it also disables plugin secret-ref support until the runtime carries company scope end to end.

## Vulnerability summary

The original design mixed an instance-global config store with company-scoped secret bindings:

- [server/src/routes/plugins.ts](/Users/dotta/paperclip/.paperclip/worktrees/PAP-2339-secrets-make-a-plan/server/src/routes/plugins.ts:1898) saved one global plugin config row, then wrote bindings into `company_secret_bindings` grouped by each referenced secret's owning company.
- [packages/db/src/schema/plugin_config.ts](/Users/dotta/paperclip/.paperclip/worktrees/PAP-2339-secrets-make-a-plan/packages/db/src/schema/plugin_config.ts:15) stored one config row per plugin, with no company dimension.
- [packages/db/src/schema/company_secret_bindings.ts](/Users/dotta/paperclip/.paperclip/worktrees/PAP-2339-secrets-make-a-plan/packages/db/src/schema/company_secret_bindings.ts:5) already modeled bindings as company-scoped.
- [server/src/services/plugin-secrets-handler.ts](/Users/dotta/paperclip/.paperclip/worktrees/PAP-2339-secrets-make-a-plan/server/src/services/plugin-secrets-handler.ts:212) resolved by `pluginId` + secret UUID, with no active company context from the bridge call.
- [packages/plugins/sdk/src/worker-rpc-host.ts](/Users/dotta/paperclip/.paperclip/worktrees/PAP-2339-secrets-make-a-plan/packages/plugins/sdk/src/worker-rpc-host.ts:384) exposed `ctx.config.get()` and `ctx.secrets.resolve()` without a company parameter.

This violated Least Privilege, Complete Mediation, and Secure Defaults.

## Recommended end state

Re-enable plugin secret refs only after both of these are true:

1. Plugin config reads/writes are company-scoped.
2. Runtime secret resolution carries explicit company context and enforces it at resolution time.

## Implementation plan

### 1. Make plugin config company-scoped

- Add `company_id` to `plugin_config`, with a unique index on `(plugin_id, company_id)`.
- Update registry helpers to require `companyId` for `getConfig`, `upsertConfig`, `patchConfig`, and `deleteConfig`.
- Update plugin config routes to require `companyId` and call `assertCompanyAccess(req, companyId)`.
- Keep instance-global plugin lifecycle state separate from company-scoped plugin config.

### 2. Propagate company context through the worker runtime

- Extend the SDK so `ctx.config.get()` and `ctx.secrets.resolve()` can receive or derive `companyId`.
- Introduce worker request context storage for handlers that already run with company scope:
  - `getData`
  - `performAction`
  - scoped API routes
  - tool executions
  - environment driver calls
- Fail closed when plugin code tries to read company-scoped config or secrets outside an active company context.

### 3. Rebind secrets by `(companyId, pluginId, configPath)`

- On config save, validate every referenced secret belongs to the authorized company.
- Store bindings only for that company.
- Resolve secrets only by the current company-scoped binding, never by bare plugin ID plus UUID.
- Treat stale bindings as invalid and remove them on config replacement.

### 4. Prevent cross-company config disclosure

- When returning config to the UI, only materialize the selected company's secret refs.
- Never expose another company's secret UUIDs through the global plugin config surface.

## Required regression coverage

- Company A board user cannot save plugin config that references a Company B secret.
- Company A plugin execution cannot resolve a Company B secret even if the same plugin is configured for Company B.
- Company-scoped config reads only return the selected company's secret bindings.
- Config replacement removes stale bindings for the same `(companyId, pluginId)` target.
- Runtime calls without company context fail closed.

## Migration notes

- Existing `plugin_config` rows need a migration strategy before re-enable.
- Safest default: do not auto-assume a company for historical secret refs.
- Prefer one of:
  - explicit admin migration per company, or
  - import existing rows as non-secret config only and require re-entry of secret refs.

## Release posture

- Keep plugin secret refs disabled until all steps above land.
- Do not restore the feature behind a soft warning; the insecure path must remain unavailable by default.
