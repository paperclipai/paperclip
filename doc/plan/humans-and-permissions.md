# Humans and Permissions Plan

Status: Draft
Date: 2026-02-21
Owner: Server + UI + Shared + DB

## Goal

Add first-class human users and permissions while preserving two deployment modes:

- local trusted single-user mode with no login friction
- cloud-hosted multi-user mode with mandatory authentication and authorization

## Why this plan

Current V1 assumptions are centered on one board operator. We now need:

- multi-human collaboration with per-user permissions
- safe cloud deployment defaults (no accidental loginless production)
- local mode that still feels instant (`npx paperclipai run` and go)
- agent-to-human task delegation, including a human inbox
- one user account with access to multiple companies in one deployment
- instance admins who can manage company access across the instance
- join approvals surfaced as actionable inbox alerts, not buried in admin-only pages
- a symmetric invite-and-approve onboarding path for both humans and agents
- one shared membership and permission model for both humans and agents

## Product constraints

1. Keep company scoping strict for every new table, endpoint, and permission check.
2. Preserve existing control-plane invariants:

- single-assignee task model
- approval gates
- budget hard-stop behavior
- mutation activity logging

3. Keep local mode easy and trusted, but prevent unsafe cloud posture.

## Deployment modes

## Mode A: `local_trusted`

Behavior:

- no login UI
- browser opens directly into board context
- embedded DB and local storage defaults remain
- a local implicit human actor exists for attribution
- local implicit actor has effective `instance_admin` authority for that instance
- full invite/approval/permission settings flows remain available in local mode (including agent enrollment)

Guardrails:

- server binds to loopback by default
- fail startup if mode is `local_trusted` with non-loopback bind
- UI shows a persistent "Local trusted mode" badge

## Mode B: `cloud_hosted`

Behavior:

- login required for all human endpoints
- Better Auth for human auth
- initial auth method: email + password
- email verification is not required for initial release
- hosted DB and remote deployment supported
- multi-user sessions and role/permission enforcement

Guardrails:

- fail startup if auth provider/session config is missing
- fail startup if insecure auth bypass flag is set
- health payload includes mode and auth readiness

## Authentication choice

- use Better Auth for human users
- start with email/password login only
- no email confirmation requirement in V1
- keep implementation structured so social/SSO providers can be added later without changing membership/permission semantics

## Auth and actor model

Unify request actors into a single model:

- `user` (authenticated human)
- `agent` (API key)
- `local_board_implicit` (local trusted mode only)

Rules:

- in `cloud_hosted`, only `user` and `agent` are valid actors
- in `local_trusted`, unauthenticated browser/API requests resolve to `local_board_implicit`
- `local_board_implicit` is authorized as an instance admin principal for local operations
- all mutating actions continue writing `activity_log` with actor type/id

## First admin bootstrap

Problem:

- new cloud deployments need a safe, explicit first human admin path
- app cannot assume a pre-existing admin account
- `local_trusted` does not use bootstrap flow because implicit local instance admin already exists

Bootstrap flow:

1. If no `instance_admin` user exists for the deployment, instance is in `bootstrap_pending` state.
2. CLI command `pnpm paperclipai auth bootstrap-ceo` creates a one-time CEO onboarding invite URL for that instance.
3. `pnpm paperclipai onboard` runs this bootstrap check and prints the invite URL automatically when `bootstrap_pending`.
4. Visiting the app while `bootstrap_pending` shows a blocking setup page with the exact CLI command to run (`pnpm paperclipai onboard`).
5. Accepting that CEO invite creates the first admin user and exits bootstrap mode.

Security rules:

- bootstrap invite is single-use, short-lived, and token-hash stored at rest
- only one active bootstrap invite at a time per instance (regeneration revokes prior token)
- bootstrap actions are audited in `activity_log`

## Data model additions

## New tables

1. `users`

- identity record for human users (email-based)
- optional instance-level role field (or companion table) for admin rights

2. `company_memberships`

