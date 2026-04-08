# Phase 2: Department-Scoped RBAC — Detailed Implementation Plan

Status: Ready
Date: 2026-04-08
Depends on: `doc/plans/2026-04-08-phase1-implementation-plan.md`
Related:
- `doc/plans/2026-02-21-humans-and-permissions.md`
- `doc/plans/2026-02-21-humans-and-permissions-implementation.md`
- `doc/plans/2026-04-08-paperclip-capability-audit.md`

## 1. Goal

Turn Paperclip's existing membership and permission foundation into a usable role product with department-aware scope.

This phase should make departments operational, not just structural. After Phase 1, departments, teams, memberships, and department-aware org views exist. What is still missing is the ability to say:

- this person is a manager of Engineering
- this user can only see Finance work
- this agent can operate inside one department but not the whole company
- company admins can assign reusable roles instead of hand-editing raw grants

## 2. Why This Slice Next

This is the highest-leverage next slice because:

- Phase 1 already added `departments`, `teams`, `department_memberships`, and `department_id` on key entities.
- The repo already has a real permission foundation:
  - `company_memberships`
  - `principal_permission_grants`
  - `accessService`
  - company-level permission routes
- The biggest remaining organizational gap is not data modeling anymore. It is enforcement and administration.

Without department-scoped RBAC, departments are mostly labels. With department-scoped RBAC, departments become an actual operating boundary.

## 3. Current Foundation

What exists today:

- `company_memberships` is the canonical company-scoped membership table for users and agents.
- `principal_permission_grants` already supports `scope jsonb`.
- `accessService.hasPermission()` and related helpers are already in production code.
- `GET /api/companies/:companyId/members` and `PATCH /api/companies/:companyId/members/:memberId/permissions` already exist.
- Departments and teams are now first-class entities.
- `department_id` already exists on `agents`, `projects`, and `issues`.
- The UI already has departments pages and a department-grouped org chart mode.

What does not exist yet:

- no named reusable roles
- no principal-to-role assignment model
- no runtime interpretation of department scope
- no department-scoped visibility filters
- no dedicated roles/access admin UI
- several routes still use legacy checks such as CEO special-casing or `agents.permissions`
- `tasks:assign_scope` exists as a key, but it is not meaningfully enforced

## 4. Scope of This Phase

This phase is the first meaningful RBAC slice, not a full endpoint-by-endpoint hardening of the entire product.

In scope:

- named company-scoped roles
- department-scoped role assignments for users and agents
- effective permission evaluation from:
  - instance admin
  - direct grants
  - role-derived grants
- department-aware visibility for:
  - departments
  - teams
  - org chart grouped view
  - agents
  - projects
  - issues
- minimal admin UI for assigning roles and department scopes
- migration away from legacy route-local permission shortcuts in touched areas

Out of scope:

- full authorization coverage for every surface in the product
- costs, budgets, routines, plugin management, storage, and audit export scoping
- SSO, SCIM, or external directory sync
- compliance export features
- department budget policy enforcement
- custom reporting by department

## 5. Architecture Decisions

### 5.1 Evolve the current grants model instead of replacing it

Do not throw away `principal_permission_grants`.

Phase 2 should layer named roles on top of the current model:

- direct grants remain supported
- roles become the default admin UX
- effective permissions are the union of:
  - instance-admin authority
  - direct grants
  - role-derived grants

This minimizes migration risk and keeps the existing access routes useful.

### 5.2 Role assignments own scope

Role definitions should be reusable bundles of permission keys.

The assignment, not the role definition, should carry department scope. This allows:

- one `Department Manager` role definition
- many assignments of that role to different departments

### 5.3 Department scope is the first real scope shape

The first supported runtime scope should be department-based.

Proposed normalized shape:

```ts
type PermissionScope =
  | null
  | {
      kind: "departments";
      departmentIds: string[];
      includeDescendants: boolean;
    };
```

Semantics:

- `null` means company-wide
- `departments` means access only inside the listed departments
- `includeDescendants=true` means the assignment also applies to nested departments

### 5.4 Unassigned work stays company-wide only

If an issue, project, or agent has no `department_id`, department-scoped roles should not automatically see it.

Rule:

- `department_id IS NULL` is visible only to company-wide roles/grants and instance admins

This avoids accidental leakage of uncategorized work.

