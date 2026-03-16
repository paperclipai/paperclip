# Humans and Permissions Implementation (V1)

Status: Draft
Date: 2026-02-21
Owners: Server + UI + CLI + DB + Shared
Companion plan: `doc/plan/humans-and-permissions.md`

## 1. Document role

This document is the engineering implementation contract for the humans-and-permissions plan.
It translates product decisions into concrete schema, API, middleware, UI, CLI, and test work.

If this document conflicts with prior exploratory notes, this document wins for V1 execution.

## 2. Locked V1 decisions

1. Two deployment modes remain:
- `local_trusted`
- `cloud_hosted`

2. `local_trusted`:
- no login UX
- implicit local instance admin actor
- loopback-only server binding
- full admin/settings/invite/approval capabilities available locally

3. `cloud_hosted`:
- Better Auth for humans
- email/password only
- no email verification requirement in V1

4. Permissions:
- one shared authorization system for humans and agents
- normalized grants table (`principal_permission_grants`)
- no separate “agent permissions engine”

5. Invites:
- copy-link only (no outbound email sending in V1)
- unified `company_join` link that supports human or agent path
- acceptance creates `pending_approval` join request
- no access until admin approval

6. Join review metadata:
- source IP required
- no GeoIP/country lookup in V1

7. Agent API keys:
- indefinite by default
- hash at rest
- display once on claim
- revoke/regenerate supported

8. Local ingress:
- public/untrusted ingress is out of scope for V1
- no `--dangerous-agent-ingress` in V1

## 3. Current baseline and delta

Current baseline (repo as of this doc):

- server actor model defaults to `board` in `server/src/middleware/auth.ts`
- authorization is mostly `assertBoard` + company check in `server/src/routes/authz.ts`
- no human auth/session tables in local schema
- no principal membership or grants tables
- no invite or join-request lifecycle

Required delta:

- move from board-vs-agent authz to principal-based authz
- add Better Auth integration in cloud mode
- add membership/grants/invite/join-request persistence
- add approval inbox signals and actions
- preserve local no-login UX without weakening cloud security

## 4. Architecture

## 4.1 Deployment mode contract

Add explicit runtime mode:

- `deployment.mode = local_trusted | cloud_hosted`

Config behavior:

- mode stored in config file (`packages/shared/src/config-schema.ts`)
- loaded in server config (`server/src/config.ts`)
- surfaced in `/api/health`

Startup guardrails:

- `local_trusted`: fail startup if bind host is not loopback
- `cloud_hosted`: fail startup if Better Auth is not configured

## 4.2 Actor model

Replace implicit “board” semantics with explicit actors:

- `user` (session-authenticated human)
- `agent` (bearer API key)
- `local_implicit_admin` (local_trusted only)

Implementation note:

- keep `req.actor` shape backward-compatible during migration by introducing a normalizer helper
- remove hard-coded `"board"` checks route-by-route after new authz helpers are in place

## 4.3 Authorization model

Authorization input tuple:

- `(company_id, principal_type, principal_id, permission_key, scope_payload)`

Principal types:

- `user`
- `agent`

Role layers:

- `instance_admin` (instance-wide)
- company-scoped grants via `principal_permission_grants`

Evaluation order:

1. resolve principal from actor
2. resolve instance role (`instance_admin` short-circuit for admin-only actions)
3. resolve company membership (`active` required for company access)
4. resolve grant + scope for requested action

## 5. Data model

## 5.1 Better Auth tables

Managed by Better Auth adapter/migrations (expected minimum):

- `user`
- `session`
- `account`
- `verification`

Note:

- use Better Auth canonical table names/types to avoid custom forks

## 5.2 New Paperclip tables

1. `instance_user_roles`

- `id` uuid pk
- `user_id` text not null
- `role` text not null (`instance_admin`)
- `created_at`, `updated_at`
- unique index: `(user_id, role)`

