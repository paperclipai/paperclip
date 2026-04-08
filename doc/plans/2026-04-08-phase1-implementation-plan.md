# Phase 1: Organizational Structure — Detailed Implementation Plan

Status: Ready
Date: 2026-04-08
Sprint: 1 (Apr 14–28) + Sprint 2 (Apr 28–May 12)
Plane: Module `116e85d1-e76a-4f88-a069-62db122e81f0`
Related: `doc/plans/2026-04-08-paperclip-capability-audit.md`
Companion: `doc/plans/2026-04-08-sprint-2-ui-org-chart-tests.md`
Next: `doc/plans/2026-04-08-phase2-department-rbac-plan.md`

## 1. Goal

Add first-class **departments** and **teams** to Paperclip. Today the org model is flat: `company → agents/users`. Real companies have Engineering, Finance, HR, etc. This phase creates the intermediate organizational layer that Phase 2 (RBAC) and Phase 3 (SLA) will build on.

## 2. Current State (from Audit)

What exists:
- `company_memberships` table with `principal_type` (user/agent) + `principal_id`
- `agents.reportsTo` for manager hierarchy (self-referential UUID)
- Org chart SVG renderer with 5 visual styles (`server/src/routes/org-chart-svg.ts`)
- `accessService.hasPermission()` with `principal_permission_grants`
- Client-side org chart in `ui/src/pages/OrgChart.tsx`

What does NOT exist:
- No department or team tables
- No department-scoped visibility
- No department memberships
- No `department_id` on issues, projects, or agents

## 3. Architecture Decisions

### 3.1 Departments vs Teams

- **Department** = organizational unit with hierarchy (Engineering → Backend, Frontend)
- **Team** = cross-functional group within a department (optional, simpler)
- Both use the same membership pattern as `company_memberships` (principal-based)

### 3.2 Hierarchy

- Departments support `parent_id` (self-referential) for nesting
- Max depth: not enforced in schema, but cycle detection required (same pattern as `agents.reportsTo`)
- Teams are flat (no hierarchy) — belong to one department

### 3.3 Scoping