- `company_id`, `principal_type` (`user | agent`), `principal_id`
- status (`pending | active | suspended`), role metadata
- stores effective access state for both humans and agents
- many-to-many: one principal can belong to multiple companies

3. `invites`

- `company_id`, `invite_type` (`company_join | bootstrap_ceo`), token hash, expires_at, invited_by, revoked_at, accepted_at
- one-time share link (no pre-bound invite email)
- `allowed_join_types` (`human | agent | both`) for `company_join` links
- optional defaults payload keyed by join type:
  - human defaults: initial permissions/membership role
  - agent defaults: proposed role/title/adapter defaults

4. `principal_permission_grants`

- `company_id`, `principal_type` (`user | agent`), `principal_id`, `permission_key`
- explicit grants such as `agents:create`
- includes scope payload for chain-of-command limits
- normalized table (not JSON blob) for auditable grant/revoke history

5. `join_requests`

- `invite_id`, `company_id`, `request_type` (`human | agent`)
- `status` (`pending_approval | approved | rejected`)
- common review metadata:
  - `request_ip`
  - `approved_by_user_id`, `approved_at`, `rejected_by_user_id`, `rejected_at`
- human request fields:
  - `requesting_user_id`, `request_email_snapshot`
- agent request fields:
  - `agent_name`, `adapter_type`, `capabilities`, `created_agent_id` nullable until approved
- each consumed invite creates exactly one join request record after join type is selected

6. `issues` extension

- add `assignee_user_id` nullable
- preserve single-assignee invariant with XOR check:
  - exactly zero or one of `assignee_agent_id` / `assignee_user_id`

## Compatibility

- existing `created_by_user_id` / `author_user_id` fields remain and become fully active
- agent API keys remain auth credentials; membership + grants remain authorization source

## Permission model (initial set)

Principle:

- humans and agents use the same membership + grant evaluation engine
- permission checks resolve against `(company_id, principal_type, principal_id)` for both actor types
- this avoids separate authz codepaths and keeps behavior consistent

Role layers:

- `instance_admin`: deployment-wide admin, can access/manage all companies and user-company access mapping
- `company_member`: company-scoped permissions only

Core grants:

1. `agents:create`
2. `users:invite`
3. `users:manage_permissions`
4. `tasks:assign`
5. `tasks:assign_scope` (org-constrained delegation)
6. `joins:approve` (approve/reject human and agent join requests)

Additional behavioral rules:

- instance admins can promote/demote instance admins and manage user access across companies
- board-level users can manage company grants inside companies they control
- non-admin principals can only act within explicit grants
- assignment checks apply to both agent and human assignees

## Chain-of-command scope design

Initial approach:

- represent assignment scope as an allow rule over org hierarchy
- examples:
  - `subtree:<agentId>` (can assign into that manager subtree)
  - `exclude:<agentId>` (cannot assign to protected roles, e.g., CEO)

Enforcement:

- resolve target assignee org position
- evaluate allow/deny scope rules before assignment mutation
- return `403` for out-of-scope assignments

## Invite and signup flow

1. Authorized user creates one `company_join` invite share link with optional defaults + expiry.
2. System sends invite URL containing one-time token.
3. Invite landing page presents two paths: `Join as human` or `Join as agent` (subject to `allowed_join_types`).
4. Requester selects join path and submits required data.
5. Submission consumes token and creates a `pending_approval` join request (no access yet).
6. Join request captures review metadata:

- human: authenticated email
- both: source IP
- agent: proposed agent metadata

7. Company admin/instance admin reviews request and approves or rejects.
8. On approval:

- human: activate `company_membership` and apply permission grants
- agent: create agent record and enable API-key claim flow

9. Link is one-time and cannot be reused.
10. Inviter/admin can revoke invite before acceptance.

Security rules:

- store invite token hashed at rest
- one-time use token with short expiry
- all invite lifecycle events logged in `activity_log`
- pending users cannot read or mutate any company data until approved

