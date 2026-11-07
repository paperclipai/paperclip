# Auth and onboarding validation matrix

This document is the **canonical** map from deployment mode + actor + surface to **expected behavior** (fail closed) and **evidence** in code or tests.

**Handoff note:** An external handoff packet `paperclips/handoffs/2026-03-19-auth-onboarding-validation-matrix.md` was not present in this repository clone, and fetching additional remotes was not possible in this environment. This matrix was derived from the current codebase (`server/src/middleware/auth.ts`, `server/src/routes/authz.ts`, `server/src/routes/access.ts`, CLI bootstrap, UI and tests). If upstream adds that handoff file, link it here as supplementary context.

## Deployment modes (product intent)

| Mode | Board identity without browser session | Typical use |
|------|----------------------------------------|-------------|
| `local_trusted` | Every request is treated as the **implicit local board** (`userId: local-board`, `source: local_implicit`, `isInstanceAdmin: true`). No login UI required. | Single-operator local machine; **not** a failure to deny HTTP “anonymous” access to the API—there is no separate anonymous principal. |
| `authenticated` | Without `Authorization: Bearer …` or a valid session cookie, `req.actor.type` stays **`none`** until resolved. | Login-required deployments; unauthenticated callers should get **401** on protected routes. |

**Fail closed:** In `authenticated` mode, missing or invalid credentials do not silently grant board or agent access. In `local_trusted`, the implicit board is **explicit** in code (see [`server/src/middleware/auth.ts`](../server/src/middleware/auth.ts)); there is no hidden upgrade to a different company.

## Actor resolution order (`authenticated` mode)

For each request, [`actorMiddleware`](../server/src/middleware/auth.ts):

1. Initializes actor: `local_trusted` → board implicit; `authenticated` → `none`.
2. If **no** `Authorization: Bearer` header: tries **Better Auth session** → board with `companyIds` from memberships and `isInstanceAdmin` from `instance_user_roles`.
3. If Bearer present: resolves **board API key** → board with resolved company access; else **agent API key** (hash) → agent; else **agent JWT** (`verifyLocalAgentJwt`) with DB check that the agent exists, matches `company_id` claim, and is not `terminated` / `pending_approval`.

Invalid JWT, wrong company vs agent row, terminated agent: actor remains **`none`** (JWT path) or stays unset → **`none`** for protected resources.

## Company scoping ([`assertCompanyAccess`](../server/src/routes/authz.ts))

| `req.actor` | `companyId` in route | Result |
|-------------|----------------------|--------|
| `none` | any | **401** `Unauthorized` |
| `agent`, `companyId` mismatch | target company | **403** `Agent key cannot access another company` |
| `board`, `source` not `local_implicit`, not instance admin | target not in `companyIds` | **403** `User does not have access to this company` |
| `board`, `local_implicit` or instance admin | any company | Allowed (still subject to route-specific rules) |
| `board`, session, membership includes company | that company | Allowed |

Instance admins (`isInstanceAdmin`) are not restricted by the `companyIds` list for `assertCompanyAccess` (see implementation).

## Matrix: Board access

| # | Scenario | Mode | Expectation | Evidence |
|---|----------|------|-------------|----------|
| B1 | No `Authorization`, no session cookie | `authenticated` | `actor.type === none` for API; protected routes using `assertBoard` / `assertCompanyAccess` → **401** | [`auth.ts`](../server/src/middleware/auth.ts), [`activity-routes.test.ts`](../server/src/__tests__/activity-routes.test.ts) (heartbeat run issues) |
| B2 | Valid session cookie | `authenticated` | `actor.type === board`, `companyIds` populated | [`auth.ts`](../server/src/middleware/auth.ts) |
| B3 | Bearer board API key | either | `actor.type === board`, access from `boardAuth.resolveBoardAccess` | [`auth.ts`](../server/src/middleware/auth.ts) |
| B4 | No credentials | `local_trusted` | **Implicit board** (not `none`) | [`auth.ts`](../server/src/middleware/auth.ts) |
| B5 | Session board mutates (POST/PATCH/DELETE) from untrusted origin | `authenticated` | **403** `Board mutation requires trusted browser origin` | [`board-mutation-guard.ts`](../server/src/middleware/board-mutation-guard.ts) |
| B6 | Create company | either | `assertBoard` + instance admin (non–local-trusted) | [`companies.ts`](../server/src/routes/companies.ts) |