### 5.5 Keep local trusted admin behavior

`local_trusted` and instance-admin flows remain the top-level bypass:

- instance admins continue to have full access
- local trusted operator continues to behave as instance admin

Department-scoped RBAC applies to normal user/agent principals, not to instance bootstrap/admin bypass.

### 5.6 Migrate legacy checks gradually

This phase should not try to delete every legacy permission branch in one pass.

Rule:

- touched routes migrate to shared access evaluation
- untouched legacy routes may stay as-is temporarily
- no new route should add more legacy permission special-casing

## 6. Proposed Permission Inventory

The current permission list is too small for department-aware RBAC. Expand it, but keep it intentionally compact.

Keep existing:

- `agents:create`
- `users:invite`
- `users:manage_permissions`
- `tasks:assign`
- `tasks:assign_scope`
- `joins:approve`

Add for this phase:

- `roles:view`
- `roles:manage`
- `departments:view`
- `departments:manage`
- `teams:view`
- `teams:manage`
- `agents:view`
- `agents:manage`
- `projects:view`
- `projects:manage`
- `issues:view`
- `issues:manage`
- `org:view`

Notes:

- `tasks:assign` remains separate from `issues:manage`.
- `users:manage_permissions` remains the top-level company membership/grants permission.
- `roles:manage` controls creation/editing/assignment of reusable roles.

## 7. System Roles to Seed Per Company

Seed a small set of reusable roles per company.

### 7.1 `company_admin`

Company-wide role.

Permissions:

- all Phase 2 read/write permissions
- `users:invite`
- `users:manage_permissions`
- `joins:approve`
- `agents:create`
- `tasks:assign`

### 7.2 `department_manager`

Department-scoped role.

Permissions:

- `roles:view`
- `departments:view`
- `teams:view`
- `agents:view`
- `projects:view`
- `projects:manage`
- `issues:view`
- `issues:manage`
- `org:view`
- `tasks:assign`

### 7.3 `department_member`

Department-scoped role.

Permissions:

- `departments:view`
- `teams:view`
- `agents:view`
- `projects:view`
- `issues:view`
- `issues:manage`
- `org:view`

### 7.4 `viewer`

Company-wide or department-scoped read-only role.

Permissions:

- `departments:view`
- `teams:view`
- `agents:view`
- `projects:view`
- `issues:view`
- `org:view`

## 8. Data Model Changes

### 8.1 New tables

#### `company_roles`

Suggested fields:

- `id`
- `company_id`
- `key` stable slug, unique per company
- `name`
- `description`
- `is_system` boolean
- `status` (`active | archived`)
- `created_at`
- `updated_at`

Purpose:

- stores reusable role definitions
- supports system roles and custom company roles

#### `company_role_permissions`

Suggested fields:

- `id`
- `role_id`
- `permission_key`
- `created_at`

Purpose:

- normalized role-to-permission mapping

#### `principal_role_assignments`

Suggested fields:

- `id`
- `company_id`
- `role_id`
- `principal_type`
- `principal_id`
- `scope jsonb`
- `assigned_by_user_id`
- `created_at`
- `updated_at`

Purpose:

- binds a role to a user or agent
- carries department scope on the assignment itself

### 8.2 Existing table reuse

Do not change the core meaning of:

- `company_memberships`
- `principal_permission_grants`

Direct grants stay available and should use the same scope shape as role assignments.

### 8.3 Migration

Add a new migration:

- `packages/db/src/migrations/0054_department_scoped_rbac.sql`

Files to create:

- `packages/db/src/schema/company_roles.ts`
- `packages/db/src/schema/company_role_permissions.ts`
- `packages/db/src/schema/principal_role_assignments.ts`

Files to update:

- `packages/db/src/schema/index.ts`

## 9. Shared Contracts

Files to update or add:

- `packages/shared/src/constants.ts`
- `packages/shared/src/types/access.ts`
- `packages/shared/src/types/rbac.ts`
- `packages/shared/src/index.ts`

Add:

- expanded `PermissionKey`
- role definition types
- role assignment types
- scope types
- request/response payload types for roles and assignments

Add Zod validation for:

- create role
- update role
- assign role
- update direct grants with scope

## 10. Service Layer Plan

### 10.1 Evolve `accessService`

`server/src/services/access.ts` should become the central evaluator for direct grants plus roles.

Add:

- `evaluatePermission(companyId, principalType, principalId, permissionKey, context?)`
- `resolveEffectivePermissions(companyId, principalType, principalId)`
- `resolveAccessibleDepartmentIds(companyId, principalType, principalId, permissionKey?)`
- `matchesDepartmentScope(scope, departmentId)`

`hasPermission()` can remain as a simple wrapper for company-wide checks, but route-level auth should move toward `evaluatePermission()`.

### 10.2 Add `rolesService`

Create:

- `server/src/services/roles.ts`

Methods:

- `seedSystemRoles(companyId)`
- `listRoles(companyId)`
- `getRoleById(roleId)`
- `createRole(companyId, data)`
- `updateRole(roleId, data)`
- `archiveRole(roleId)`
- `assignRole(companyId, principalType, principalId, roleId, scope)`
- `removeRoleAssignment(assignmentId)`
- `listRoleAssignments(companyId, principalType, principalId)`

### 10.3 Add scoped query helpers

Create reusable helpers for list/detail routes:

- resolve principal's allowed departments for a given permission
- apply `department_id IN (...)` filters
- treat `NULL department_id` as company-wide only

These helpers should be used in services/routes, not copied route by route.

## 11. API Plan

### 11.1 Extend access routes

Prefer extending `server/src/routes/access.ts` instead of creating an unrelated parallel access router.

Add:

```text
GET    /companies/:companyId/roles
POST   /companies/:companyId/roles
GET    /roles/:roleId
PATCH  /roles/:roleId
POST   /roles/:roleId/archive

GET    /companies/:companyId/members/:memberId/role-assignments
POST   /companies/:companyId/members/:memberId/role-assignments
DELETE /role-assignments/:assignmentId
```

Keep existing:

- `GET /companies/:companyId/members`
- `PATCH /companies/:companyId/members/:memberId/permissions`

But update payload validation so direct grants can carry the same department scope shape.

### 11.2 Permission requirements for admin routes

- role listing: `roles:view` or `users:manage_permissions`
- role mutation: `roles:manage`
- member grants/assignments: `users:manage_permissions` or `roles:manage`

For the first slice, `users:manage_permissions` can still be the stronger gate for company access administration, while `roles:view/manage` supports the reusable role model.

## 12. Enforcement Rollout

### 12.1 Phase 2A route coverage

Apply department-aware authorization to these areas first:

- departments routes
- teams routes
- org chart data routes
- issues list/detail/create/update routes
- projects list/detail/update routes
- agents list/detail read paths

Keep these temporarily legacy or admin-only unless touched:

- plugin admin
- storage admin
- cost/budget routes
- portability/export admin

### 12.2 Visibility rules

#### Departments and teams

- view requires `departments:view` / `teams:view`
- mutations require `departments:manage` / `teams:manage`
- department-scoped principal sees only scoped departments
- if `includeDescendants=true`, descendants are visible too

#### Issues and projects

- read requires `issues:view` / `projects:view`
- mutate requires `issues:manage` / `projects:manage`
- department-scoped principal sees only rows where `department_id` matches scope
- rows with `department_id = null` require company-wide scope

#### Agents and org chart

- read requires `agents:view` and `org:view`
- department-scoped principal sees only in-scope agents in the UI and API
- grouped org chart should filter department sections to visible departments

### 12.3 Assignment semantics

`tasks:assign` should become department-aware when a scoped principal uses it.

Rule for scoped principals:

- the target issue must be in a permitted department
- the target assignee must belong to a permitted department

If `tasks:assign_scope` remains as a separate key, use it only for future non-department scope expansion. Do not invent a second overlapping department-scope system.

## 13. UI Plan

### 13.1 Add a company access page

Create a new page:

- `ui/src/pages/AccessControl.tsx`

Recommended route:

- `/access`

This page should have two operator-facing sections:

- Members
- Roles

### 13.2 Members tab

Show:

- current company memberships
- current direct grants
- current role assignments
- quick summary of effective department scope

Member action drawer or dialog:

- assign system/custom role
- choose scope:
  - company-wide
  - selected departments
  - include descendants toggle
- remove role assignment
- optionally edit direct grants for advanced users

### 13.3 Roles tab

Show:

- seeded system roles
- custom roles
- permission bundle summary

Actions:

- create custom role
- edit custom role permissions
- archive custom role

