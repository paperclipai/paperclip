# Upstream PR — Cross-Company Capability Grants (core)

Use this file as the **PR description** when opening a PR from `amirhmoradi/paperclip` → `paperclipai/paperclip`.

**Suggested title:** `feat(auth): add cross-company capability grants (core, flag-gated)`

**Branch:** `feat/cross-company-grants-core`

**Push (you run this):**

```bash
cd docs/src/paperclipai   # or your paperclip fork checkout
git fetch origin master   # paperclipai/paperclip master
git rebase origin/master  # resolve conflicts if any
git push -u upstream feat/cross-company-grants-core
```

Then open the PR on GitHub targeting `paperclipai/paperclip:master` ← `amirhmoradi/paperclip:feat/cross-company-grants-core`.

---

## PR body (copy everything below this line into GitHub)

## Thinking Path

> - Paperclip is the open-source app people use to manage AI agents for work
> - Each instance can host multiple **companies**, and agent API keys are **company-scoped** — an agent authenticated for company A must not access company B's data or mutations
> - That hard boundary is correct by default, but it blocks legitimate automatable work: internal consultancies auditing client companies, a shared CEO operating multiple companies, or foreign agents performing narrowly scoped tasks in a target company with explicit consent
> - Today the only escape hatches are over-broad (instance-admin board key) or non-automatable (interactive board session); related demand is tracked in issues like #2212, #1083, #5015, and #1177
> - Same-company `principalPermissionGrants` cannot help: `decidePrincipalGrant` requires active membership in the target company, and the agent branch in `authorizationService.decide()` hard-denies when `actor.companyId !== targetCompanyId` before any grant logic runs
> - This pull request adds a **first-class, flag-gated, server-honored** `cross_company_grants` table and authorization hook so a **specific foreign agent** can perform an **explicit allowlisted action set** in a **specific target company** when an active grant exists — with **no behavior change** when the flag is off or no grant is present
> - The benefit is a fail-closed, auditable foundation for cross-company work without weakening default isolation; issuance (approval flow, plugin broker, Ed25519 signing) is intentionally deferred to a follow-up PR

## Linked Issues or Issue Description

### Related issues (demand + safety bar)

- **Refs #2212** — No cross-company coordination mechanism (native alternative to MCP blackboard workarounds)
- **Refs #1083** — Multi-company agent identity (intra-instance; distinct from but related to cross-company access)
- **Refs #5015** — Company-scoped operator tokens (complementary: CCG is agent-scoped, target-company-issued)
- **Refs #1177** — Agent keys vs board session capabilities (scoped non-interactive delegation)
- **Refs #375** — Permission grants API (same-company grants; CCG is a separate table by design)
- **Refs #955** — Fail-closed cross-company agent-key routing (this PR preserves deny when flag off / no grant)
- **Refs #20** — Lesson: issuance must not be self-approved; follow-up plugin will require target-company board approval

### Related PRs / prior art (no duplicate in-flight CCG PR found)

- **Refs #1170** — Cross-company agent-key isolation hardening
- **Refs paperclipai/paperclip#7525** — `cloud_tenant` company-scoped tenants (orthogonal; CCG is opt-in grant rows)

### In-PR feature description (no single tracking issue yet)

**Subsystem:** Cross-cutting — `packages/db`, `packages/shared`, `server/`

**Problem or motivation**

Operators running multiple companies on one instance need a **narrow, revocable, time-boxed** way for agent A (home company) to perform specific actions in company B — without handing out instance-admin keys or interactive board sessions. The default `deny_company_boundary` in `authorization.ts` and `assertCompanyAccess()` is correct; we need a first-class grant primitive that the server honors.

**Proposed solution (this PR — core only)**

