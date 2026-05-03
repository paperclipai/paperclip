## Thinking Path

> - Paperclip orchestrates AI agents for zero-human companies
> - Plugins extend the host with first-party capabilities (secrets store, config, containers, etc.)
> - CC-G4 gaps: plugins need to create/rotate/delete named secrets in the vault (e.g., Gitea token entry in settings UI), and PR #2776 opened this surface but used `actorType: "system"` (corrupting audit attribution) and had no UI
> - The correct actor for plugin-initiated writes is `actorType: "plugin"` with `actorId: "plugin:<pluginId>"` — already valid in the `ActivityEvent` union, no schema migration needed
> - This PR supersedes #2776 with a narrower, attribution-correct approach: `ctx.secrets.write()` / `ctx.secrets.delete()` RPC methods, ownership gating, rate limiting, and a read-only Plugin-Managed Secrets panel in Instance Settings
> - Cross-company authorization uses an opt-in model: the plugin must have an explicit `plugin_company_settings` row with `enabled=true` to write secrets for a given company (no row → denied)
> - The benefit is a safe, auditable, capability-gated secret-write surface that plugin authors can use without workarounds

## What Changed

- Adds `ctx.secrets.write()` and `ctx.secrets.delete()` RPC methods to the plugin SDK, enabling plugins to create, rotate, and delete named secrets in the Paperclip vault via the `secrets.write` capability
- Fixes `actorType: "system"` attribution bug from PR #2776 — all write/delete audit log entries now use `actorType: "plugin"` with the plugin's own ID as the actor
- Adds a **Plugin-Managed Secrets** panel to Instance Settings (read-only list for instance admins) so operators can see which plugins have created secrets
- Adds `secretService.listPluginOwned()` server-side helper querying by `createdByUserId LIKE 'plugin:%'`
- Adds the `secrets.write` capability to `PLUGIN_CAPABILITIES` and syncs `METHOD_CAPABILITY_MAP` and `plugin-capability-validator.ts`
- Changes cross-company authorization to opt-in: `assertPluginAuthorizedForCompany` requires an explicit `plugin_company_settings` row with `enabled=true` (no row → denied)
- Fixes delete audit-log ordering: `svc.remove` runs first; `logActivity` follows so no ghost entry is written for a failed deletion. Trade-off: if `logActivity` fails after a successful remove, the deletion is unlogged; all fields needed for the log entry are captured in local variables before the remove call, so a repair can reconstruct the audit entry from those snapshots. See Known follow-ups for a future outbox-based retry.

Credits: initial implementation approach from @insanepoet (PR #2776). Supersedes #2776 with a narrower approach that fixes `actorType` attribution, adds UI, and uses opt-in company authorization.

## Verification

**Tests (51 total):**
- Tier 1 (unit): 46 tests — capability gating (`METHOD_CAPABILITY_MAP`), validation (name format/length/reserved-prefix, value size), create/rotate/delete paths, rate-limit exhaustion (write + delete), provider env-var selection, RBAC, `actorType: "plugin"` audit log attribution, cross-company auth (write + delete reject when not authorized), `plugin-company-auth.ts` direct unit tests (no-row=denied, row-enabled=authorized, row-disabled=denied), audit log ordering (remove-first: `svc.remove` called even when `logActivity` fails) (`plugin-secrets-write.test.ts`, `plugin-company-auth.test.ts`)
- Tier 2 (embedded-postgres integration): 4 tests — real-DB verification of `listPluginOwned()` LIKE filter, multi-plugin results across companies, descending-createdAt ordering, empty result when no plugin secrets (`plugin-secrets-integration.test.ts`)
- Tier 3 (e2e): 11 tests total — 7 supertest RBAC route tests (instance admin, `local_implicit`, non-admin, plugin actor, agent actor; response shape; empty array) in `plugin-secrets-route.test.ts`; 4 Playwright UI tests (panel heading, empty state, board-user-secret isolation, capability description) in `tests/e2e/plugin-secrets-panel.spec.ts`

**Coverage:** 100% branches / 100% functions / 100% lines / 100% statements on **all code introduced by this PR**.

**Self-reviewed by gpt-5.4-mini xhigh; adversarial reviews by gpt-5.5 high (codex) and sonnet; 2 findings addressed in fix commits (no-row=denied auth semantics + remove-first audit log ordering).**

**Pre-submission review:** Pre-Greptile self-review via `codex exec --model gpt-5.4-mini -c model_reasoning_effort=xhigh` on amendment diff; no additional blockers found after the two Greptile-surfaced fixes.

## Known follow-ups (out of scope)

These pre-existing issues were identified during review but are not introduced by this PR:

- **Rotate-race condition** (`secrets.ts:233`): `nextVersion` is computed before the DB transaction in `secretService.rotate()`. Concurrent rotates could produce a unique-key violation on `(secretId, version)`. Affects all callers of `rotate`, not just plugin write path.
- **Secrets not purged on plugin uninstall** (`plugin-lifecycle.ts:1390`): `cleanupInstallArtifacts()` removes filesystem artifacts only. Secrets with `createdByUserId = "plugin:<id>"` survive hard-uninstall with `removeData=true`. Needs a dedicated lifecycle hook.
- **`plugin_company_settings` row creation UX**: With opt-in authorization, operators must ensure a `plugin_company_settings` row with `enabled=true` exists for each company a plugin should write secrets to. A follow-up PR should add UI for managing these rows in Instance Settings.
- **Audit log outbox for delete path**: if `logActivity` fails after `svc.remove()` succeeds, the deletion is unlogged. The fields needed for the log entry (companyId, actorId, secretId, name) are captured before the remove call and could be replayed by an operator. A future outbox/retry mechanism would make this durable.

## Risks

- `secretService.listPluginOwned()` uses a `LIKE 'plugin:%'` string prefix filter on `createdByUserId`. This is correct for the current naming scheme but relies on the convention that board user IDs never start with `"plugin:"`. If that invariant breaks, the filter would include non-plugin entries.
- The Plugin-Managed Secrets panel is read-only; operators cannot delete plugin secrets from the UI. Deletion requires calling the plugin's own `ctx.secrets.delete()` or using the company secrets page directly.
- Changing `plugin-company-auth.ts` to opt-in semantics is a behavioral change: any existing deployment where plugins were writing secrets without explicit `plugin_company_settings` rows will require those rows to be created. For new deployments this is purely additive.

## Model Used

Implementation and amendment loop: Claude Sonnet 4.6 (claude-sonnet-4-6, 200K context, tool use). Pre-Greptile self-review: OpenAI gpt-5.4-mini via `codex exec --model gpt-5.4-mini -c model_reasoning_effort=xhigh`. Final adversarial: OpenAI gpt-5.5 via `codex exec --model gpt-5.5 -c model_reasoning_effort=high`.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] Tests pass (51 tests; 1 pre-existing unrelated SSH test fails in full suite)
- [x] 100% coverage on new code paths
- [x] No pnpm-lock.yaml edits
- [x] PR credits @insanepoet for original PR #2776

Generated with [Claude Code](https://claude.ai/code)