2. `company_memberships`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `principal_type` text not null (`user | agent`)
- `principal_id` text not null
- `status` text not null (`pending | active | suspended`)
- `membership_role` text null
- `created_at`, `updated_at`
- unique index: `(company_id, principal_type, principal_id)`
- index: `(principal_type, principal_id, status)`

3. `principal_permission_grants`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `principal_type` text not null (`user | agent`)
- `principal_id` text not null
- `permission_key` text not null
- `scope` jsonb null
- `granted_by_user_id` text null
- `created_at`, `updated_at`
- unique index: `(company_id, principal_type, principal_id, permission_key)`
- index: `(company_id, permission_key)`

4. `invites`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `invite_type` text not null (`company_join | bootstrap_ceo`)
- `token_hash` text not null
- `allowed_join_types` text not null (`human | agent | both`) for `company_join`
- `defaults_payload` jsonb null
- `expires_at` timestamptz not null
- `invited_by_user_id` text null
- `revoked_at` timestamptz null
- `accepted_at` timestamptz null
- `created_at` timestamptz not null default now()
- unique index: `(token_hash)`
- index: `(company_id, invite_type, revoked_at, expires_at)`

5. `join_requests`

- `id` uuid pk
- `invite_id` uuid fk `invites.id` not null
- `company_id` uuid fk `companies.id` not null
- `request_type` text not null (`human | agent`)
- `status` text not null (`pending_approval | approved | rejected`)
- `request_ip` text not null
- `requesting_user_id` text null
- `request_email_snapshot` text null
- `agent_name` text null
- `adapter_type` text null
- `capabilities` text null
- `agent_defaults_payload` jsonb null
- `created_agent_id` uuid fk `agents.id` null
- `approved_by_user_id` text null
- `approved_at` timestamptz null
- `rejected_by_user_id` text null
- `rejected_at` timestamptz null
- `created_at`, `updated_at`
- index: `(company_id, status, request_type, created_at desc)`
- unique index: `(invite_id)` to enforce one request per consumed invite

## 5.3 Existing table changes

1. `issues`

- add `assignee_user_id` text null
- enforce single-assignee invariant:
  - at most one of `assignee_agent_id` and `assignee_user_id` is non-null

2. `agents`

- keep existing `permissions` JSON for transition only
- mark as deprecated in code path once principal grants are live

## 5.4 Migration strategy

Migration ordering:

1. add new tables/columns/indexes
2. backfill minimum memberships/grants for existing data:
- create local implicit admin membership context in local mode at runtime (not persisted as Better Auth user)
- for cloud, bootstrap creates first admin user role on acceptance
3. switch authz reads to new tables
4. remove legacy board-only checks

## 6. API contract (new/changed)

All under `/api`.

## 6.1 Health

`GET /api/health` response additions:

- `deploymentMode`
- `authReady`
- `bootstrapStatus` (`ready | bootstrap_pending`)

## 6.2 Invites

1. `POST /api/companies/:companyId/invites`
- create `company_join` invite
- copy-link value returned once

2. `GET /api/invites/:token`
- validate token
- return invite landing payload
- includes `allowedJoinTypes`

3. `POST /api/invites/:token/accept`
- body:
  - `requestType: human | agent`
  - human path: no extra payload beyond authenticated user
  - agent path: `agentName`, `adapterType`, `capabilities`, optional adapter defaults
- consumes invite token
- creates `join_requests(status=pending_approval)`

4. `POST /api/invites/:inviteId/revoke`
- revokes non-consumed invite

## 6.3 Join requests

1. `GET /api/companies/:companyId/join-requests?status=pending_approval&requestType=...`

2. `POST /api/companies/:companyId/join-requests/:requestId/approve`
- human:
  - create/activate `company_memberships`
  - apply default grants
- agent:
  - create `agents` row
  - create pending claim context for API key
  - create/activate agent membership
  - apply default grants

3. `POST /api/companies/:companyId/join-requests/:requestId/reject`

4. `POST /api/join-requests/:requestId/claim-api-key`
- approved agent request only
- returns plaintext key once
- stores hash in `agent_api_keys`

