# Sprint 5: SLA Engine and Schema

Status: Draft
Date: 2026-04-10
Plane: Cycle `c87131eb-c04e-40c7-86fb-30beec6ff061` (Sprint 5 - SLA Engine and Schema)
Window: Jun 9 – Jun 23 2026
Depends on: Sprint 4 (Phase 2 RBAC UI + route enforcement)
Module: Phase 3 — SLA & Deadline Operations (`4b18aeaa-e9ff-4e23-9767-75edfbf6efae`)
Related:
- `doc/plans/2026-04-08-phase2-department-rbac-plan.md`
- `doc/plans/2026-04-08-paperclip-capability-audit.md`
- Plane issues: PEV-12 (EPIC), PEV-13 (schema), PEV-14 (engine)

## 1. Goal

Add deadline and SLA foundations to issues — the third highest-priority product gap identified in the capability audit. This sprint covers schema + service + API (backend only). UI comes in Sprint 6.

After Sprint 4, departments are operational boundaries with RBAC. What is still missing:

- several routes remain on legacy permission checks
- issues have no concept of deadlines or time-based urgency
- there is no mechanism for SLA breach detection or escalation
- the inbox has no temporal awareness (approaching deadlines, overdue work)

This sprint has two halves:

- **Half A** — Phase 2 cleanup: remaining route enforcement, legacy check migration, and documentation
- **Half B** — SLA foundations: due dates, SLA policies, breach detection, and inbox/UI surfacing

## 2. Why This Slice Next

From the capability audit (section 7), the recommended roadmap after RBAC is:

> 3. Add SLA, due-date, and escalation mechanics to issues and inbox flows.

This is the highest-leverage next feature because:

- priority already exists (`critical`, `high`, `medium`, `low`) but has no time dimension
- issues track `startedAt` and `completedAt` but have no target dates
- the inbox exists but has no urgency signals
- without deadlines, autonomous agents have no time pressure and operators have no visibility into lateness
- combining Phase 2 cleanup with SLA keeps the sprint from being pure tech-debt

## 3. Current State

### 3.1 What exists

Issues already have:

- 7 workflow states with auto-timestamping (`startedAt`, `completedAt`, `cancelledAt`)
- 4 priority levels
- blocking/blocked-by relations
- inbox with read states and per-user archiving
- activity timeline with all state changes
- execution workflow (checkout/release, review, approval)

### 3.2 What does not exist

- no `due_date` or `deadline` column on issues
- no SLA policy definitions
- no SLA breach calculation or detection
- no deadline-approaching notifications
- no overdue indicators in the inbox or issue lists
- no escalation rules
- incomplete RBAC enforcement on untouched routes (costs, budgets, routines, plugin management, storage admin)

## 4. Scope

### 4.1 In scope

**Phase 2 cleanup:**

- migrate remaining touched-but-not-enforced routes to shared access helpers
- add RBAC enforcement to cost/budget read paths (view-only scoping by department)
- document which routes are fully RBAC-aware vs still legacy
- update `doc/` with RBAC semantics guide for operators

**SLA foundations:**

- `due_date` column on issues
- `sla_policies` table for company-level SLA rules by priority
- SLA target calculation from priority + policy
- breach detection (overdue status determination)
- `overdue` virtual flag on issue list/detail responses
- due date picker in issue creation and properties UI
- overdue badge/indicator in issue lists and inbox
- "approaching deadline" and "overdue" inbox awareness
- activity log entries for SLA breach events

### 4.2 Out of scope

- automated escalation chains (reassignment, manager notification)
- SLA reporting dashboards or exports
- per-department SLA policies (future — needs RBAC policy layer)
- external notification channels (email, Slack, webhook alerts)
- custom SLA fields beyond priority-based rules
- SLA on projects or goals (issues only for now)

## 5. Architecture Decisions

### 5.1 Due date is a first-class column, not metadata

Add `due_date` as a nullable timestamp column on `issues`. This allows:

- SQL-level ordering and filtering
- index-based overdue queries
- clean API surface without JSON parsing

### 5.2 SLA policies define target resolution time by priority

SLA policies are company-scoped rules that map priority levels to target resolution hours.

```ts
interface SlaPolicy {
  id: string;
  companyId: string;
  name: string;
  isDefault: boolean;
  rules: SlaRule[];
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface SlaRule {
  priority: "critical" | "high" | "medium" | "low";
  targetHours: number;        // hours from creation to completion
  warningHours: number | null; // hours before due_date to flag as "approaching"
}
```

### 5.3 Due date can be explicit or SLA-derived

