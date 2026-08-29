# Plan: Agent Grant Management (API + UI)

**Date:** 2026-08-29
**Status:** Proposed

## Context

Company permission grants live in `principal_permission_grants` (company-scoped, per principal, unique on
`companyId + principalType + principalId + permissionKey`) and drive every authorization decision through
`server/src/services/authorization.ts` (`decidePrincipalGrant`).

Today there is no supported way to change an **existing agent's** grants:

- `PATCH /api/agents/:id/permissions` (`server/src/routes/agents.ts:3686`) manages only legacy flags
  (`canCreateAgents`, `canAssignTasks`, `trustPreset`) and hardcodes the `tasks:assign` grant.
- The member-grants routes (`PATCH /api/companies/:companyId/members/:memberId/permissions` and
  `.../role-and-grants` in `server/src/routes/access.ts:4754,4585`) explicitly reject non-human principals
  ("Only human company members can be removed.").
- Agent grants are only written at hire time by the built-in-agents reconciler
  (`ensureAgentDefaultGrants`, `ROOT_AGENT_DEFAULT_CHANGE_GRANTS`) — so non-built-in, non-CEO agents can
  never receive keys like `agents:configure` without direct DB writes (which bypass the activity log
  contract and are not available to cloud deployments).

The UI also has **no grant editor at all**: `ui/src/api/access.ts` ships `updateMemberRoleAndGrants` /
`updateMemberPermissions`, but no component calls them.

Observed failure mode: an agent that needs `agents:configure` (e.g. to manage peer agent configuration)
cannot be granted it through any API or UI surface; the operator had to fall back to a raw SQL insert.

## Problem

Grant changes for agent principals require either hire-time defaults or database access. This breaks the
control-plane invariant that all mutating actions flow through audited API routes.

## Goals

1. Board operators can view and edit an agent's explicit permission grants from the UI.
2. Grant changes go through an audited, permission-gated API route (activity log entry per change).
3. Contract layers stay synchronized: `packages/db` (no change), `packages/shared`, `server`, `ui`.

## Non-goals

- Editing grants for **human** members from the UI (API exists; separate follow-up can reuse the editor).
- The `agents:suggest-changes` proposal/approval flow for grant changes (direct edit only in V1).
- Changing the `PERMISSION_KEYS` list, grant scoping semantics (`scope` jsonb), or the authorization
  decision ladder in `authorization.ts`.

## Contract Changes

### 1. `packages/shared` — validators

In `packages/shared/src/validators/access.ts`, extract the grants array shape and add an agent-facing
schema:

```ts
export const principalGrantsPayloadSchema = z.array(
  z.object({
    permissionKey: z.enum(PERMISSION_KEYS),
    scope: z.record(z.string(), z.unknown()).optional().nullable(),
  }),
);

export const updateAgentGrantsSchema = z.object({ grants: principalGrantsPayloadSchema });
```

Refactor `updateMemberPermissionsSchema` to reuse `principalGrantsPayloadSchema` (no behavior change).

### 2. `server` — route

New route in `server/src/routes/agents.ts`:

```
PATCH /api/agents/:id/grants
Body: { "grants": [{ "permissionKey": "agents:configure", "scope": null }, ...] }
```

**Semantics — full replace**, identical to `access.setMemberPermissions` (`server/src/services/access.ts:125`):
the transaction deletes all existing `agent`-principal grants for the agent, then inserts the payload.
Omitting `tasks:assign` drops it. The response is `buildAgentDetail(agent)` so callers see the resulting
`access.grants` in one round trip.

**Authorization:**

| Actor        | Rule                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| Board user   | `assertCompanyPermission(req, companyId, "users:manage_permissions")` — same gate as member grants.     |
| Agent        | Role must be `ceo` (parity with `PATCH /agents/:id/permissions`, "Only CEO can manage permissions").    |
| Agent, self  | Forbidden — an agent never edits its own grants (privilege-escalation guard).                           |
| Low-trust    | Reuse the existing `pending_approval` / restricted-agent guards (see below).                            |

**Edge cases:**