## Join approval inbox

- join requests generate inbox alerts for eligible approvers (`joins:approve` or admin role)
- alerts appear in both:
  - global/company inbox feed
  - dedicated pending-approvals UI
- each alert includes approve/reject actions inline (no context switch required)
- alert payload must include:
  - requester email when `request_type=human`
  - source IP
  - request type (`human | agent`)

## Human inbox and agent-to-human delegation

Behavior:

- agents can assign tasks to humans when policy permits
- humans see assigned tasks in inbox view (including in local trusted mode)
- comment and status transitions follow same issue lifecycle guards

## Agent join path (via unified invite link)

1. Authorized user shares one `company_join` invite link (with `allowed_join_types` including `agent`).
2. Agent operator opens link, chooses `Join as agent`, and submits join payload (name/role/adapter metadata).
3. System creates `pending_approval` agent join request and captures source IP.
4. Approver sees alert in inbox and approves or rejects.
5. On approval, server creates the agent record and mints a long-lived API key.
6. API key is shown exactly once via secure claim flow with explicit "save now" instruction.

Long-lived token policy:

- default to long-lived revocable API keys (hash stored at rest)
- show plaintext key once only
- support immediate revoke/regenerate from admin UI
- optionally add expirations/rotation policy later without changing join flow

API additions (proposed):

- `GET /companies/:companyId/inbox` (human actor scoped to self; includes task items + pending join approval alerts when authorized)
- `POST /companies/:companyId/issues/:issueId/assign-user`
- `POST /companies/:companyId/invites`
- `GET /invites/:token` (invite landing payload with `allowed_join_types`)
- `POST /invites/:token/accept` (body includes `requestType=human|agent` and request metadata)
- `POST /invites/:inviteId/revoke`
- `GET /companies/:companyId/join-requests?status=pending_approval&requestType=human|agent`
- `POST /companies/:companyId/join-requests/:requestId/approve`
- `POST /companies/:companyId/join-requests/:requestId/reject`
- `POST /join-requests/:requestId/claim-api-key` (approved agent requests only)
- `GET /companies/:companyId/members` (returns both human and agent principals)
- `PATCH /companies/:companyId/members/:memberId/permissions`
- `POST /admin/users/:userId/promote-instance-admin`
- `POST /admin/users/:userId/demote-instance-admin`
- `PUT /admin/users/:userId/company-access` (set accessible companies for a user)
- `GET /admin/users/:userId/company-access`

## Local mode UX policy

- no login prompt or account setup required
- local implicit board user is auto-provisioned for audit attribution
- local operator can still use instance settings and company settings as effective instance admin
- invite, join approval, and permission-management UI is available in local mode
- agent onboarding is expected in local mode, including creating invite links and approving join requests
- public/untrusted network ingress is out of scope for V1 local mode

## Cloud agents in this model

- cloud agents continue authenticating through `agent_api_keys`
- same-company boundary checks remain mandatory
- agent ability to assign human tasks is permission-gated, not implicit

## Instance settings surface

This plan introduces instance-level concerns (for example bootstrap state, instance admins, invite defaults, and token policy). There is no dedicated UI surface today.

V1 approach:

- add a minimal `Settings` page for instance admins
- expose key instance settings in API + CLI (`paperclipai configure` / `paperclipai onboard`)
- show read-only instance status indicators in the main UI until full settings UX exists

## Implementation phases

## Phase 1: Mode and guardrails

- add explicit deployment mode config (`local_trusted | cloud_hosted`)
- enforce startup safety checks and health visibility
- implement actor resolution for local implicit board
- map local implicit board actor to instance-admin authorization context
- add bootstrap status signal in health/config surface (`ready | bootstrap_pending`)
- add minimal instance settings API/CLI surface and read-only UI indicators

## Phase 2: Human identity and memberships