Two ways a due date can be set:

1. **Explicit** — operator or agent sets `due_date` directly on the issue
2. **SLA-derived** — when an issue is created with a priority and no explicit due date, the default SLA policy calculates `due_date = created_at + targetHours`

Explicit due dates always take precedence. SLA-derived dates are marked with `slaAutoSet: true` so operators know the origin.

### 5.4 Overdue is a computed property, not a stored state

Do not add an `overdue` status to the workflow states. Instead:

- compute `isOverdue = due_date IS NOT NULL AND due_date < NOW() AND status NOT IN ('done', 'cancelled')`
- compute `isApproaching = due_date IS NOT NULL AND due_date - warning_interval < NOW() AND NOT isOverdue`
- return these as virtual flags in API responses

This avoids a background job to flip status and keeps the source of truth simple.

### 5.5 Breach events are logged, not stored as separate entities

When the system detects an overdue transition (issue was not overdue, now is), log an activity event:

```
type: "sla_breach"
details: { dueDate, currentStatus, hoursOverdue }
```

This reuses the existing activity log infrastructure without a new table.

### 5.6 Inbox gets temporal sorting option

Add an inbox sort mode: `sort=urgency` that orders by:

1. overdue issues (most overdue first)
2. approaching deadline
3. recently updated (current default)

This makes the inbox time-aware without changing its data model.

## 6. Data Model Changes

### 6.1 Alter `issues` table

```sql
ALTER TABLE "issues" ADD COLUMN "due_date" timestamp with time zone;
ALTER TABLE "issues" ADD COLUMN "sla_auto_set" boolean NOT NULL DEFAULT false;
CREATE INDEX "issues_due_date_idx" ON "issues" ("due_date") WHERE "due_date" IS NOT NULL;
CREATE INDEX "issues_overdue_idx" ON "issues" ("due_date", "status")
  WHERE "due_date" IS NOT NULL AND "status" NOT IN ('done', 'cancelled');
```

### 6.2 New table: `sla_policies`

```sql
CREATE TABLE "sla_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" text NOT NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "sla_policies_company_default_uq"
  ON "sla_policies" ("company_id") WHERE "is_default" = true;
CREATE INDEX "sla_policies_company_status_idx"
  ON "sla_policies" ("company_id", "status");
```

### 6.3 New table: `sla_policy_rules`

```sql
CREATE TABLE "sla_policy_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "policy_id" uuid NOT NULL REFERENCES "sla_policies"("id") ON DELETE CASCADE,
  "priority" text NOT NULL,
  "target_hours" integer NOT NULL,
  "warning_hours" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "sla_rules_policy_priority_uq"
  ON "sla_policy_rules" ("policy_id", "priority");
```

### 6.4 Migration

File: `packages/db/src/migrations/NNNN_sla_and_deadlines.sql`

Migration adds:
- `due_date` and `sla_auto_set` columns to issues
- `sla_policies` table
- `sla_policy_rules` table
- indexes

## 7. Shared Contracts

### 7.1 Types to add

File: `packages/shared/src/types/sla.ts`

- `SlaPolicy`
- `SlaPolicyRule`
- `SlaStatus` = `"ok"` | `"approaching"` | `"breached"`
- `IssueSlaInfo` — the virtual SLA data returned with issue responses

### 7.2 Types to update

File: `packages/shared/src/types/issue.ts`

- Add `dueDate: Date | null` to `Issue`
- Add `slaAutoSet: boolean` to `Issue`
- Add `slaStatus?: SlaStatus` to issue list/detail response types

File: `packages/shared/src/validators/issue.ts`

- Add `dueDate` to create/update schemas (optional, nullable ISO date string)

## 8. Service Layer

### 8.1 New: `slaService`

File: `server/src/services/sla.ts`

Methods:

| Method | Purpose |
|--------|---------|
| `getDefaultPolicy(companyId)` | Return active default SLA policy with rules |
| `listPolicies(companyId)` | List all SLA policies |
| `createPolicy(companyId, data)` | Create policy with rules |
| `updatePolicy(policyId, data)` | Update policy name/rules |
| `archivePolicy(policyId)` | Archive policy |
| `calculateDueDate(createdAt, priority, policy)` | Compute due date from SLA rules |
| `computeSlaStatus(issue)` | Return `ok`, `approaching`, or `breached` |

### 8.2 Update: `issuesService`

- On issue creation: if no explicit `due_date` and default SLA policy exists, auto-calculate and set `sla_auto_set = true`
- On issue priority change: if `sla_auto_set = true`, recalculate due date from new priority
- On issue completion: no SLA recalculation needed (overdue is computed from current time)