- Agent not found / other company → 404 (via `getAccessibleResource`) / 403 cross-tenant rule.
- `pending_approval` agent → 409, mirroring `svc.updatePermissions` ("config frozen before board
  approval"). Terminated agents: allowed (rows are inert).
- Payload validation → 422 via `validate(updateAgentGrantsSchema)`.
- Company boundary: grants are always written with the agent's own `companyId` — never from the request.

**Activity log (required by control-plane invariant):**

```ts
logActivity(db, {
  companyId, actorType, actorId, runId, agentApiKeyId,
  action: "agent.grants_updated",
  entityType: "agent", entityId: agent.id,
  details: { permissionKeys: [...], grantCount },
});
```

Implementation note: the write itself should call `access.setMemberPermissions` with the agent's
membership id (it already does delete-then-insert in a transaction and accepts `principalType` from the
membership row), or an equivalent `setPrincipalGrants` helper added to the access service. Do **not**
loop `setPrincipalPermission` per key outside a transaction.

### 3. `ui` — grant editor

- **API client:** `ui/src/api/access.ts` (or `ui/src/api/agents.ts`) gains
  `updateAgentGrants(companyId, agentId, grants)` → `PATCH /companies/:id/agents/:agentId/grants`
  (adjust to the actual route prefix used by the client).
- **Component:** new `components/PrincipalGrantsEditor.tsx` — checkbox list over `PERMISSION_KEYS`
  (from `@paperclipai/shared`), showing `scope` as read-only jsonb when present, with an explicit
  warning banner when `users:manage_permissions` is selected (agent would gain control over human
  member grants). Replace semantics surfaced in the UI: the checkbox list starts from the agent's
  current `access.grants`, and saving submits the full set.
- **Placement:** `ui/src/pages/AgentDetail.tsx`, in the existing access section next to
  `canAssignTasks` / `taskAssignSource` (around line 2160).
- **Capability gating:** expose `canManageAgentGrants` on the company-members access payload
  (`loadCompanyMemberRecords` access computation in `server/src/routes/access.ts`, same place
  `canApproveJoinRequests` is derived) and gate the editor on it. Hidden editors for agents without
  the flag; API remains the enforcement layer.

### 4. `packages/db`

No schema change. `principal_permission_grants` already supports agent principals (row exists today for
`tasks:assign`).

## Tests

Mirror existing suites:

- `server/src/__tests__/agent-permissions-routes.test.ts` (extend or add sibling):
  - board happy path: replace semantics verified (old grants gone, new grants present, response echoes
    `access.grants`),
  - 403 without `users:manage_permissions`, 403 agent-actor non-CEO, 403 agent-actor self-edit,
  - 409 for `pending_approval`, 404 unknown agent, 403 cross-company agent key,
  - activity log row written with `agent.grants_updated`.
- Validator tests for `updateAgentGrantsSchema` (bad key rejected, scope passthrough).
- `ui/src` component test: renders current grants, toggles a key, submits full set, warning shown for
  `users:manage_permissions`.

## Verification

```sh
pnpm -r typecheck
pnpm test:run            # targeted: the three suites above first
pnpm build
pnpm check:token-gates   # UI token rule
```

Manual: on the dev instance, grant `agents:configure` to a test agent via the new editor, then confirm
the agent's `GET /api/agents/me` reports the grant and it can perform the gated action
(e.g. read peer agent configuration).

## Risks

- **Replace semantics surprise:** a payload missing `tasks:assign` silently drops it. Mitigation: UI
  preloads current grants; API response echoes the resulting set; documented in route summary.
- **Escalation via grants:** granting `users:manage_permissions` to an agent lets it rewrite human
  member grants. Mitigation: UI warning banner; CEO-agent actors can only edit others, never self.
- **Low-trust surface:** grant editing must not appear in restricted/low-trust agent views (reuse
  `redactForRestrictedAgentView` behavior; the new route's agent-actor gate already excludes them).

## Open questions

1. Should CEO-agent actors be allowed at all in V1, or board-only? (Spec'd as board + CEO-agent parity
   with the existing permissions route; narrowing to board-only is a one-line change.)
2. Should the UI editor for human members (already API-capable) land in the same PR? Recommended as an
   immediate follow-up reusing `PrincipalGrantsEditor`.
