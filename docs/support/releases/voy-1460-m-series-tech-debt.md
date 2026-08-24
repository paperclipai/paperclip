---
title: M‑Series Technical Debt Release — Atomic Template Deploy + Configurable Timeouts
version: voy-1460
date: 2026-08-19
commits: ceaa429591, 95382653cf, 95cce1ae89, bd287aeee2, 64445fc558, 77b48c9ad1
status: Shipped — merged to fork/master and deployed to production server (port 3100) at commit 1527a37d21
---

# M‑Series Technical Debt Release: Atomic Template Deploy + Configurable Timeouts

**Branches:** `fix/m-series-tech-debt`, `fix/m-series-tech-debt-main`
**Release status:** Shipped — merged to `fork/master` and deployed to production server (port 3100) at commit `1527a37d21`. Documentation verified in sync (VOY-1461).

---

## What Changed

### VOY-1403 (M-1): Atomic Company Template Deployment

Company template deployments now run inside a database transaction. If any critical step fails — skill install, agent creation, knowledge pack, goal, project, or starter issue — the **entire deployment rolls back** and no partial state is left behind.

| Aspect | Before | After |
|---|---|---|
| Skill install failure | Soft-fail with warning; company created anyway | **Fatal** — entire deployment rolls back |
| Agent creation failure | Partial company state left behind | **Fatal** — entire deployment rolls back |
| Knowledge pack failure | Soft-fail with warning | **Fatal** — entire deployment rolls back |
| Goal/project/issue creation failure | Partial state left behind | **Fatal** — entire deployment rolls back |
| Instructions materialization failure | Non-fatal warning (still the case) | Non-fatal warning (unchanged) |
| File-system cleanup | Orphaned instruction bundles could be left behind | Orphaned bundles cleaned up automatically on rollback |

**Impact for deployers:** A failed template deployment is now a clean no-op rather than a partially-created company that needs manual cleanup. If you were relying on best-effort partial deployments (e.g., deploying with a known-missing skill), you must ensure all template prerequisites are met before deploying.

### VOY-1404 (M-2): Edge-Case Test Coverage for Company Template Routes

Added comprehensive tests for company template list, detail, and deploy endpoints — covering invalid keys, empty states, atomically-rolled-back deployments, and privilege checks. No behavior changes — tests only.

### VOY-1405 (M-3): Consolidated Notification Constants

Duplicate `CHANNEL_AUTH_PROVIDER_MAP`, `NOTIFICATION_CONFIG`, and `checkContextForFeatures` definitions across notification files are consolidated into `packages/shared/src/index.ts`. No behavior change.

### VOY-1406 (M-4): Configurable Timeout Constants

All hardcoded timeout, TTL, and interval values across the server are extracted into `server/src/timeout-constants.ts`. Each constant honors an environment-variable override with a sensible default matching the previous hardcoded value.

| Scope | Count |
|---|---|
| New env-var-configurable constants | 50+ constants across HTTP, auth, invites, notifications, heartbeat, board chat, pipelines, caches, plugin workers, etc. |
| Defaults unchanged | All defaults match prior hardcoded values — no behavior change for unconfigured deployments |
| Environment variable naming | All `PAPERCLIP_*` prefixed (e.g., `PAPERCLIP_KEEP_ALIVE_TIMEOUT_MS`, `PAPERCLIP_EMBEDDING_TIMEOUT_MS`) |

See [configurable-timeouts.md](https://github.com/paperclip-ai/paperclip/blob/main/server/docs/configurable-timeouts.md) for the full reference, or the [Environment Variables](https://voyonder.com/docs/deploy/environment-variables#configurable-timeouts-ttls-and-intervals) page for the customer-facing summary.

### VOY-1458 (M-Series Audit Fixes)

| Finding | Severity | Change |
|---|---|---|
| 1 — Dead local constants not using env-honouring imports | HIGH | `embedding.ts`, `memory-context-injection.ts`, `environment-runtime.ts` now import from `timeout-constants.ts` |
| 2 — Unused imports in `app.ts` | HIGH | Removed `PLUGIN_ENV_DRIVER_PROBE_TIMEOUT_MS` and `ENVIRONMENT_PROVISION_TIMEOUT_MS` imports |
| 3 — Dead import in `cursor-models.ts` | HIGH | Removed unused `readConfigFile` import |
| 4 — Independently configurable `HEADERS_TIMEOUT_MS` | MEDIUM | `HEADERS_TIMEOUT_MS` now derived from `KEEP_ALIVE_TIMEOUT_MS + 1000ms`. Removed `PAPERCLIP_HEADERS_TIMEOUT_MS` env var. Guarantees `headersTimeout ≥ keepAliveTimeout` (Node.js invariant). |

### VOY-1456: Merge-Introduced Typecheck Fixes

Two typecheck errors introduced by the merge resolved:
- **notifications.ts** — `emailDeferredToDigest` variable was used in a block before its `let` declaration (Temporal Dead Zone). Fixed by hoisting the declaration.
- **board-chat.ts** — `logger.error` argument ordering fixed to match pino overloads.

## Configuration

### New Environment Variables

A full set of `PAPERCLIP_*` timeout/TTL/interval environment variables are now available. See the [Environment Variables reference](https://voyonder.com/docs/deploy/environment-variables#configurable-timeouts-ttls-and-intervals) for details.

### Removed Environment Variables

| Variable | Replacement |
|---|---|
| `PAPERCLIP_HEADERS_TIMEOUT_MS` | Removed. Now derived from `PAPERCLIP_KEEP_ALIVE_TIMEOUT_MS + 1000ms`. |

## Support Impact

### For Support Staff

| Change | What to know |
|---|---|
| **Atomic template deploy** | Deployments are now all-or-nothing. If a user reports a failed deploy leaving no company behind, that's expected — the rollback is complete. Check server logs for the failing step. |
| **No more soft-failure warnings** | The `warnings` array in the deploy response now only contains instructions materialization issues. Skill or pack failures produce a rejected HTTP response (not a 201 with warnings). |
| **Configurable timeouts** | If a deployment reports timeouts on template operations, operators can now tune `PAPERCLIP_*` env vars per their infrastructure characteristics. Direct users to the env-var reference. |
| **`PAPERCLIP_HEADERS_TIMEOUT_MS` removed** | If a deployment was using this variable, it's silently ignored. The headers timeout now follows keep-alive + 1s. This may reduce startup failures on slow proxies. |
| **DB client hardening** | `packages/db/src/client.ts` now passes `prepare: false` to the postgres connection config, disabling prepared statement caching — resolves potential issues with connection pooling and schema changes during migrations. |

## Related Documentation

- [Company Templates API Reference](https://voyonder.com/docs/api/company-templates) — Updated for atomic deploy behavior
- [Configurable Timeouts (internal)](https://github.com/paperclip-ai/paperclip/blob/main/server/docs/configurable-timeouts.md) — Full timeout/TTL/interval reference
- [Environment Variables Reference](https://voyonder.com/docs/deploy/environment-variables#configurable-timeouts-ttls-and-intervals) — Customer-facing env var summary with new timeout section
- [Company Templates Support Case Assessment](../assessments/support-case-company-templates.md) — Updated for atomic deploy behavior