### 8.3 Update: `issuesRoutes`

- Include `slaStatus` in issue list and detail responses
- Add `due_date` to issue create/update payloads
- Add `sort=due_date` and `sort=urgency` options to list endpoint
- Add `overdue=true` filter to list endpoint

## 9. API Plan

### 9.1 SLA policy endpoints

```
GET    /companies/:companyId/sla-policies          → list
POST   /companies/:companyId/sla-policies          → create
GET    /sla-policies/:id                           → detail
PATCH  /sla-policies/:id                           → update
POST   /sla-policies/:id/archive                   → archive
```

Permission: `users:manage_permissions` (admin-level) for mutations, any company member for reads.

### 9.2 Issue endpoint changes

```
PATCH  /issues/:id   — now accepts { dueDate }
POST   /companies/:companyId/issues  — now accepts { dueDate }
GET    /companies/:companyId/issues  — now accepts ?sort=due_date&overdue=true
```

## 10. UI Plan

### 10.1 Issue properties

Add to `IssueProperties.tsx`:

- Due date field with date picker
- SLA status badge: green (ok), yellow (approaching), red (breached)
- "Auto-set by SLA" indicator when `slaAutoSet` is true
- Click due date to edit, clear to remove

### 10.2 Issue lists

Add to `IssuesList.tsx` and `Issues.tsx`:

- Due date column (optional, togglable)
- Overdue indicator (red dot or badge on issue row)
- Sort option: "Due date" and "Urgency"
- Filter: "Overdue only"

### 10.3 Inbox

Add to `Inbox.tsx`:

- Sort option: "Urgency" (overdue first, then approaching, then recent)
- Overdue/approaching badges on issue rows
- Visual urgency: overdue items get a subtle red left border or background

### 10.4 New issue dialog

Add to `NewIssueDialog.tsx`:

- Optional due date picker
- Hint text: "Leave blank to auto-set from SLA policy" (when company has a default policy)

### 10.5 SLA settings page

Create `ui/src/pages/SlaSettings.tsx`:

- Accessible from company settings or a new "Policies" section
- Show default SLA policy with rules table (priority → target hours, warning hours)
- Create/edit policy dialog
- Set/unset default policy

Route: `/settings/sla` or `/policies/sla`

### 10.6 Issue detail

Add to `IssueDetail.tsx`:

- Due date in header area or properties sidebar
- SLA breach event in activity timeline
- Visual indicator when issue is overdue

## 11. Phase 2 Cleanup Tasks

### 11.1 Route enforcement audit

Create a route coverage checklist:

| Route file | RBAC status | Sprint 5 action |
|------------|-------------|-----------------|
| `access.ts` | ✅ Enforced | — |
| `departments.ts` | ✅ Enforced | — |
| `teams.ts` | ✅ Enforced | — |
| `issues.ts` | ✅ Enforced | — |
| `projects.ts` | ✅ Enforced | — |
| `agents.ts` | 🔄 Partial | Finish read-path scoping |
| `activity.ts` | 🔄 Partial | Scope activity by department visibility |
| `costs.ts` | ❌ Legacy | Add `departments:view` scoping on reads |
| `budgets.ts` | ❌ Legacy | Add `departments:view` scoping on reads |
| `routines.ts` | ❌ Legacy | Defer to future sprint |
| `plugins.ts` | ❌ Legacy | Defer to future sprint |
| `storage.ts` | ❌ Legacy | Defer to future sprint |

### 11.2 Documentation

Create: `doc/RBAC.md`

Contents:
- system role definitions and their permission bundles
- department scope semantics (null = company-wide only)
- how direct grants and role-derived grants combine
- which routes are RBAC-enforced vs legacy
- operator guide for assigning roles via the AccessControl UI

## 12. Execution Order

### Week 1 (Apr 28 – May 5)

**Day 1-2: Phase 2 cleanup**

1. Audit all routes for RBAC coverage status
2. Migrate agent read paths to scoped access helpers
3. Add department-scoped filtering to activity and cost read routes
4. Write `doc/RBAC.md`

**Day 3-4: SLA schema + contracts**

5. Create migration: `due_date` + `sla_auto_set` on issues, `sla_policies`, `sla_policy_rules`
6. Create Drizzle schema files
7. Add shared types: `SlaPolicy`, `SlaPolicyRule`, `SlaStatus`, `IssueSlaInfo`
8. Update issue types and validators with `dueDate`

**Day 5: SLA service layer**