System roles should be visible but more restricted:

- editable only if we explicitly want that behavior
- otherwise read-only with stable meaning

### 13.4 Department detail enhancements

Use the existing department pages to surface role context:

- show which members are assigned as `Department Manager`
- add shortcut action: assign selected company member to this department role

This keeps department-admin flows discoverable even if the full access page is the main control plane.

### 13.5 UI API changes

Extend:

- `ui/src/api/access.ts`

Add:

- `listRoles`
- `createRole`
- `updateRole`
- `archiveRole`
- `listMemberRoleAssignments`
- `assignMemberRole`
- `removeRoleAssignment`
- `updateMemberPermissions` with scoped grants

## 14. Execution Order

### Workstream A — Contracts and schema

1. Add role tables and migration.
2. Expand permission keys and shared RBAC types.
3. Add scope validators.

### Workstream B — Access evaluator

1. Evolve `accessService` into an effective-permission evaluator.
2. Add department-scope matching and descendant expansion.
3. Add role seeding and assignment logic.

### Workstream C — Admin APIs

1. Extend access routes for roles and role assignments.
2. Update direct grant payloads to support department scope cleanly.
3. Add server tests for evaluator and routes.

### Workstream D — UI admin surface

1. Add `AccessControl` page.
2. Add members + roles tabs.
3. Add assignment dialogs and optimistic refresh.
4. Link page from the main navigation or admin section.

### Workstream E — Route enforcement

1. Enforce department-scoped visibility on departments/teams/org.
2. Enforce department-scoped visibility on issues/projects.
3. Migrate touched routes away from legacy `agent.permissions` checks where possible.

### Workstream F — Cleanup and docs

1. Update docs for department-scoped RBAC semantics.
2. Note which routes are still legacy and which are fully RBAC-aware.
3. Add operator guidance for system roles and scope rules.

## 15. Tests

### 15.1 Server tests

Add:

- `server/src/__tests__/access-service-rbac.test.ts`
- `server/src/__tests__/roles-routes.test.ts`
- extend department, issue, project, and org route tests

Must cover:

- company-wide role allows access
- department-scoped role allows only matching department
- descendant-inclusive scope includes child departments
- unassigned issue/project is hidden from department-only principals
- direct grant plus role-derived grant union works
- instance admin bypass still works
- role assignment to agent principal works
- scoped assignment denies out-of-scope task assignment

### 15.2 UI tests

Add:

- `ui/src/pages/AccessControl.test.tsx`
- extend `DepartmentDetail.test.tsx`
- extend org chart and issues/project visibility tests where applicable

Must cover:

- seeded roles render
- assigning department-scoped role submits correct scope payload
- member effective-role summary renders
- department shortcut assignment works
- scoped user sees filtered department/org content

## 16. Risks

### Risk 1: Route coverage drift

Some routes still use legacy permission logic today. If Phase 2 touches only part of the product, behavior may feel inconsistent.

Mitigation:

- keep a route coverage checklist in the implementation plan
- touched routes must migrate to shared access helpers

### Risk 2: Over-designing permissions

It is easy to explode into dozens of permission keys and a giant admin UI.

Mitigation:

- keep the first role inventory small
- prefer a few meaningful roles over a huge permission matrix

### Risk 3: Scope ambiguity for null departments

Items without `department_id` can silently become visible to the wrong people if not defined clearly.

Mitigation:

- define null department as company-wide only
- test this explicitly

## 17. Acceptance Criteria

This phase is done when all are true:

1. Companies have seeded reusable roles.
2. Users and agents can receive role assignments with department scope.
3. Effective permission evaluation combines instance admin, direct grants, and roles.
4. Department scope is enforced on departments, teams, org chart, issues, and projects in the touched surfaces.
5. Unassigned work is not visible to department-only principals.
6. Admin UI allows assigning department-scoped roles without editing raw DB state.
7. Existing direct grant routes still work and support scoped payloads.
8. `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` pass after implementation.

## 18. Recommended Immediate Next Steps

1. Lock the permission inventory and seeded role set before coding.
2. Implement schema + shared contract changes first.
3. Build the evaluator before any route migration.
4. Land admin APIs next so UI work has a stable surface.
5. Ship the access UI and department shortcut flows.
6. Migrate route enforcement in a controlled order: departments/org first, then issues/projects, then remaining touched agent reads.
