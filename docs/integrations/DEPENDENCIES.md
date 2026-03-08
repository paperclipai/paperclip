# Issue Dependencies (Blocking Tasks)

## Problem

Paperclip lacks a built-in mechanism for **task dependencies** (blocking tasks), where a task cannot be started until its blocking tasks are completed.

**Current System (OpenCode Agent Swarm):**
- `blockedBy` field in `active-tasks.json`
- `dependency-manager.sh` checks blockers
- `check-agents.sh` auto-spawns when blockers done

**Paperclip (Missing):**
- Only has `status: "blocked"` (manual)
- No `blockedBy` relationship table
- No auto-unblock logic

---

## Solution: Add `issue_dependencies` Table

### Database Schema

```sql
-- New table: issue_dependencies
CREATE TABLE issue_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  blocked_by_issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(issue_id, blocked_by_issue_id),
  INDEX idx_issue_deps_issue ON issue_id,
  INDEX idx_issue_deps_blocked_by ON blocked_by_issue_id
);
```

### Drizzle ORM Schema

```typescript
// packages/db/src/schema/issue_dependencies.ts
import { pgTable, uuid, timestamp, index, foreignKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueDependencies = pgTable(
  "issue_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    blockedByIssueId: uuid("blocked_by_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_deps_issue_idx").on(table.issueId),
    blockedByIdx: index("issue_deps_blocked_by_idx").on(table.blockedByIssueId),
    uniqueConstraint: uniqueIndex("issue_deps_unique").on(table.issueId, table.blockedByIssueId),
  }),
);
```

---

## API Endpoints

### Add Dependency

```http
POST /api/issues/{issueId}/dependencies
{
  "blockedByIssueId": "uuid-of-blocker"
}

Response:
{
  "id": "dep-uuid",
  "issueId": "issue-uuid",
  "blockedByIssueId": "blocker-uuid"
}
```

### Remove Dependency

```http
DELETE /api/issues/{issueId}/dependencies/{blockedByIssueId}
```

### List Dependencies

```http
GET /api/issues/{issueId}/dependencies

Response:
{
  "issueId": "issue-uuid",
  "blockedBy": [
    { "id": "blocker-1", "title": "Task 1", "status": "done" },
    { "id": "blocker-2", "title": "Task 2", "status": "in_progress" }
  ],
  "allDone": false
}
```

### Check If Can Proceed

```http
GET /api/issues/{issueId}/can-proceed

Response:
{
  "canProceed": false,
  "pendingBlockers": [
    { "id": "blocker-2", "title": "Task 2", "status": "in_progress" }
  ]
}
```

---

## Business Logic

### On Issue Status Change

```typescript
// In issues.ts service

async function updateIssueStatus(issueId: string, newStatus: string) {
  const issue = await getIssue(issueId);
  
  // If moving to in_progress, check blockers
  if (newStatus === "in_progress") {
    const { canProceed, pendingBlockers } = await checkBlockers(issueId);
    if (!canProceed) {
      throw unprocessable(
        `Cannot start task: blocked by ${pendingBlockers.length} incomplete task(s)`,
        { pendingBlockers }
      );
    }
  }
  
  // Update status
  await updateStatus(issueId, newStatus);
  
  // If task is done, check if it unblocks other tasks
  if (newStatus === "done") {
    await checkAndNotifyUnblockedTasks(issueId);
  }
}

async function checkBlockers(issueId: string) {
  const dependencies = await db
    .select()
    .from(issueDependencies)
    .where(eq(issueDependencies.issueId, issueId))
    .innerJoin(issues, eq(issueDependencies.blockedByIssueId, issues.id));
  
  const pendingBlockers = dependencies.filter(d => d.status !== "done");
  
  return {
    canProceed: pendingBlockers.length === 0,
    pendingBlockers
  };
}

async function checkAndNotifyUnblockedTasks(completedIssueId: string) {
  // Find all issues that were blocked by this issue
  const unblockedIssues = await db
    .select({ issueId: issueDependencies.issueId })
    .from(issueDependencies)
    .where(eq(issueDependencies.blockedByIssueId, completedIssueId))
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.status, "blocked"));
  
  for (const { issueId } of unblockedIssues) {
    // Check if ALL blockers are now done
    const { canProceed } = await checkBlockers(issueId);
    if (canProceed) {
      // Update status to todo (ready to be picked up)
      await updateStatus(issueId, "todo");
      
      // Notify assignee (if any)
      const issue = await getIssue(issueId);
      if (issue.assigneeAgentId) {
        await triggerAgentHeartbeat(issue.assigneeAgentId, {
          reason: "unblocked",
          issueId
        });
      }
    }
  }
}
```

---

## Scheduler Integration

When a task becomes unblocked, automatically trigger the assignee's heartbeat:

```typescript
// In scheduler or heartbeat service

async function checkUnblockedTasks() {
  // Find all blocked tasks
  const blockedTasks = await db
    .select()
    .from(issues)
    .where(eq(issues.status, "blocked"));
  
  for (const task of blockedTasks) {
    const { canProceed } = await checkBlockers(task.id);
    if (canProceed) {
      // Auto-unblock
      await updateStatus(task.id, "todo");
      
      // Trigger heartbeat if assigned
      if (task.assigneeAgentId) {
        await invokeHeartbeat(task.assigneeAgentId, {
          reason: "auto_unblocked",
          issueId: task.id
        });
      }
    }
  }
}

// Run every 5 minutes
setInterval(checkUnblockedTasks, 5 * 60 * 1000);
```

---

## Migration from Current System

### Export Current Dependencies

```bash
# From active-tasks.json
jq -r '.tasks[] | select(.blockedBy != null) | {id, blockedBy}' active-tasks.json
```

### Import to Paperclip

```typescript
// Migration script
const tasks = JSON.parse(fs.readFileSync('active-tasks.json'));
const dependencies = [];

for (const task of tasks.tasks) {
  if (task.blockedBy && task.blockedBy.length > 0) {
    for (const blockerId of task.blockedBy) {
      dependencies.push({
        issueId: task.id,
        blockedByIssueId: blockerId
      });
    }
  }
}

// Insert into Paperclip
for (const dep of dependencies) {
  await fetch('http://localhost:3100/api/issues/' + dep.issueId + '/dependencies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ blockedByIssueId: dep.blockedByIssueId })
  });
}
```

---

## UI Updates

### Issue Detail View

```
┌────────────────────────────────────────────────────────┐
│ Task: Implement user authentication                     │
│ Status: 🚫 BLOCKED                                     │
├────────────────────────────────────────────────────────┤
│ BLOCKED BY:                                            │
│  ┌──────────────────────────────────────────────────┐ │
│  │ ☐ Set up database schema (in_progress)           │ │
│  │ ☐ Create user model (todo)                       │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│ [Add Dependency] [Remove Blocker]                      │
└────────────────────────────────────────────────────────┘
```

### Task Board View

```
┌─────────────────────────────────────────────────────────┐
│                      TASK BOARD                          │
├─────────────────────────────────────────────────────────┤
│ BACKLOG  │  TODO   │ IN PROGRESS │ BLOCKED │ DONE       │
│          │         │             │         │            │
│          │ Task A  │ Task B      │ Task C  │ Task X     │
│          │         │             │ 🚫 blocked by Task D │
│          │         │ Task D      │         │ Task Y     │
│          │         │             │         │            │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Database Schema (Day 1)
- [ ] Create `issue_dependencies` table
- [ ] Add migration
- [ ] Add to schema exports

### Phase 2: Service Layer (Day 2)
- [ ] Add `checkBlockers()` function
- [ ] Add `addDependency()` function
- [ ] Add `removeDependency()` function
- [ ] Add `checkAndNotifyUnblockedTasks()` function

### Phase 3: API Routes (Day 2)
- [ ] `POST /api/issues/:id/dependencies`
- [ ] `DELETE /api/issues/:id/dependencies/:blockerId`
- [ ] `GET /api/issues/:id/dependencies`
- [ ] `GET /api/issues/:id/can-proceed`

### Phase 4: Checkout Integration (Day 3)
- [ ] Block checkout if dependencies not met
- [ ] Return 423 with list of pending blockers
- [ ] Auto-unblock on status change to "done"

### Phase 5: Scheduler Integration (Day 3)
- [ ] Add periodic check for unblocked tasks
- [ ] Auto-trigger heartbeats for unblocked tasks

### Phase 6: UI Updates (Day 4)
- [ ] Show blockers in issue detail
- [ ] Add "Add Dependency" button
- [ ] Show blocked count in board view

### Phase 7: Migration (Day 5)
- [ ] Export from `active-tasks.json`
- [ ] Import to Paperclip
- [ ] Verify all dependencies migrated

---

## Testing

```typescript
describe('Issue Dependencies', () => {
  it('should block checkout if dependencies not met', async () => {
    // Create task A (blocker)
    const taskA = await createIssue({ title: 'Task A' });
    
    // Create task B (blocked by A)
    const taskB = await createIssue({ title: 'Task B' });
    await addDependency(taskB.id, taskA.id);
    
    // Try to checkout task B
    const result = await checkout(taskB.id, agentId);
    expect(result.status).toBe(423);
    expect(result.body.error).toContain('blocked by');
  });
  
  it('should auto-unblock when blocker is done', async () => {
    // Create dependency chain
    const taskA = await createIssue({ title: 'Task A' });
    const taskB = await createIssue({ title: 'Task B', status: 'blocked' });
    await addDependency(taskB.id, taskA.id);
    
    // Complete task A
    await updateStatus(taskA.id, 'done');
    
    // Task B should auto-unblock
    const updated = await getIssue(taskB.id);
    expect(updated.status).toBe('todo');
  });
});
```

---

## Open Questions

1. **Circular dependency detection?**
   - Need to prevent A blocks B, B blocks A
   - Add validation in `addDependency()`

2. **Max dependency depth?**
   - Prevent infinite chains
   - Limit to 10 levels deep?

3. **Dependency visualization?**
   - DAG view in UI?
   - Critical path highlighting?

4. **Bulk dependency operations?**
   - Add multiple dependencies at once?
   - Batch import during migration?