- add schema + migrations for users/memberships/invites
- wire auth middleware for cloud mode
- add membership lookup and company access checks
- implement Better Auth email/password flow (no email verification)
- implement first-admin bootstrap invite command and onboard integration
- implement one-time share-link invite acceptance flow with `pending_approval` join requests

## Phase 3: Permissions and assignment scope

- add shared principal grant model and enforcement helpers
- add chain-of-command scope checks for assignment APIs
- add tests for forbidden assignment (for example, cannot assign to CEO)
- add instance-admin promotion/demotion and global company-access management APIs
- add `joins:approve` permission checks for human and agent join approvals

## Phase 4: Invite workflow

- unified `company_join` invite create/landing/accept/revoke endpoints
- join request approve/reject endpoints with review metadata (email when applicable, IP)
- one-time token security and revocation semantics
- UI for invite management, pending join approvals, and membership permissions
- inbox alert generation for pending join requests
- ensure invite and approval UX is enabled in both `cloud_hosted` and `local_trusted`

## Phase 5: Human inbox + task assignment updates

- extend issue assignee model for human users
- inbox API and UI for:
  - task assignments
  - pending join approval alerts with inline approve/reject actions
- agent-to-human assignment flow with policy checks

## Phase 6: Agent self-join and token claim

- add agent join path on unified invite landing page
- capture agent join requests and admin approval flow
- create one-time API-key claim flow after approval (display once)

## Acceptance criteria

1. `local_trusted` starts with no login and shows board UI immediately.
2. `local_trusted` does not expose optional human login UX in V1.
3. `local_trusted` local implicit actor can manage instance settings, invite links, join approvals, and permission grants.
4. `cloud_hosted` cannot start without auth configured.
5. No request in `cloud_hosted` can mutate data without authenticated actor.
6. If no initial admin exists, app shows bootstrap instructions with CLI command.
7. `pnpm paperclipai onboard` outputs a CEO onboarding invite URL when bootstrap is pending.
8. One `company_join` link supports both human and agent onboarding via join-type selection on the invite landing page.
9. Invite delivery in V1 is copy-link only (no built-in email delivery).
10. Share-link acceptance creates a pending join request; it does not grant immediate access.
11. Pending join requests appear as inbox alerts with inline approve/reject actions.
12. Admin review view includes join metadata before decision (human email when applicable, source IP, and agent metadata for agent requests).
13. Only approved join requests unlock access:

- human: active company membership + permission grants
- agent: agent creation + API-key claim eligibility

14. Agent enrollment follows the same link -> pending approval -> approve flow.
15. Approved agents can claim a long-lived API key exactly once, with plaintext display-once semantics.
16. Agent API keys are indefinite by default in V1 and revocable/regenerable by admins.
17. Public/untrusted ingress for `local_trusted` is not supported in V1 (loopback-only local server).
18. One user can hold memberships in multiple companies.
19. Instance admins can promote another user to instance admin.
20. Instance admins can manage which companies each user can access.
21. Permissions can be granted/revoked per member principal (human or agent) through one shared grant system.
22. Assignment scope prevents out-of-hierarchy or protected-role assignments.
23. Agents can assign tasks to humans only when allowed.
24. Humans can view assigned tasks in inbox and act on them per permissions.
25. All new mutations are company-scoped and logged in `activity_log`.

## V1 decisions (locked)

1. `local_trusted` will not support login UX in V1; implicit local board actor only.
2. Permissions use a normalized shared table: `principal_permission_grants` with scoped grants.
3. Invite delivery is copy-link only in V1 (no built-in email sending).
4. Bootstrap invite creation should require local shell access only (CLI path only, no HTTP bootstrap endpoint).
5. Approval review shows source IP only; no GeoIP/country lookup in V1.
6. Agent API-key lifetime is indefinite by default in V1, with explicit revoke/regenerate controls.
7. Local mode keeps full admin/settings/invite capabilities through the implicit local instance-admin actor.
8. Public/untrusted ingress for local mode is out of scope for V1; no `--dangerous-agent-ingress` in V1.
