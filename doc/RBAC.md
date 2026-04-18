# RBAC

Paperclip V1 uses company membership plus department-scoped RBAC for the Phase 2 surface.

This document is the operator guide for how access is evaluated today, which routes are covered, and where legacy company-wide checks still remain.

## How Access Is Resolved

Access checks follow the same order everywhere the scoped helper is used:

1. The actor must already have company access.
2. Local implicit board access and instance admins bypass department scoping.
3. Direct grants and role-derived grants are combined.
4. Department scopes are expanded to include descendants when `includeDescendants` is enabled.
5. A `null` scope means company-wide access only.

Practical consequences:

- If a permission resolves to company-wide access, the actor can read or mutate any resource for that permission.
- If a permission resolves to department IDs only, the actor can access resources in those departments and nowhere else.
- Resources without a department require company-wide permission for that action.

## System Roles

The seeded system roles live in [server/src/services/roles.ts](/Users/chris/Developer/paperclip/server/src/services/roles.ts).

`Company Admin`

- Company-wide administration.
- Includes role management, department/team management, agent/project/issue management, org visibility, user invitation, permission management, join approval, agent creation, and task assignment.

`Department Manager`

- Department-scoped management role.
- Includes `projects:manage`, `issues:manage`, `tasks:assign`, and read access for roles, departments, teams, agents, projects, issues, and org data.

`Department Member`

- Department-scoped contributor role.
- Includes read access plus `issues:manage`.

`Viewer`

- Read-only company or department access.
- Includes `departments:view`, `teams:view`, `agents:view`, `projects:view`, `issues:view`, and `org:view`.

## Route Coverage

Current route coverage is:

| Route file | Status | Notes |
|------------|--------|-------|
| `access.ts` | Enforced | RBAC administration surface; uses explicit permission checks for role and grant management. |
| `departments.ts` | Enforced | Department visibility and mutation use scoped department permissions. |
| `teams.ts` | Enforced | Team reads and writes are bound to the owning department scope. |
| `issues.ts` | Enforced | Issue reads, writes, comments, and list filtering use department-aware helpers. |
| `projects.ts` | Enforced | Project reads, writes, and workspace operations are scoped by project department. |
| `activity.ts` | Enforced | Company activity reads are filtered by visible departments; issue/run lookups enforce scoped visibility. |
| `costs.ts` | Enforced for current cost/budget surface | Cost and finance reads are filtered by visible departments. Company budget and quota-window reads still require company-wide access. Project/agent budget mutations require the matching scoped manage permission. |
| `agents.ts` | Partial | Org listings are department-aware, but many operational/admin endpoints still rely on company-wide or board-only checks. |
| `routines.ts` | Legacy | Uses company access checks, not department-scoped RBAC. |
| `plugins.ts` | Legacy | Mostly board/company guarded; not yet department-scoped. |

## Cost And Budget Semantics

The cost/budget surface intentionally separates visibility from global controls:

- Cost summaries, cost breakdowns, finance summaries, finance event lists, activity feeds, and run-linked issue lists can be filtered to the departments the actor can see.
- Company-wide budget values and quota-window inspection are treated as global operational controls, so department-scoped actors do not get implicit access to them.
- Budget policies and incident resolution use the scope's owning resource:
  - company scope requires company-wide manage permission
  - project scope requires `projects:manage` in that project's department
  - agent scope requires `agents:manage` in that agent's department

## Operator Playbook

When assigning access in the UI:

1. Seed the system roles first.
2. Prefer scoped role assignments over direct grants.
3. Use company-wide scope only for true administrative functions.
4. For department managers, grant the role at the smallest department subtree that matches ownership.
5. Validate with a non-admin session after assigning access:
   - can see only the expected departments
   - cannot mutate resources outside that scope
   - cannot read global budget/quota data unless explicitly company-wide

## Remaining Gaps

These areas are still intentionally deferred after Phase 2:

- full agent route hardening
- routines and plugin management scoping
- broader enterprise policy layers beyond department visibility

Until those are completed, use `Company Admin` for operators who must cross department boundaries in legacy surfaces.