9. Create `slaService` with policy CRUD and due date calculation
10. Update `issuesService` for auto-set due date on create and priority change
11. Add `computeSlaStatus` helper

### Week 2 (May 5 – May 12)

**Day 1-2: SLA API + issue route updates**

12. Add SLA policy CRUD endpoints
13. Update issue create/update to accept `dueDate`
14. Add `slaStatus` to issue list/detail responses
15. Add `sort=due_date`, `sort=urgency`, `overdue=true` to issue list

**Day 3-4: UI changes**

16. Add due date picker to issue properties and new issue dialog
17. Add overdue badge to issue lists and inbox
18. Add urgency sort to inbox
19. Create SLA settings page
20. Add SLA breach event to activity timeline

**Day 5: Tests + verification**

21. Server tests: SLA service, policy routes, overdue computation, auto-set on create
22. Server tests: phase 2 cleanup routes (scoped costs, scoped activity)
23. UI tests: due date picker, overdue badges, SLA settings page
24. Full repo verification: `pnpm -r typecheck && pnpm test:run && pnpm build`

## 13. Tests

### 13.1 SLA service tests

File: `server/src/__tests__/sla-service.test.ts`

- create default SLA policy with rules
- calculate due date from critical priority → shortest target
- calculate due date from low priority → longest target
- no default policy → no auto-set
- explicit due date overrides SLA calculation
- priority change recalculates SLA-derived due date
- priority change does not touch explicit due date
- `computeSlaStatus` returns `ok` when before warning threshold
- `computeSlaStatus` returns `approaching` when within warning window
- `computeSlaStatus` returns `breached` when past due date
- completed issue always returns `ok` regardless of due date

### 13.2 SLA route tests

File: `server/src/__tests__/sla-routes.test.ts`

- CRUD policy endpoints
- only one default policy per company
- archive policy
- issue creation with auto-set due date
- issue creation with explicit due date
- issue list with `sort=due_date`
- issue list with `overdue=true` filter

### 13.3 Phase 2 cleanup tests

- cost read routes respect department scope
- activity routes respect department scope
- agent read paths enforce department-scoped visibility

## 14. Default SLA Policy Seed

When a company first accesses SLA settings or optionally on company creation, seed a reasonable default:

| Priority | Target hours | Warning hours |
|----------|-------------|---------------|
| Critical | 4 | 1 |
| High | 24 | 4 |
| Medium | 72 | 24 |
| Low | 168 (1 week) | 48 |

This can be adjusted per company. The seed values reflect typical operational SLA targets for an autonomous agent workforce.

## 15. Risks

| Risk | Mitigation |
|------|------------|
| SLA auto-set overwrites intentionally blank due dates | `sla_auto_set` flag distinguishes; clearing due date sets flag to false |
| Overdue computation at query time is slow on large tables | Partial index on `(due_date, status)` keeps it fast |
| Feature creep into escalation chains | Strictly out of scope — log breach events only |
| Phase 2 cleanup takes longer than planned | Cut to route audit + docs only; defer cost/budget scoping |

## 16. Acceptance Criteria

Sprint 5 is done when all are true:

1. Route coverage checklist documented; agent/activity/cost reads are RBAC-scoped
2. `doc/RBAC.md` exists with operator guidance
3. Issues support `due_date` in create, update, and list responses
4. Default SLA policy can be created and managed per company
5. Issues auto-receive `due_date` from SLA policy when created without explicit deadline
6. Issue list and detail responses include `slaStatus` (ok/approaching/breached)
7. Issue list supports `sort=due_date`, `sort=urgency`, and `overdue=true` filter
8. UI shows due date picker, overdue badges, and urgency sort in inbox
9. SLA settings page exists for managing policies
10. SLA breach is logged as an activity event
11. All tests pass: `pnpm -r typecheck && pnpm test:run && pnpm build`

## 17. What Sprint 5 Does NOT Do

- No escalation automation (auto-reassign, manager notification)
- No external alerts (email, Slack, webhooks for breaches)
- No per-department SLA policies
- No SLA reporting or analytics
- No SLA on projects or goals
- No full route enforcement for routines, plugins, storage
- No calendar UI for deadline visualization

## 18. Cut Line

If time gets tight, the must-ship line is:

1. `due_date` column and API support
2. SLA auto-set from default policy
3. overdue computation in list/detail responses
4. due date picker in UI
5. overdue badge in issue list
6. `doc/RBAC.md`

These can be deferred:

- SLA settings page (seed default only, manage via API)
- inbox urgency sort
- cost/budget route scoping
- activity timeline breach events
- approaching-deadline warning (ship overdue only)