- `department_id` added as nullable FK to `issues`, `projects`, and `agents`
- Phase 1 does NOT enforce department-scoped visibility (that's Phase 2 RBAC)
- Phase 1 only adds the data model and UI for organizing

## 4. Implementation Tasks

### Sprint 1 (Apr 14–28): Schema + API

#### Task 1.1: Database Schema (PEV-2)

**Files to create:**
- `packages/db/src/schema/departments.ts`
- `packages/db/src/schema/teams.ts`
- `packages/db/src/schema/department_memberships.ts`
- `packages/db/src/schema/team_memberships.ts`
- `packages/db/src/migrations/0053_departments_and_teams.sql`

**Schema: `departments`**
```sql
CREATE TABLE "departments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" text NOT NULL,
  "description" text,
  "parent_id" uuid REFERENCES "departments"("id"),
  "status" text NOT NULL DEFAULT 'active',
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "departments_company_name_uq" ON "departments" ("company_id", "name");
CREATE INDEX "departments_company_parent_idx" ON "departments" ("company_id", "parent_id");
CREATE INDEX "departments_company_status_idx" ON "departments" ("company_id", "status");
```

**Schema: `teams`**
```sql
CREATE TABLE "teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "department_id" uuid REFERENCES "departments"("id"),
  "name" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "teams_company_name_uq" ON "teams" ("company_id", "name");
CREATE INDEX "teams_company_department_idx" ON "teams" ("company_id", "department_id");
```

**Schema: `department_memberships`**
```sql
CREATE TABLE "department_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "department_id" uuid NOT NULL REFERENCES "departments"("id"),
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "dept_memberships_dept_principal_uq"
  ON "department_memberships" ("department_id", "principal_type", "principal_id");
CREATE INDEX "dept_memberships_company_dept_idx"
  ON "department_memberships" ("company_id", "department_id");
```

**Schema: `team_memberships`**
```sql
CREATE TABLE "team_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "team_memberships_team_principal_uq"
  ON "team_memberships" ("team_id", "principal_type", "principal_id");
CREATE INDEX "team_memberships_company_team_idx"
  ON "team_memberships" ("company_id", "team_id");
```

**Schema alterations: add `department_id` to existing tables**
```sql
ALTER TABLE "agents" ADD COLUMN "department_id" uuid REFERENCES "departments"("id");
CREATE INDEX "agents_department_idx" ON "agents" ("department_id");

ALTER TABLE "projects" ADD COLUMN "department_id" uuid REFERENCES "departments"("id");
CREATE INDEX "projects_department_idx" ON "projects" ("department_id");

ALTER TABLE "issues" ADD COLUMN "department_id" uuid REFERENCES "departments"("id");
CREATE INDEX "issues_department_idx" ON "issues" ("department_id");
```

**Update schema index:**
- Add exports to `packages/db/src/schema/index.ts`

**Drizzle schema files** follow existing pattern:
- UUID primary keys with `defaultRandom()`
- Timestamps with `{ withTimezone: true }`
- `AnyPgColumn` for self-referential `parent_id`
- Indexes named `{table}_{columns}_idx` / `{table}_{columns}_uq`

**Validation:** Run `pnpm db:generate` and verify migration output matches expected SQL.

---

#### Task 1.2: Shared Types and Validation (PEV-2 continuation)

**Files to create:**
- `packages/shared/src/types/department.ts`
- `packages/shared/src/types/team.ts`

**Types:**
```typescript
// department.ts
export interface Department {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  parentId: string | null;
  status: "active" | "archived";
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentTree extends Department {
  children: DepartmentTree[];
  memberCount: number;
}

export interface DepartmentMembership {
  id: string;
  companyId: string;
  departmentId: string;
  principalType: "user" | "agent";
  principalId: string;
  role: "member" | "lead" | "manager";
  createdAt: string;
}

// Zod schemas for validation
export const createDepartmentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  parentId: z.string().uuid().nullable().optional(),
});

export const updateDepartmentSchema = createDepartmentSchema.partial();

export const addMemberSchema = z.object({
  principalType: z.enum(["user", "agent"]),
  principalId: z.string().min(1),
  role: z.enum(["member", "lead", "manager"]).default("member"),
});
```

---

#### Task 1.3: Service Layer (PEV-3 prerequisite)

**Files to create:**
- `server/src/services/departments.ts`
- `server/src/services/teams.ts`

**Department service methods:**

| Method | Signature | Notes |
|--------|-----------|-------|
| `list` | `(companyId: string) → Department[]` | Flat list, all departments |
| `tree` | `(companyId: string) → DepartmentTree[]` | Recursive tree with member counts |
| `getById` | `(id: string) → Department \| null` | Single department |
| `create` | `(companyId, data) → Department` | Validate unique name, parent exists in same company |
| `update` | `(id, data) → Department` | Cycle detection if parentId changes |
| `archive` | `(id) → Department` | Set status=archived, don't delete |
| `addMember` | `(deptId, principalType, principalId, role) → Membership` | Validate principal exists in company |
| `removeMember` | `(deptId, principalType, principalId) → void` | |
| `listMembers` | `(deptId) → Membership[]` | With principal details joined |

**Key business rules:**
1. Department name unique per company (enforced by DB unique index)
2. Cycle detection for parent changes (same algorithm as `agents.assertNoCycle`)
3. Cannot archive department with active sub-departments (must archive children first or reparent)
4. Activity logging on all mutations (`logActivity`)

**Team service:** Same pattern but simpler (no hierarchy, belongs to optional department).

**Update service index:** Add exports to `server/src/services/index.ts`.

---

#### Task 1.4: API Endpoints (PEV-3)

**Files to create:**
- `server/src/routes/departments.ts`
- `server/src/routes/teams.ts`

**Department endpoints:**
```
GET    /companies/:companyId/departments           → list (flat)
GET    /companies/:companyId/departments/tree       → tree (recursive with counts)
POST   /companies/:companyId/departments            → create
GET    /departments/:id                             → getById
PATCH  /departments/:id                             → update
POST   /departments/:id/archive                     → archive
POST   /departments/:id/members                     → addMember
DELETE /departments/:id/members/:principalType/:principalId → removeMember
GET    /departments/:id/members                     → listMembers
```

**Team endpoints:**
```
GET    /companies/:companyId/teams                  → list
POST   /companies/:companyId/teams                  → create
GET    /teams/:id                                   → getById
PATCH  /teams/:id                                   → update
POST   /teams/:id/members                           → addMember
DELETE /teams/:id/members/:principalType/:principalId → removeMember
GET    /teams/:id/members                           → listMembers
```

**Route registration:**
- Add `export { departmentRoutes } from "./departments.js"` to `server/src/routes/index.ts`
- Add `api.use(departmentRoutes(db))` to `server/src/app.ts` after line 154
- Same for teamRoutes

**Pattern:** Follow `agentRoutes(db)` exactly — factory function, `assertCompanyAccess`, validation middleware, activity logging.

---

### Sprint 2 (Apr 28–May 12): UI + Org Chart + Tests

#### Task 2.1: API Client (PEV-4 prerequisite)

**Files to create:**
- `ui/src/api/departments.ts`
- `ui/src/api/teams.ts`

**Pattern:** Follow `ui/src/api/agents.ts` — typed fetch functions using the shared `client.ts`.

**Query keys:** Add to `ui/src/lib/queryKeys.ts`:
```typescript
departments: {
  list: (companyId: string) => ["departments", companyId],
  tree: (companyId: string) => ["departments", companyId, "tree"],
  detail: (id: string) => ["department", id],
  members: (id: string) => ["department", id, "members"],
},
teams: {
  list: (companyId: string) => ["teams", companyId],
  detail: (id: string) => ["team", id],
  members: (id: string) => ["team", id, "members"],
},
```

---

#### Task 2.2: Department Management UI (PEV-4)

**Files to create:**
- `ui/src/pages/Departments.tsx` — list page with tree view
- `ui/src/pages/DepartmentDetail.tsx` — detail with members, sub-departments
- `ui/src/components/DepartmentTree.tsx` — recursive tree component
- `ui/src/components/NewDepartmentDialog.tsx` — create/edit form
- `ui/src/components/AddMemberDialog.tsx` — add member to department

**List page features:**
- Tree view (collapsible, like file explorer) as default
- Flat list view as alternative
- Member count badges
- Status indicators (active/archived)
- "New department" button → dialog
- Click row → navigate to detail

**Detail page features:**
- Header: name, description, parent breadcrumb
- Tab: Members (list with role badges, add/remove)
- Tab: Sub-departments (if any)
- Tab: Issues (issues with this department_id)
- Tab: Agents (agents with this department_id)
- Edit button → inline edit or dialog

**Route registration in `ui/src/App.tsx`:**
```
/departments → Departments list
/departments/:departmentId → DepartmentDetail
/departments/:departmentId/:tab → DepartmentDetail with tab
```

**Sidebar:** Add "Departments" link to sidebar in `ui/src/components/Layout.tsx`, under the company section (after Projects).

---

#### Task 2.3: Org Chart Expansion (PEV-5)

**Files to modify:**
- `server/src/routes/org-chart-svg.ts` — add department grouping
- `ui/src/pages/OrgChart.tsx` — add department containers

**Changes:**

Server-side SVG:
- Query departments and their agent memberships
- Group agents by department in the tree layout
- Render department as a container/group node with label
- Agents without department remain at root level
- Department background color (configurable per department or auto-assigned)

Client-side:
- New node type in `OrgNode`: `type: "department" | "agent"`
- Department nodes render as larger cards with member count
- Expand/collapse department to show/hide member agents
- Optional: department-only view (hide individual agents)

**API change:**
- Extend `GET /companies/:companyId/org` to include department grouping
- Add query param `?groupBy=department` for backwards compatibility

---

#### Task 2.4: Tests (PEV-6)

**Files to create:**
- `server/src/__tests__/departments.test.ts`
- `server/src/__tests__/teams.test.ts`

**Test cases for departments:**

| Category | Test |
|----------|------|
| CRUD | Create department with valid data |
| CRUD | Create department with duplicate name → 422 |
| CRUD | Update department name |
| CRUD | Archive department |
| Hierarchy | Create sub-department with parentId |
| Hierarchy | Move department (change parentId) |
| Hierarchy | Cycle detection: A→B→A |
| Hierarchy | Cycle detection: A→B→C→A |
| Hierarchy | Cannot set parentId to self |
| Hierarchy | Cannot archive department with active children |
| Membership | Add user member |
| Membership | Add agent member |
| Membership | Remove member |
| Membership | Duplicate membership → 422 |
| Membership | Member role: lead, manager |
| Scoping | Create issue with department_id |
| Scoping | Assign agent to department |
| Boundary | Department must belong to same company as parent |
| Boundary | Member principal must exist in same company |
| Tree | Tree endpoint returns nested structure |
| Tree | Tree includes member counts |

**Test cases for teams:** Similar subset (no hierarchy).

**Pattern:** Follow existing tests — Vitest, embedded Postgres, async/await.

## 5. Dependency Graph

```
PEV-2 (Schema)
  ↓
PEV-3 (API) ← blocked_by PEV-2
  ↓
PEV-4 (UI) ← blocked_by PEV-3
  ↓
PEV-5 (Org Chart) ← blocked_by PEV-3 (needs API data)
  ↓
PEV-6 (Tests) ← can start with PEV-3, covers PEV-2+3+4
```

## 6. Files Changed Summary

| Package | New Files | Modified Files |
|---------|-----------|----------------|
| `packages/db` | 5 (4 schema + 1 migration) | 1 (`schema/index.ts`) |
| `packages/shared` | 2 (types) | 1 (`types/index.ts`) |
| `server` | 4 (2 routes + 2 services) | 3 (`routes/index.ts`, `services/index.ts`, `app.ts`) |
| `ui` | 7 (2 pages + 3 components + 2 API) | 3 (`App.tsx`, `Layout.tsx`, `queryKeys.ts`) |
| Tests | 2 | 0 |
| **Total** | **20 new** | **8 modified** |

## 7. Acceptance Criteria

Phase 1 is done when:

1. `departments` and `teams` tables exist with all indexes
2. CRUD API for departments and teams works with validation
3. Department hierarchy (parent/child) works with cycle detection
4. Members (users + agents) can be added/removed from departments and teams
5. Agents, projects, and issues can be assigned a `department_id`
6. UI shows department tree, detail page with members
7. Org chart shows agents grouped by department
8. All test cases pass
9. No regressions in existing tests

## 8. What Phase 1 Does NOT Do

- No department-scoped visibility enforcement (Phase 2)
- No department-scoped permissions (Phase 2)
- No SLA per department (Phase 3)
- No department-based reporting (Phase 4)
- No department budget policies (future)

## 9. Risks

| Risk | Mitigation |
|------|------------|
| Org chart SVG renderer is 1000+ lines | Only add grouping, don't refactor renderer |
| Migration on existing tables (agents, projects, issues) | Nullable column addition = safe, no data migration needed |
| Cycle detection complexity | Reuse `agents.assertNoCycle` pattern verbatim |
| UI complexity for tree view | Start with simple collapsible list, not drag-and-drop |