## Matrix: Agent access (API key and run JWT)

| # | Scenario | Expectation | Evidence |
|---|----------|-------------|----------|
| A1 | Valid agent API key | `actor.type === agent`, `companyId` from key | [`auth.ts`](../server/src/middleware/auth.ts) |
| A2 | Valid run JWT; JWT `company_id` ≠ agent row `companyId` | Actor not set as agent (stays `none`) | [`auth.ts`](../server/src/middleware/auth.ts) |
| A3 | Agent token, resource in **another** company | **403** via `assertCompanyAccess` | [`authz.ts`](../server/src/routes/authz.ts), [`auth-onboarding-validation-matrix.test.ts`](../server/src/__tests__/auth-onboarding-validation-matrix.test.ts) |
| A4 | JWT claims: `sub`, `company_id`, `run_id` binding | Documented + unit tests | [`agent-auth-jwt.ts`](../server/src/agent-auth-jwt.ts), [`agent-auth-jwt.test.ts`](../server/src/__tests__/agent-auth-jwt.test.ts) |

## Matrix: Bootstrap CEO invite

| # | Step | Expectation | Evidence |
|---|------|-------------|----------|
| S1 | CLI creates bootstrap invite | Only when `deploymentMode === authenticated`; revokes prior active bootstrap invites (unless `--force`); inserts `inviteType: bootstrap_ceo`, `invitedByUserId: system` | [`cli/src/commands/auth-bootstrap-ceo.ts`](../cli/src/commands/auth-bootstrap-ceo.ts) |
| S2 | Health endpoint exposes bootstrap state | `bootstrapStatus`, `bootstrapInviteActive` when no instance admin | [`health.ts`](../server/src/routes/health.ts) |
| S3 | Accept bootstrap invite | `inviteType === bootstrap_ceo` requires **human** `requestType`, **authenticated** board user (`req.actor.type === board` with user or local implicit), promotes instance admin, marks accepted | [`access.ts`](../server/src/routes/access.ts) (`POST /invites/:token/accept`) |
| S4 | UI gate while bootstrap pending | `CloudAccessGate` in [`ui/src/App.tsx`](../ui/src/App.tsx) uses `/api/health` | — |

## Matrix: Company join invites and onboarding

| # | Surface | Expectation | Evidence |
|---|---------|-------------|----------|
| I1 | `GET /api/invites/:token` (summary) | Unauthenticated access to token metadata as designed for landing | [`access.ts`](../server/src/routes/access.ts) |
| I2 | `GET …/onboarding.txt` | Plain-text onboarding handoff with registration and claim URLs | [`invite-onboarding-text.test.ts`](../server/src/__tests__/invite-onboarding-text.test.ts), [`access.ts`](../server/src/routes/access.ts) |
| I3 | `POST …/accept` | Validates invite, creates join request / acceptance paths per `inviteType` | [`invite-accept-replay.test.ts`](../server/src/__tests__/invite-accept-replay.test.ts), [`invite-join-grants.test.ts`](../server/src/__tests__/invite-join-grants.test.ts) |
| I4 | Agent join grants | Defaults include `tasks:assign` | [`invite-join-grants.test.ts`](../server/src/__tests__/invite-join-grants.test.ts) |

## Matrix: End-to-end / smoke (optional CI)

| Suite | Scope |
|-------|--------|
| [`tests/release-smoke/docker-auth-onboarding.spec.ts`](../tests/release-smoke/docker-auth-onboarding.spec.ts) | Authenticated Docker onboarding flow (Playwright) |

## Maintenance

When changing auth or onboarding:

1. Update this matrix or the linked tests in the same PR.
2. Run `pnpm --filter @paperclipai/server exec vitest run src/__tests__/auth-onboarding-validation-matrix.test.ts` plus affected route tests.
