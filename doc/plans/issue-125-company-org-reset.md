# Plan: Company Org Reset (Issue #125)

## Context

Allow users to reset a company org structure to start fresh, wiping all agents, projects, and issues while preserving the company itself.

**Use Cases:**

- Company import with bad data that needs cleanup
- Starting over with org structure after failed migration
- Fresh start without deleting and recreating the company

## Scope of Reset

These are DELETED:

- All agents (`agents` table)
- All projects (`projects` table)
- All goals (`goals` table)
- All issues (`issues` table)
- All routines (`routines`, `routine_triggers`, `routine_runs`)
- All company skills (`company_skills`)
- All labels (`labels`)
- All budgets (`budget_policies`, `budget_incidents`)
- All company secrets (`company_secrets`)
- All company memberships (`company_memberships`)
- All invites (`invites`, `join_requests`)
- All approvals (`approvals`, `approval_comments`)
- All cost/finance events (`cost_events`, `finance_events`)
- All heartbeat runs and events (`heartbeat_runs`, `heartbeat_run_events`)
- All agent sessions and state (`agent_task_sessions`, `agent_runtime_state`, `agent_wakeup_requests`)
- All agent API keys (`agent_api_keys`)
- All assets and documents (`assets`, `documents`, `document_revisions`)
- All feedback (`feedback_votes`, `feedback_exports`)
- All activity log entries (`activity_log`)

These are PRESERVED:

- The company itself (`companies` table)
- Company logo (`company_logos`)
- Company settings (branding, billing, etc.)
- Board membership (company_memberships where role = 'board')

## Files to Modify

| File                                        | Purpose                              |
| ------------------------------------------- | ------------------------------------ |
| `packages/shared/src/types/company.ts`      | Add `CompanyResetRequest` type       |
| `packages/shared/src/validators/company.ts` | Add `companyResetRequestSchema`      |
| `server/src/services/companies.ts`          | Add `reset` method to companyService |
| `server/src/routes/companies.ts`            | Add `POST /:companyId/reset` route   |

## API Design

### Request

```typescript
interface CompanyResetRequest {
  confirmCompanyName: string; // Must match company.name exactly
}
```

### Response

```typescript
interface CompanyResetResult {
  company: Company;
  deletedCounts: {
    agents: number;
    projects: number;
    issues: number;
    goals: number;
    routines: number;
    skills: number;
    budgets: number;
    secrets: number;
  };
}
```

### Route

```
POST /api/companies/:companyId/reset
Authorization: Board member or CEO agent
Body: { confirmCompanyName: string }
```

## Safety Requirements

1. **Company name verification**: User must type exact company name to confirm
2. **Authorization**: Only board members or CEO agents can reset
3. **Transaction**: All deletions happen in a single DB transaction (all or nothing)
4. **Audit logging**: Log the reset action with deleted counts

## Implementation

### Step 1: Add Type Definition

In `packages/shared/src/types/company.ts`, add:

```typescript
export interface CompanyResetRequest {
  confirmCompanyName: string;
}

export interface CompanyResetDeletedCounts {
  agents: number;
  projects: number;
  goals: number;
  issues: number;
  routines: number;
  skills: number;
  labels: number;
  budgets: number;
  secrets: number;
}

export interface CompanyResetResult {
  company: Company;
  deletedCounts: CompanyResetDeletedCounts;
}
```

### Step 2: Add Validator

In `packages/shared/src/validators/company.ts`, add validation for `confirmCompanyName`.

### Step 3: Add Service Method

In `server/src/services/companies.ts`, add `reset(id, confirmName)` method:

- Verify company exists
- Verify `confirmName === company.name`
- Count records to be deleted
- Delete all org data in transaction
- Log activity
- Return company + deleted counts

### Step 4: Add Route

In `server/src/routes/companies.ts`, add route:

- `assertCompanyAccess` - user must have access
- `assertBoard` - only board can reset org
- Call `companyService.reset()`
- Return result

### Step 5: Add UI (optional, can skip for API-only)

For now, implement API-only. UI can be added later.

## Verification

1. Start dev server: `pnpm dev`
2. Create a test company with agents, projects, issues
3. Call `POST /api/companies/:id/reset` with wrong name → should fail
4. Call with correct name → should succeed
5. Verify company still exists but org data is gone
