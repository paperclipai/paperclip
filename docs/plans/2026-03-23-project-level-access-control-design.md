# Project-Level Access Control Design

**Date:** 2026-03-23
**Status:** Approved

## Problem

RBAC permissions are currently company-scoped only. All company members can see and access all projects. There's no way to restrict project visibility or control per-project permissions for individual members or agents.

## Goals

- Members can only see projects they're explicitly assigned to
- Per-project permission control (view, edit issues, manage members, etc.)
- Role presets (super_admin/admin/editor/viewer) with optional fine-tuning via granular checkboxes
- Agent assignment per project — agents are treated as project resources
- Company owners bypass all project access restrictions
- Mirrors the existing company-level pattern (`memberships` + `permission_grants` + `role presets`)

## Non-Goals

- Project-level agent permission scoping (agents still use company-level permissions for what they can _do_; project assignment controls _where_ they can be used)
- Cross-company project sharing

---

## Data Model

### New Table: `project_members`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `projectId` | UUID | FK → projects |
| `companyId` | UUID | FK → companies (denormalized for query efficiency) |
| `principalType` | text | "user" or "agent" |
| `principalId` | text | user/agent ID |
| `role` | text | "super_admin" / "admin" / "editor" / "viewer" |
| `addedByUserId` | text | who invited them |
| `createdAt` | timestamp | |

Unique constraint on `(projectId, principalType, principalId)`.

### New Table: `project_permission_grants`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `projectId` | UUID | FK → projects |
| `companyId` | UUID | FK → companies |
| `principalType` | text | "user" or "agent" |
| `principalId` | text | |
| `permissionKey` | text | project-level permission key |
| `grantedByUserId` | text | |
| `createdAt` | timestamp | |

Unique constraint on `(projectId, principalType, principalId, permissionKey)`.

### New Table: `project_agents`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `projectId` | UUID | FK → projects |
| `companyId` | UUID | FK → companies |
| `agentId` | UUID | FK → agents |
| `addedByUserId` | text | |
| `createdAt` | timestamp | |

Unique constraint on `(projectId, agentId)`.

### Project-Level Permission Keys

```
project:view           — see the project (implicit for all members)
project:issues:create  — create issues
project:issues:edit    — edit/update issues
project:issues:delete  — delete issues
project:issues:assign  — assign issues to agents
project:agents:use     — invoke agents in this project
project:settings       — edit project settings (name, status, target date)
project:members:manage — add/remove members, change their permissions
```

### Project Role Presets

| Role | Permissions |
|------|-------------|
| **super_admin** | All 8 permissions (auto-assigned to project creator) |
| **admin** | All except `project:members:manage` |
| **editor** | `view`, `issues:create`, `issues:edit`, `issues:assign`, `agents:use` |
| **viewer** | `view` only |

### Visibility Rules

- **Company owners** → see all projects always (bypass)
- **Project members** → see their assigned projects
- **Non-members** → project is invisible

---

## API Endpoints

### Project Members

| Method | Path | Permission Required | Description |
|--------|------|-------------------|-------------|
| `GET` | `/projects/:id/members` | project member | List all members + their grants |
| `POST` | `/projects/:id/members` | `project:members:manage` | Add a member |
| `PATCH` | `/projects/:id/members/:memberId` | `project:members:manage` | Update member role |
| `PATCH` | `/projects/:id/members/:memberId/permissions` | `project:members:manage` | Fine-tune individual grants |
| `POST` | `/projects/:id/members/:memberId/role-preset` | `project:members:manage` | Quick-apply preset |
| `DELETE` | `/projects/:id/members/:memberId` | `project:members:manage` | Remove member |

### Project Agents

| Method | Path | Permission Required | Description |
|--------|------|-------------------|-------------|
| `GET` | `/projects/:id/agents` | project member | List assigned agents |
| `POST` | `/projects/:id/agents` | `project:members:manage` | Assign agent to project |
| `DELETE` | `/projects/:id/agents/:agentId` | `project:members:manage` | Remove agent from project |

### Modified Existing Routes

| Route | Change |
|-------|--------|
| `GET /companies/:companyId/projects` | Filter — only return projects where user is a member (or is company owner) |
| `POST /companies/:companyId/projects` | Auto-create `project_members` entry with `super_admin` role for creator |
| `PATCH /projects/:id` | Require `project:settings` grant instead of company-level `projects:manage` |
| `POST /projects/:id/issues` | Require `project:issues:create` grant |
| `PATCH /issues/:id` | Require `project:issues:edit` on the issue's project |
| `DELETE /issues/:id` | Require `project:issues:delete` on the issue's project |

### Authorization Flow

```
Request → Company access check → Project membership check → Project permission check → Allow/Deny
                                        ↑
                          Company owner bypasses this
```

---

## Access Service Changes

### New Functions

```
getProjectMembership(projectId, principalType, principalId)
hasProjectPermission(projectId, principalType, principalId, permissionKey)
canUserAccessProject(companyId, projectId, userId)
listProjectMembers(projectId)
setProjectMemberPermissions(projectId, memberId, grants, grantedByUserId)
addProjectMember(projectId, principalType, principalId, role, addedByUserId)
removeProjectMember(projectId, memberId)
listProjectAgents(projectId)
addProjectAgent(projectId, agentId, addedByUserId)
removeProjectAgent(projectId, agentId)
listAccessibleProjects(companyId, principalType, principalId)
```

### New Middleware

```
requireProjectPermission(req, access, projectId, permissionKey)
  → asserts company access
  → checks company owner bypass
  → checks project membership + grant
```

---

## Frontend UI

### Project Page — Members Panel (lightweight)

- Small member avatar list in project header/sidebar
- Shows count: "5 members"
- "Add member" button (visible only with `project:members:manage`)
- Quick-add modal: search company members, select role preset, add

### Project Settings — Members & Permissions Tab

- Full member list with role badges
- Same pattern as CompanySettings MembersSection:
  - Expandable permission editor per member
  - Role preset quick-apply buttons (super_admin / admin / editor / viewer)
  - Individual permission checkboxes for fine-tuning
  - Remove member button
- Separate "Agents" sub-section:
  - List of assigned agents
  - Add/remove agent controls

### Projects List Page

- No visual change — just returns fewer projects (only ones user can see)
- Company owners see the full list as before

### Permission Labels

```
project:view            → "View project"
project:issues:create   → "Create issues"
project:issues:edit     → "Edit issues"
project:issues:delete   → "Delete issues"
project:issues:assign   → "Assign issues"
project:agents:use      → "Use agents"
project:settings        → "Project settings"
project:members:manage  → "Manage members"
```

---

## Migration & Backwards Compatibility

### Existing Projects

When this feature ships, existing projects have no members in the new table. To handle this gracefully:

1. **Fallback rule:** If a project has zero `project_members` rows, treat it as "legacy" — all company members can see it (preserves current behavior).
2. **Once any member is added** to a project, strict mode kicks in — only members can see it.
3. **One-time migration script** (optional, can be triggered from company settings): bulk-add the company owner as `super_admin` on all existing projects and all current active members as `editor`.

This gives a graceful transition — nothing breaks on deploy, admins tighten access per-project at their own pace.