## 6.4 Membership and grants

1. `GET /api/companies/:companyId/members`
- returns both principal types

2. `PATCH /api/companies/:companyId/members/:memberId/permissions`
- upsert/remove grants

3. `PUT /api/admin/users/:userId/company-access`
- instance admin only

4. `GET /api/admin/users/:userId/company-access`

5. `POST /api/admin/users/:userId/promote-instance-admin`

6. `POST /api/admin/users/:userId/demote-instance-admin`

## 6.5 Inbox

`GET /api/companies/:companyId/inbox` additions:

- pending join request alert items when actor can `joins:approve`
- each item includes inline action metadata:
  - join request id
  - request type
  - source IP
  - human email snapshot when applicable

## 7. Server implementation details

## 7.1 Config and startup

Files:

- `packages/shared/src/config-schema.ts`
- `server/src/config.ts`
- `server/src/index.ts`
- `server/src/startup-banner.ts`

Changes:

- add deployment mode + bind host settings
- enforce loopback-only for `local_trusted`
- enforce Better Auth readiness in `cloud_hosted`
- banner shows mode and bootstrap status

## 7.2 Better Auth integration

Files:

- `server/package.json` (dependency)
- `server/src/auth/*` (new)
- `server/src/app.ts` (mount auth handler endpoints + session middleware)

Changes:

- add Better Auth server instance
- cookie/session handling for cloud mode
- no-op session auth in local mode

## 7.3 Actor middleware

Files:

- `server/src/middleware/auth.ts`
- `server/src/routes/authz.ts`
- `server/src/middleware/board-mutation-guard.ts`

Changes:

- stop defaulting every request to board in cloud mode
- map local requests to `local_implicit_admin` actor in local mode
- map Better Auth session to `user` actor in cloud mode
- preserve agent bearer path
- replace `assertBoard` with permission-oriented helpers:
  - `requireInstanceAdmin(req)`
  - `requireCompanyAccess(req, companyId)`
  - `requireCompanyPermission(req, companyId, permissionKey, scope?)`

## 7.4 Authorization services

Files:

- `server/src/services` (new modules)
  - `memberships.ts`
  - `permissions.ts`
  - `invites.ts`
  - `join-requests.ts`
  - `instance-admin.ts`

Changes:

- centralized permission evaluation
- centralized membership resolution
- one place for principal-type branching

## 7.5 Routes

Files:

- `server/src/routes/index.ts` and new route modules:
  - `auth.ts` (if needed)
  - `invites.ts`
  - `join-requests.ts`
  - `members.ts`
  - `instance-admin.ts`
  - `inbox.ts` (or extension of existing inbox source)

Changes:

- add new endpoints listed above
- apply company and permission checks consistently
- log all mutations through activity log service

## 7.6 Activity log and audit

Files:

- `server/src/services/activity-log.ts`
- call sites in invite/join/member/admin routes

Required actions:

- `invite.created`
- `invite.revoked`
- `join.requested`
- `join.approved`
- `join.rejected`
- `membership.activated`
- `permission.granted`
- `permission.revoked`
- `instance_admin.promoted`
- `instance_admin.demoted`
- `agent_api_key.claimed`
- `agent_api_key.revoked`

## 7.7 Real-time and inbox propagation

Files:

- `server/src/services/live-events.ts`
- `server/src/realtime/live-events-ws.ts`
- inbox data source endpoint(s)

Changes:

- emit join-request events
- ensure inbox refresh path includes join alerts

## 8. CLI implementation

Files:

- `cli/src/index.ts`
- `cli/src/commands/onboard.ts`
- `cli/src/commands/configure.ts`
- `cli/src/prompts/server.ts`

Commands:

1. `paperclipai auth bootstrap-ceo`
- create bootstrap invite
- print one-time URL

2. `paperclipai onboard`
- in cloud mode with `bootstrap_pending`, print bootstrap URL and next steps
- in local mode, skip bootstrap requirement

Config additions:

- deployment mode
- bind host (validated against mode)

## 9. UI implementation

Files:

- routing: `ui/src/App.tsx`
- API clients: `ui/src/api/*`
- pages/components (new):
  - `AuthLogin` / `AuthSignup` (cloud mode)
  - `BootstrapPending` page
  - `InviteLanding` page
  - `InstanceSettings` page
  - join approval components in `Inbox`
  - member/grant management in company settings

Required UX:

1. Cloud unauthenticated user:
- redirect to login/signup

2. Cloud bootstrap pending:
- block app with setup command guidance

3. Invite landing:
- choose human vs agent path (respect `allowedJoinTypes`)
- submit join request
- show pending approval confirmation

4. Inbox:
- show join approval cards with approve/reject actions
- include source IP and human email snapshot when applicable

5. Local mode:
- no login prompts
- full settings/invite/approval UI available

## 10. Security controls

1. Token handling

- invite tokens hashed at rest
- API keys hashed at rest
- one-time plaintext key reveal only

2. Local mode isolation

- loopback bind enforcement
- startup hard-fail on non-loopback host

3. Cloud auth

- no implicit board fallback
- session auth mandatory for human mutations

4. Join workflow hardening

- one request per invite token
- pending request has no data access
- approval required before membership activation

5. Abuse controls

- rate limit invite accept and key claim endpoints
- structured logging for join and claim failures

## 11. Migration and compatibility

## 11.1 Runtime compatibility

- keep existing board-dependent routes functional while migrating authz helper usage
- phase out `assertBoard` calls only after permission helpers cover all routes

## 11.2 Data compatibility

- do not delete `agents.permissions` in V1
- stop reading it once grants are wired
- remove in post-V1 cleanup migration

## 11.3 Better Auth user ID handling

- treat `user.id` as text end-to-end
- existing `created_by_user_id` and similar text fields remain valid

## 12. Testing strategy

## 12.1 Unit tests

- permission evaluator:
  - instance admin bypass
  - grant checks
  - scope checks
- join approval state machine
- invite token lifecycle

## 12.2 Integration tests

- cloud mode unauthenticated mutation -> `401`
- local mode implicit admin mutation -> success
- invite accept -> pending join -> no access
- join approve (human) -> membership/grants active
- join approve (agent) -> key claim once
- cross-company access denied for user and agent principals
- local mode non-loopback bind -> startup failure

## 12.3 UI tests

- login gate in cloud mode
- bootstrap pending screen
- invite landing choose-path UX
- inbox join alert approve/reject flows

## 12.4 Regression tests

- existing agent API key flows still work
- task assignment and checkout invariants unchanged
- activity logging still emitted for all mutations

## 13. Delivery plan

## Phase A: Foundations

- config mode/bind host support
- startup guardrails
- Better Auth integration skeleton
- actor type expansion

## Phase B: Schema and authz core

- add membership/grants/invite/join tables
- add permission service and helpers
- wire company/member/instance admin checks

## Phase C: Invite + join backend

- invite create/revoke
- invite accept -> pending request
- approve/reject + key claim
- activity log + live events

## Phase D: UI + CLI

- cloud login/bootstrap screens
- invite landing
- inbox join approval actions
- instance settings and member permissions
- bootstrap CLI command and onboarding updates

## Phase E: Hardening

- full integration/e2e coverage
- docs updates (`SPEC-implementation`, `DEVELOPING`, `CLI`)
- cleanup of legacy board-only codepaths

## 14. Verification gate

Before handoff:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If any command is skipped, record exactly what was skipped and why.

## 15. Done criteria

1. Behavior matches locked V1 decisions in this doc and `doc/plan/humans-and-permissions.md`.
2. Cloud mode requires auth; local mode has no login UX.
3. Unified invite + pending approval flow works for both humans and agents.
4. Shared principal membership + permission system is live for users and agents.
5. Local mode remains loopback-only and fails otherwise.
6. Inbox shows actionable join approvals.
7. All new mutating paths are activity-logged.