1. New `cross_company_grants` table (Drizzle schema + migration `0101_cross_company_grants.sql`)
2. `PAPERCLIP_CROSS_COMPANY_GRANTS` env flag — **default off**; when disabled, authorization is bit-identical to today
3. `authorizationService.decide()` agent branch: consult active grant for cross-company actors (action allowlist, scope, budget cap)
4. `assertCompanyAccess()` made async with optional `db` — coarse pass when active grant exists so route-level gates do not short-circuit before `access.decide()` (dual-gate fix)
5. `costService.createEvent()` relaxed for CCG-backed foreign agents; increments `budgetSpentCents` on cost events
6. Shared validators/constants for follow-up issuance plugin (no issuance API in this PR)

**Alternatives considered**

- **Overload `principal_permission_grants`** — rejected: unique index and same-company membership semantics do not fit foreign agents
- **Plugin-only boundary bypass** — rejected: `authorization.ts:1061` short-circuits before plugins; core hook is mandatory (#955 safety)
- **Instance-admin board key per target company** — rejected: over-broad (#5015 class of problem)
- **Cross-instance federation** — out of scope (#1084)

**Roadmap alignment**

`ROADMAP.md` does not list cross-company grants explicitly. This PR is **flag-off by default** and positions issuance as a **plugin** follow-up per CONTRIBUTING guidance. Happy to align in Discord `#dev` before merge if maintainers prefer a different split.

## What Changed

### Database (`packages/db`)

- Add `cross_company_grants` schema (`packages/db/src/schema/cross_company_grants.ts`)
- Add migration `0101_cross_company_grants.sql` + journal entry
- Columns: `targetCompanyId`, `granteeAgentId`, `granteeHomeCompanyId`, `actions` (jsonb), `scope`, `budgetCapCents`, `budgetSpentCents`, `status`, `expiresAt`, `approvalId`, issuer fields, optional `signature`/`signingPublicKey` (for follow-up plugin)
- Indexes: unique `(targetCompanyId, granteeAgentId)`; lookup `(granteeAgentId, targetCompanyId, status)`

### Shared (`packages/shared`)

- `CROSS_COMPANY_GRANT_STATUSES`, `CROSS_COMPANY_ELIGIBLE_ACTIONS`, `CROSS_COMPANY_GRANT_MAX_TTL_HOURS`
- Validators: `requestCrossCompanyGrantSchema`, `issueCrossCompanyGrantSchema` (issuance plugin prep; not wired to routes yet)

### Server — authorization core

- New `server/src/services/cross-company-grants.ts`: `crossCompanyGrantsEnabled()`, `findActiveCrossCompanyGrant()`, `scopeMatches()`, `incrementBudgetSpent()`
- `authorization.ts` agent cross-company branch: new reasons `allow_cross_company_grant`, `deny_budget_exceeded`
- `authz.ts`: `assertCompanyAccess` → async; optional `db` for coarse CCG pass
- All route call sites updated: `await assertCompanyAccess(req, companyId, db)`

### Server — budget

- `costs.ts`: allow cost events when foreign agent has active CCG; increment grant `budgetSpentCents`

### Tests

- New `server/src/__tests__/cross-company-grants.test.ts` (flag on/off, allow/deny action, budget exceeded, expiry)
- Updated `server/src/__tests__/authz-company-access.test.ts` for async `assertCompanyAccess`

### Explicitly NOT in this PR (follow-up)

- `paperclip-plugin-crosscompany` (request / approve / list / revoke)
- Agent-accessible plugin action routes (`assertBoardOrgAccess` → agent path; see #1177 / harperaa comment)
- Ed25519 signing on issuance
- Dual-company `logActivity` lifecycle events
- UI for grant management
- RFC consolidating threads

## Verification

### Commands run locally (all green)

```bash
pnpm --filter @paperclipai/db typecheck
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/server typecheck

pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/authorization-service.test.ts \
  src/__tests__/cross-company-grants.test.ts \
  src/__tests__/authz-company-access.test.ts
```

Result: **11 tests passed** (authorization-service + cross-company-grants + authz-company-access).

### Manual verification plan (post-merge / for reviewers)

**Prerequisite:** migrate DB (`pnpm --filter @paperclipai/db migrate` or your instance migration path).

1. **Flag-off parity (regression #955)**
   - Unset `PAPERCLIP_CROSS_COMPANY_GRANTS`
   - Agent key for company A calls any company B endpoint → `403` / `deny_company_boundary` (unchanged)

2. **Flag-on, no grant**
   - `PAPERCLIP_CROSS_COMPANY_GRANTS=enabled`
   - Same cross-company request → still denied (no grant row)

3. **Flag-on, active grant (DB seed for v1 — no issuance API yet)**
   ```sql
   INSERT INTO cross_company_grants (
     target_company_id, grantee_agent_id, grantee_home_company_id,
     actions, status, expires_at
   ) VALUES (
     '<target-company-uuid>',
     '<foreign-agent-uuid>',
     '<home-company-uuid>',
     '["issue:read","project:read"]',
     'active',
     now() + interval '72 hours'
   );
   ```
   - Foreign agent reads issues/projects in target company → allowed via `allow_cross_company_grant`
   - Foreign agent calls `secrets:read` or unlisted action → denied

4. **Revocation / expiry**
   - Set `status = 'revoked'` or `expires_at < now()` → next request denied immediately (live row read, no cached decisions)

5. **Budget**
   - Grant with `budget_cap_cents = 100`, `budget_spent_cents = 100` → `deny_budget_exceeded`
   - Cost event with active grant increments `budget_spent_cents`

### UI screenshots

N/A — no UI changes in this PR.

## Risks

| Risk | Mitigation |
|------|------------|
| Default boundary regression | Flag off ⇒ no grant DB lookup in deny path for cross-company without grant; existing auth suite passes |
| Dual-gate bypass | `assertCompanyAccess` only coarse-passes when active grant exists; action/scope/budget enforced in `authorization.decide()` |
| Routes with only `assertCompanyAccess` (no `decide`) | Sensitive routes (`secrets.ts`) also require `assertBoard`; agent cannot reach secrets. Follow-up: extend tenant-leak tests (#709 pattern) |
| Large route diff (async `assertCompanyAccess`) | Mechanical change; typecheck + existing route tests cover regressions |
| Migration meta collision upstream | `drizzle-kit generate` fails on snapshot parent collision; migration `0101` hand-authored to match schema — reviewers please sanity-check SQL |
| Unique index blocks re-request while revoked row exists | v1 intentional (one row per agent→target pair); v2 may drop to non-unique |
| Issuance not in this PR | Grants must be seeded manually or via follow-up plugin; no self-issue path exposed |

**Migration safety:** Additive only — new table, no backfill, no destructive change. Safe to deploy with flag off.

## Model Used

**Cursor Composer** (AI coding agent in Cursor IDE), assisted implementation and PR authoring.

- Provider: Cursor
- Model family: Composer (agentic code generation with tool use — file read/write, terminal, codebase search)
- Human direction: PRD spec, architectural decisions (core-only scope, extend `assertCompanyAccess`, `PAPERCLIP_CROSS_COMPANY_GRANTS` flag naming, v1 action allowlist including `issue:mutate`)
- Review status: human will push branch and open PR; Greptile/reviewer feedback to be addressed post-submit

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work (no explicit roadmap entry; flag-off infra)
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes: #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots (N/A)
- [ ] I have updated relevant documentation to reflect my changes (validators/constants only; follow-up RFC doc planned with plugin PR)
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green (pending push + CI)
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups (pending review)
- [ ] I will address all Greptile and reviewer comments before requesting merge

---

## Maintainer notes

This is intentionally **Path 2** scope per [CONTRIBUTING.md](../../CONTRIBUTING.md). If the team prefers Discord `#dev` alignment before review, happy to join that thread. The PR is split so this core lands **disabled by default**; the issuance plugin can be reviewed separately.

**Follow-up PR (planned):** `paperclip-plugin-crosscompany` — `request-grant` via target-company approval, `approval.decided` activation, list/revoke, Ed25519 signing, dual-company audit logging.
