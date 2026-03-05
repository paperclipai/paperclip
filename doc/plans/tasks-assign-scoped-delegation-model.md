# Scoped `tasks:assign` Delegation Model (OTTAA-71)

## Context

`OTTAA-71` exists because assignment operations are currently all-or-nothing. In practice this caused PM/Security assignment deadlocks (cannot hand off work), while broad admin permissions are too risky.

Current code reality:

- `tasks:assign_scope` is already a valid permission key in shared constants.
- Assignment route guard (`server/src/routes/issues.ts`) checks only `tasks:assign`.
- Grant scope payloads exist in `principal_permission_grants.scope` but are not enforced for assignment.

## Goal

Enable least-privilege delegation so non-CEO operators can assign tasks only inside explicit boundaries (project/team/target constraints), without granting full board-level assignment power.

## Non-Goals

- No change to single-assignee issue invariant.
- No change to checkout lock semantics.
- No automatic reassignment behavior.

## Permission Matrix (Recommended)

| Actor | Required grants | Scope enforcement |
| --- | --- | --- |
| Board (`local_implicit` / instance admin) | none | Full override (existing behavior) |
| Agent/User with `tasks:assign` only | `tasks:assign` | Legacy full assignment (compat mode only) |
| Agent/User with `tasks:assign` + `tasks:assign_scope` | both | Must pass scope policy |

Recommendation: move to strict mode after rollout where non-board assignment requires both grants.

## Scope Payload Contract (`tasks:assign_scope`)

Stored in `principal_permission_grants.scope` for permission key `tasks:assign_scope`.

```json
{
  "projectIds": ["<uuid>", "*"],
  "allowedAssigneeAgentIds": ["<agent-uuid>"],
  "allowedAssigneeRoles": ["founding_engineer", "devops", "qa", "security", "techwriter", "pm"],
  "deniedAssigneeRoles": ["ceo"],
  "allowUnassign": true,
  "allowAssignToUsers": false
}
```

Validation rules:

- `projectIds` required, non-empty.
- Either `allowedAssigneeAgentIds` or `allowedAssigneeRoles` required (or both).
- `deniedAssigneeRoles` default includes `ceo` if omitted.
- Unknown keys rejected in validator.

## Enforcement Algorithm

Implement in a shared policy helper (suggested: `server/src/services/assignment-scope.ts`):

1. If actor is board local-implicit or instance-admin -> allow.
2. Require `tasks:assign` for all non-board actors.
3. Fetch `tasks:assign_scope` grant for actor.
4. If strict mode enabled and scope grant missing -> deny `403`.
5. Evaluate assignment mutation intent:
   - project target (`issue.projectId` or create payload project)
   - assignee target (`assigneeAgentId` / `assigneeUserId` / unassign)
6. Project must match `scope.projectIds` (`*` allowed).
7. For agent assignees:
   - `targetAgentId` in `allowedAssigneeAgentIds` OR
   - target role in `allowedAssigneeRoles`
   - and NOT in `deniedAssigneeRoles`
8. For user assignees: require `allowAssignToUsers=true`.
9. For unassign operations: require `allowUnassign=true`.
10. Return `403` with reason code when denied.

## Route Integration Points

- `POST /api/companies/:companyId/issues` (create with assignee).
- `PATCH /api/issues/:id` when assignee fields change.
- Any assign-user route (if present) should use same evaluator.

Suggested response payload for denies:

```json
{ "error": "Missing permission: tasks:assign_scope", "reason": "project_out_of_scope" }
```

## Test Gate

### Unit

- scope parser validation (required fields, defaults, unknown keys).
- evaluator allow/deny matrix by project + role + assignee type.

### Integration

- PM with scoped grant can assign within allowed project/roles.
- PM denied when assigning to CEO.
- Security denied outside allowed project list.
- Unassign denied when `allowUnassign=false`.
- Board local implicit path remains unrestricted.

### Regression

- Existing board assignment flows unchanged.
- Existing checkout and WIP rules still apply after scope allow.

## Rollout

1. Ship evaluator + tests in compat mode (`ASSIGN_SCOPE_STRICT=false`).
2. Add scope grants for PM/Security in target company.
3. Verify assignment recovery workflow in staging.
4. Flip strict mode to true after successful verification.

## Board Decision Needed

Before strict mode activation, board should approve:

1. Whether `tasks:assign`-only principals remain temporarily allowed.
2. Default deny list (`ceo` recommended as always denied).
3. Whether PM can assign to human users (`assigneeUserId`) in V1.
